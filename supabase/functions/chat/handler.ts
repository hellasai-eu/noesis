/**
 * The one tutoring endpoint.
 *
 * Replaces `study-tutor` and `socratic-chat`, which ran the same turn twice
 * over mirrored tables. This handler picks a `ChatSubject` by `kind` and hands
 * the turn to `runChatTurn`; everything else is shared.
 *
 * Authorization (see `AUTHORIZATION.md`): `verify_jwt = false` and a
 * service-role client mean the gateway authenticates nothing, so the check
 * inside `runChatTurn` is the only boundary. It resolves the caller from the
 * bearer token and authorises that identity against the subject — never an id
 * taken from the request body.
 */

import { logger } from "../_shared/logger.ts";
import { corsHeaders, runChatTurn, type SubjectKind } from "../_shared/chat-turn.ts";
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

  // The body is read twice — once here to route, once inside `runChatTurn`.
  // Cloning is cheaper than threading a parsed body through the shared
  // signature, and keeps `runChatTurn` usable on its own in tests.
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
    return await runChatTurn(req, SUBJECTS[kind]);
  } catch (error) {
    // A 403 from OpenAI is its moderation refusing the request outright.
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

    logger.exception(error as Error, "Chat turn error");
    return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
};
