/**
 * Stage 2 of study guide generation: write ONE piece's theory (#1004).
 *
 * Called per piece, on demand, so each request stays short. The instructor then
 * edits the result freely before any questions exist — which is why theory and
 * questions are separate stages rather than one call.
 *
 * Deliberately does NOT touch the piece's questions. Rewriting theory under
 * existing questions would leave them testing text the student no longer reads;
 * the UI warns and the instructor regenerates the questions as a second step.
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
  loadPieceContext,
  markCurrentPiece,
} from "../_shared/study-guide-context.ts";
import {
  STUDY_GUIDE_MAX_POLL_MS,
  THEORY_OUTPUT_SCHEMA,
} from "../_shared/study-guide-generation.ts";
import {
  STUDY_GUIDE_THEORY_SYSTEM_PROMPT,
  STUDY_GUIDE_THEORY_USER_PROMPT,
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

interface TheoryResult {
  theory_html: string;
}

/** Matches the textarea's maxLength; anything bigger is not an instruction. */
const MAX_SPECIAL_INSTRUCTIONS_CHARS = 2000;

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Server misconfigured" }, 500);
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
  const pieceId = typeof body.pieceId === "string" ? body.pieceId.trim() : "";
  const scope = typeof body.scope === "string" ? body.scope.trim() : "";
  const specialInstructions =
    typeof body.specialInstructions === "string" ? body.specialInstructions.trim() : "";
  if (!pieceId) return jsonResponse({ error: "pieceId is required" }, 400);
  if (specialInstructions.length > MAX_SPECIAL_INSTRUCTIONS_CHARS) {
    return jsonResponse(
      { error: `specialInstructions must be at most ${MAX_SPECIAL_INSTRUCTIONS_CHARS} characters` },
      400,
    );
  }

  try {
    const pieceCtx = await loadPieceContext(supabase, pieceId);
    const context = await loadGuideContext(supabase, pieceCtx.piece.study_guide_id);

    const auth = await isAuthorizedCourseManager(supabase, user.id, context.guide.course_id);
    if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

    const userMessage = render(STUDY_GUIDE_THEORY_USER_PROMPT, {
      course_title: context.courseTitle,
      material_title: context.materialTitle,
      chapter_list: context.chapterList,
      lang: context.language,
      outline_summary: markCurrentPiece(pieceCtx.outlineSummary, pieceCtx.piece.position),
      piece_position: String(pieceCtx.piece.position + 1),
      piece_total: String(pieceCtx.pieceTotal),
      piece_title: pieceCtx.piece.title,
      // The outline's scope is not stored on the piece — only the title is — so
      // the client passes it back when it has it, and otherwise the title plus
      // the surrounding sequence is what a human would work from.
      piece_scope: scope ||
        `Teach exactly what the title "${pieceCtx.piece.title}" promises, and nothing owned by the pieces around it.`,
      brief: context.guide.brief || "(no brief supplied)",
      special_instructions: specialInstructions
        ? "\nThe instructor gave these special instructions for writing this piece's theory. Follow them, while staying grounded in the material and inside this piece's scope.\nInstructions: " +
          specialInstructions + "\n"
        : "",
    });

    const result = await callOpenAIStructured<TheoryResult>({
      ...modelFor("study-guide.theory"),
      promptText: STUDY_GUIDE_THEORY_SYSTEM_PROMPT,
      variables: {},
      input: [{ role: "user", content: userMessage }],
      fileIds: context.fileIds,
      structuredOutput: THEORY_OUTPUT_SCHEMA,
      backgroundOptions: { enabled: true, maxPollTimeMs: STUDY_GUIDE_MAX_POLL_MS },
      usageContext: createUsageContext("generate-study-guide-theory", {
        promptKey: "study_guide_theory",
        institutionId: context.institutionId,
        courseId: context.guide.course_id,
      }),
    });

    const theory = typeof result?.theory_html === "string" ? result.theory_html.trim() : "";
    if (theory.length === 0) {
      return jsonResponse({ error: "The model returned empty theory" }, 502);
    }

    const { error: updateError } = await supabase
      .from("study_guide_pieces")
      .update({ theory_html: theory })
      .eq("id", pieceId);
    if (updateError) {
      return jsonResponse({ error: `Could not save the theory: ${updateError.message}` }, 500);
    }

    logger.info("generate-study-guide-theory: theory written", {
      pieceId,
      studyGuideId: pieceCtx.piece.study_guide_id,
      chars: theory.length,
    });

    return jsonResponse({ success: true, theoryHtml: theory }, 200);
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
    logger.exception("generate-study-guide-theory failed", err, { pieceId });
    return jsonResponse({ error: message }, 500);
  }
};
