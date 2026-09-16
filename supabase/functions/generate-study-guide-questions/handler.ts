/**
 * Stage 3 of study guide generation: write ONE piece's questions (#1004).
 *
 * Grounded in the STORED theory, not the source PDF. The instructor may have
 * rewritten the theory after it was drafted, and a question testing the
 * original text would then contradict what the student actually reads. The
 * chapters stay attached for terminology and notation, but the prompt states
 * plainly that the theory wins.
 *
 * Refuses when the piece has no theory yet: questions about nothing are not
 * useful, and it is the clearest possible signal that stage 2 was skipped.
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
} from "../_shared/study-guide-context.ts";
import {
  MAX_QUESTIONS_PER_PIECE,
  QUESTIONS_OUTPUT_SCHEMA,
  STUDY_GUIDE_MAX_POLL_MS,
} from "../_shared/study-guide-generation.ts";
import {
  STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT,
  STUDY_GUIDE_QUESTIONS_USER_PROMPT,
} from "../_shared/prompts/study-guide-generation.ts";
import {
  toStudyGuideQuestionRow,
  type RawStudyGuideQuestion,
  type StudyGuideQuestionRow,
} from "../_shared/study-guide-questions.ts";
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

interface QuestionsResult {
  questions: RawStudyGuideQuestion[];
}

/**
 * What the instructor may pin. "mixed" preserves the original behaviour of
 * letting the model choose, and is the default when the field is omitted.
 */
const ALLOWED_TYPE_CHOICES = new Set([
  "mixed",
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);
const ALLOWED_DIFFICULTY_CHOICES = new Set(["mixed", "easy", "medium", "hard"]);

const TYPE_LABELS: Record<string, string> = {
  mcq: "multiple choice",
  open: "open answer",
  fill_gaps: "fill in the gaps",
  ordering: "ordering",
  classification: "classification",
};

/** Strips tags so the model reads the prose it is writing questions about. */
function theoryAsText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
  if (!pieceId) return jsonResponse({ error: "pieceId is required" }, 400);

  // Instructor-chosen shape (#1006). All optional: omitting them keeps the
  // previous behaviour of letting the model choose the mix.
  const requestedType = typeof body.questionType === "string" ? body.questionType : "mixed";
  if (!ALLOWED_TYPE_CHOICES.has(requestedType)) {
    return jsonResponse({ error: `Unsupported question type: ${requestedType}` }, 400);
  }
  const requestedDifficulty =
    typeof body.difficulty === "string" ? body.difficulty : "mixed";
  if (!ALLOWED_DIFFICULTY_CHOICES.has(requestedDifficulty)) {
    return jsonResponse({ error: `Unsupported difficulty: ${requestedDifficulty}` }, 400);
  }
  const requestedCount = typeof body.count === "number" && Number.isFinite(body.count)
    ? Math.min(MAX_QUESTIONS_PER_PIECE, Math.max(1, Math.floor(body.count)))
    : null;

  try {
    const pieceCtx = await loadPieceContext(supabase, pieceId);
    const context = await loadGuideContext(supabase, pieceCtx.piece.study_guide_id);

    const auth = await isAuthorizedCourseManager(supabase, user.id, context.guide.course_id);
    if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

    const theoryHtml = pieceCtx.piece.theory_html ?? "";
    const theoryText = theoryAsText(theoryHtml);
    if (theoryText.length < 50) {
      return jsonResponse(
        { error: "Write the theory for this piece first — questions are based on it." },
        409,
      );
    }

    const { data: competencies } = await supabase
      .from("course_competencies")
      .select("id, title")
      .eq("course_id", context.guide.course_id);
    const competencyRows = (competencies ?? []) as Array<{ id: string; title: string }>;
    const validCompetencyIds = new Set(competencyRows.map((c) => c.id));

    const userMessage = render(STUDY_GUIDE_QUESTIONS_USER_PROMPT, {
      course_title: context.courseTitle,
      material_title: context.materialTitle,
      chapter_list: context.chapterList,
      lang: context.language,
      competency_list: competencyRows.length > 0
        ? competencyRows.map((c) => `  ${c.id} — ${c.title}`).join("\n")
        : "  (none defined for this course)",
      piece_position: String(pieceCtx.piece.position + 1),
      piece_total: String(pieceCtx.pieceTotal),
      piece_title: pieceCtx.piece.title,
      target_question_count: String(
        requestedCount ??
          Math.min(MAX_QUESTIONS_PER_PIECE, Math.max(1, context.guide.target_questions_per_piece)),
      ),
      type_instruction: requestedType === "mixed"
        ? "Question types: your choice — vary them to suit what each question checks."
        : `Question type: EVERY question must be ${TYPE_LABELS[requestedType]} ("${requestedType}"). Do not produce any other type.`,
      difficulty_instruction: requestedDifficulty === "mixed"
        ? "Difficulty: your choice — mostly medium, a couple easy, at most one or two hard."
        : `Difficulty: EVERY question must be "${requestedDifficulty}".`,
      piece_theory: theoryText,
    });

    const result = await callOpenAIStructured<QuestionsResult>({
      ...modelFor("study-guide.questions"),
      promptText: STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT,
      variables: {},
      input: [{ role: "user", content: userMessage }],
      fileIds: context.fileIds,
      structuredOutput: QUESTIONS_OUTPUT_SCHEMA,
      backgroundOptions: { enabled: true, maxPollTimeMs: STUDY_GUIDE_MAX_POLL_MS },
      usageContext: createUsageContext("generate-study-guide-questions", {
        promptKey: "study_guide_questions",
        institutionId: context.institutionId,
        courseId: context.guide.course_id,
      }),
    });

    // Convert and validate before writing anything. A malformed question is
    // dropped with a reason rather than written half-formed: students can
    // answer it the moment the guide is assigned, and answers are immutable.
    const chapterIds = context.chapters.map((c) => c.id);
    const raw = Array.isArray(result?.questions) ? result.questions : [];
    const rows: StudyGuideQuestionRow[] = [];
    const rejected: Array<{ index: number; error: string }> = [];

    // How many to keep. Computed before the scan because it is what bounds it.
    const wanted = requestedCount ??
      Math.min(MAX_QUESTIONS_PER_PIECE, Math.max(1, context.guide.target_questions_per_piece));

    // The bound is on ACCEPTED questions, not on position in the raw array.
    // Truncating the raw output first — at the requested count, or at
    // MAX_QUESTIONS_PER_PIECE — let malformed or off-shape entries near the
    // front consume the whole budget, so the handler wrote a short batch or
    // 502'd on an empty one while usable questions sat unexamined behind them.
    // Scanning stops the moment enough have been accepted, so the extra work is
    // paid only when something was actually rejected.
    for (const [index, q] of raw.entries()) {
      if (rows.length >= wanted) break;
      const converted = toStudyGuideQuestionRow(q, validCompetencyIds, chapterIds);
      if (!converted.ok) {
        rejected.push({ index, error: converted.error });
        continue;
      }
      // Enforce BOTH pinned fields rather than trusting the prompt: a question
      // of the wrong type or difficulty is not what the instructor asked for,
      // and silently keeping it would make the control advisory.
      //
      // Difficulty is rejected rather than coerced to the pinned value on
      // purpose. Relabelling an easy question "hard" would write a false
      // difficulty into the row, and difficulty feeds the analytics that tell
      // an instructor how a class is doing — a quiet lie there is worse than a
      // visibly short batch, which the caller reports with its reasons.
      if (requestedType !== "mixed" && converted.row.type !== requestedType) {
        rejected.push({
          index,
          error: `expected type ${requestedType}, model returned ${converted.row.type}`,
        });
        continue;
      }
      if (requestedDifficulty !== "mixed" && converted.row.difficulty !== requestedDifficulty) {
        rejected.push({
          index,
          error: `expected difficulty ${requestedDifficulty}, model returned ${converted.row.difficulty}`,
        });
        continue;
      }
      rows.push(converted.row);
    }

    if (rows.length === 0) {
      return jsonResponse(
        {
          error: `The model produced no usable questions (${rejected.length} rejected)`,
          rejected: rejected.slice(0, 5),
        },
        502,
      );
    }

    // One atomic call: questions, their junctions and the piece links commit
    // together, and the piece's previous questions are replaced rather than
    // added to. It also refuses when a student has already answered this piece.
    const { data: insertedIds, error: writeError } = await supabase.rpc(
      "replace_study_guide_piece_questions",
      {
        _piece_id: pieceId,
        _course_id: context.guide.course_id,
        _created_by: user.id,
        _questions: rows,
      },
    );
    if (writeError) {
      // The submissions guard raises here; surface it as a conflict, not a 500.
      const conflict = /submission/i.test(writeError.message);
      return jsonResponse({ error: writeError.message }, conflict ? 409 : 500);
    }

    const questionIds = (insertedIds ?? []) as string[];
    logger.info("generate-study-guide-questions: questions written", {
      pieceId,
      generated: raw.length,
      inserted: questionIds.length,
      rejected: rejected.length,
    });

    return jsonResponse(
      {
        success: true,
        inserted: questionIds.length,
        generated: raw.length,
        rejected: rejected.length,
        rejectedDetail: rejected.slice(0, 5),
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
    logger.exception("generate-study-guide-questions failed", err, { pieceId });
    return jsonResponse({ error: message }, 500);
  }
};
