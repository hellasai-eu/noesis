/**
 * Stage 1 of study guide generation: decide how the material breaks into
 * pieces (#1004).
 *
 * Titles and scope only — no theory, no questions. That keeps this call short
 * enough to answer inside a single request, and lets the instructor correct the
 * structure before paying for any writing.
 *
 * Replaces the outline half of the deleted `study_guide_generation` job. The
 * generation flow is now instructor-driven: this, then a theory call per piece,
 * then a questions call per piece.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { callOpenAIStructured, OpenAIRateLimitError } from "../_shared/openai-client.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { modelFor } from "../_shared/model-policy.ts";
import { render } from "../_shared/render.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  isAuthorizedCourseManager,
  loadGuideContext,
} from "../_shared/study-guide-context.ts";
import {
  MAX_PIECES,
  OUTLINE_OUTPUT_SCHEMA,
  STUDY_GUIDE_MAX_POLL_MS,
} from "../_shared/study-guide-generation.ts";
import {
  STUDY_GUIDE_OUTLINE_SYSTEM_PROMPT,
  STUDY_GUIDE_OUTLINE_USER_PROMPT,
} from "../_shared/prompts/study-guide-generation.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface OutlineResult {
  pieces: Array<{ title: string; scope: string; chapter_hint: number | null }>;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse({ error: "Server misconfigured" }, 500);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ error: "Missing authorization" }, 401);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user?.id) return jsonResponse({ error: "Invalid authorization" }, 401);
  // Service-role client, so RLS's aal2 enforcement never runs here — refuse
  // an MFA-enrolled caller whose token is still aal1.
  if (!callerMfaSatisfied(user, token)) {
    return jsonResponse({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Body must be JSON" }, 400);
  }
  const studyGuideId = typeof body.studyGuideId === "string" ? body.studyGuideId.trim() : "";
  if (!studyGuideId) return jsonResponse({ error: "studyGuideId is required" }, 400);

  try {
    const context = await loadGuideContext(supabase, studyGuideId);

    // Course comes from the guide, never the request body.
    const auth = await isAuthorizedCourseManager(supabase, user.id, context.guide.course_id);
    if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

    const userMessage = render(STUDY_GUIDE_OUTLINE_USER_PROMPT, {
      course_title: context.courseTitle,
      material_title: context.materialTitle,
      chapter_list: context.chapterList,
      lang: context.language,
      target_piece_count: String(context.guide.target_piece_count),
      brief: context.guide.brief || "(no brief supplied)",
    });

    const outline = await callOpenAIStructured<OutlineResult>({
      ...modelFor("study-guide.outline"),
      promptText: STUDY_GUIDE_OUTLINE_SYSTEM_PROMPT,
      variables: {},
      input: [{ role: "user", content: userMessage }],
      fileIds: context.fileIds,
      structuredOutput: OUTLINE_OUTPUT_SCHEMA,
      backgroundOptions: { enabled: true, maxPollTimeMs: STUDY_GUIDE_MAX_POLL_MS },
      usageContext: createUsageContext("generate-study-guide-outline", {
        promptKey: "study_guide_outline",
        institutionId: context.institutionId,
        courseId: context.guide.course_id,
      }),
    });

    const pieces = (Array.isArray(outline?.pieces) ? outline.pieces : [])
      .filter((p) => typeof p?.title === "string" && p.title.trim().length > 0)
      .slice(0, MAX_PIECES);
    if (pieces.length === 0) {
      return jsonResponse({ error: "The model returned no usable pieces" }, 502);
    }

    // Replace only now that there IS a replacement. Clearing first and then
    // calling the model meant any failure — the call, validation, the insert —
    // left the guide permanently empty, discarding authored content.
    //
    // The RPC does the delete and the insert in one transaction, which also
    // removes the need for a rebuild mutex: two concurrent rebuilds serialize
    // on the guide row rather than both clearing and then colliding on
    // UNIQUE (study_guide_id, position). Last writer wins; the only cost is a
    // duplicated model call, which is inherent to two people clicking at once.
    // It refuses outright when a student has already answered.
    const { data: inserted, error: replaceError } = await supabase.rpc(
      "replace_study_guide_outline",
      {
        _study_guide_id: studyGuideId,
        _pieces: pieces.map((p) => ({ title: p.title.trim() })),
      },
    );
    if (replaceError) {
      const conflict = /submission/i.test(replaceError.message);
      return jsonResponse({ error: replaceError.message }, conflict ? 409 : 500);
    }

    logger.info("generate-study-guide-outline: outline written", {
      studyGuideId,
      pieces: pieces.length,
    });

    return jsonResponse(
      {
        success: true,
        pieces: ((inserted ?? []) as Array<Record<string, unknown>>).map((row, i) => ({
          ...row,
          // The outline's scope is not stored — only the title is — so it is
          // returned here for the theory step to pass back while the tab lives.
          scope: pieces[i]?.scope ?? "",
        })),
      },
      200,
    );
  } catch (err) {
    // The school switched this AI family off (ai-feature-gate) — a policy
    // refusal, not a failure. Must precede the OpenAIError mapping below
    // (it is a subclass) so it cannot surface as a 5xx.
    if (err instanceof AiFeatureDisabledError) {
      return new Response(JSON.stringify({ error: err.message, code: "ai_feature_disabled" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (err instanceof OpenAIRateLimitError) {
      return jsonResponse({ error: "Rate limit exceeded — try again shortly" }, 429);
    }
    const message = (err as Error).message ?? String(err);
    logger.exception("generate-study-guide-outline failed", err, { studyGuideId });
    return jsonResponse({ error: message }, 500);
  }
};
