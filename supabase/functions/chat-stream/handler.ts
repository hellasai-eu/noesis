/**
 * The streaming tutoring endpoint — an opt-in alternative to `chat`.
 *
 * Same tables, same `ChatSubject` descriptors, same gates. What differs is the
 * transport: the reply streams as the model produces it, which means the
 * output-moderation gate can no longer withhold a flagged reply the way `chat`
 * does (#1198). See `runStreamingChatTurn` for what that trades away.
 *
 * Authorization (see `AUTHORIZATION.md`): `verify_jwt = false` and a
 * service-role client mean the gateway authenticates nothing, so the check
 * inside `prepareTurn` is the only boundary — shared with `chat`, so the two
 * endpoints cannot drift apart on who is allowed to take a turn.
 */

import { logger } from "../_shared/logger.ts";
import { corsHeaders, runStreamingChatTurn, type SubjectKind } from "../_shared/chat-turn.ts";
import { openQuestionSubject } from "../_shared/chat-subjects/open-question.ts";
import { studySessionSubject } from "../_shared/chat-subjects/study-session.ts";
import {
  OpenAIError,
  OpenAIPaymentRequiredError,
  OpenAIRateLimitError,
} from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";

// deno-lint-ignore no-explicit-any
const SUBJECTS: Record<SubjectKind, any> = {
  open_question: openQuestionSubject,
  study_session: studySessionSubject,
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let kind: SubjectKind | undefined;
  try {
    ({ kind } = await req.clone().json());
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!kind || !(kind in SUBJECTS)) {
    return json({ error: "Unknown chat subject" }, 400);
  }

  try {
    return await runStreamingChatTurn(req, SUBJECTS[kind]);
  } catch (error) {
    if (error instanceof OpenAIError && error.statusCode === 403) {
      return json(
        {
          error: "content_blocked",
          message:
            "Content has been flagged by our content moderation system and will be reviewed by a moderator. This session has been paused until review is complete.",
          flaggedOffensive: true,
          flagged: true,
        },
        200,
      );
    }
    // The school switched this AI family off (ai-feature-gate) — a policy
    // refusal, not a failure. Must precede the OpenAIError mapping below
    // (it is a subclass) so it cannot surface as a 5xx.
    if (error instanceof AiFeatureDisabledError) {
      return new Response(JSON.stringify({ error: error.message, code: "ai_feature_disabled" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (error instanceof OpenAIRateLimitError) {
      return json({ error: "Rate limit exceeded, please try again later." }, 429);
    }
    if (error instanceof OpenAIPaymentRequiredError) {
      return json({ error: "AI credits exhausted. Please contact support." }, 402);
    }

    logger.exception(error as Error, "Streaming chat turn error");
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
};
