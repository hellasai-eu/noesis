// NOTE: this function grades the three "non-essay" question types in one
// place. Ordering and classification stay strictly deterministic. fill_gaps
// is exact-first with an LLM safety net (#784) — a synonym/misspelling/typo
// that the deterministic matcher rejects can be upgraded by a cheap mini
// model. On any LLM error the exact-match grade stands.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  classificationAssignmentsFromAnswerKey,
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsStemFromPayload,
  orderingItemsFromPayload,
} from "../_shared/question-payload.ts";
import { gradeFillGaps } from "../_shared/grade-fill-gaps.ts";
import { gradeOrdering } from "../_shared/grade-ordering.ts";
import { gradeClassification } from "../_shared/grade-classification.ts";
import { judgeFillGapsWithLLM } from "../_shared/llm-judge-fill-gaps.ts";
import { verifyQuestionEnrollment } from "../_shared/verify-question-enrollment.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";
// Shared with `submit-quiz-answers`, so the two graders that record a student
// answer hand back the same review payload (#1011).
import { buildReveal } from "../_shared/question-reveal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type DeterministicType = "fill_gaps" | "ordering" | "classification";

interface RequestBody {
  questionId?: unknown;
  courseId?: unknown;
  questionType?: unknown;
  submittedAnswer?: unknown;
  hintsUsed?: unknown;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isDeterministicType(t: unknown): t is DeterministicType {
  return t === "fill_gaps" || t === "ordering" || t === "classification";
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const { questionId, courseId, questionType, submittedAnswer } = body;

    if (typeof questionId !== "string" || typeof courseId !== "string") {
      return jsonResponse(400, { error: "Missing required parameters" });
    }
    if (!isDeterministicType(questionType)) {
      return jsonResponse(400, { error: "Invalid questionType" });
    }

    logger.setContext({ courseId });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // JWT-derived caller — never trust a user_id from the body.
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    if (!token) {
      return jsonResponse(401, { error: "Missing authorization" });
    }

    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user?.id) {
      return jsonResponse(401, { error: "Invalid authorization" });
    }
    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return jsonResponse(403, { error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE });
    }
    const userId = user.id;

    const enrollment = await verifyQuestionEnrollment(supabase, { questionId, userId });
    if (!enrollment.ok) {
      return jsonResponse(enrollment.status, { error: enrollment.error });
    }
    const offeringId = enrollment.offeringId;

    // Load the question and confirm its declared type matches the request.
    const { data: question, error: questionError } = await supabase
      .from("questions")
      .select("type, payload, answer_key, explanation, course_id")
      .eq("id", questionId)
      .single();

    if (questionError || !question) {
      logger.error("Question fetch failed", { error: questionError?.message, questionId });
      return jsonResponse(404, { error: "Question not found" });
    }

    if (question.type !== questionType) {
      return jsonResponse(400, { error: "Question type mismatch" });
    }

    // One-shot guard — the deterministic types allow exactly one submission.
    const { data: existingGrade } = await supabase
      .from("open_question_grades")
      .select("id")
      .eq("open_question_id", questionId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingGrade) {
      return jsonResponse(409, {
        error: "already_submitted",
        message: "You have already submitted an answer for this question.",
      });
    }

    // Recompute the grade SERVER-SIDE from the answer_key — never trust a
    // grade or correctness blob supplied by the client. The submittedAnswer
    // is the only thing we accept from the wire.
    let grade = 0;
    let gapResults: Record<string, unknown> = {};
    let submittedAnswerText = "";

    if (questionType === "fill_gaps") {
      if (!Array.isArray(submittedAnswer)) {
        return jsonResponse(400, { error: "submittedAnswer must be an array of strings" });
      }
      const inputs = submittedAnswer.map((v) => (typeof v === "string" ? v : ""));
      const gapsForKey = fillGapsAcceptableAnswersFromAnswerKey(question.answer_key);
      const acceptable = gapsForKey.map((g) => g.acceptable);
      if (acceptable.length === 0) {
        return jsonResponse(500, { error: "Question has no answer key" });
      }
      const exact = gradeFillGaps(inputs, acceptable);
      const judged = await judgeFillGapsWithLLM({
        stem: fillGapsStemFromPayload(question.payload),
        gaps: gapsForKey,
        submitted: inputs,
        exactPerGap: exact.perGap,
        usageContext: createUsageContext("grade-deterministic-answer", {
          promptKey: "fill_gaps_equivalence_judge",
          courseId: question.course_id,
          userId,
        }),
      });
      const perGap = judged.perGap;
      const allCorrect = perGap.length > 0 && perGap.every(Boolean);
      const correctCount = perGap.filter(Boolean).length;
      const totalCount = perGap.length;
      grade = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
      gapResults = {
        perGap,
        allCorrect,
        llmCallMade: judged.llmCallMade,
        llmFailed: judged.llmFailed,
      };
      submittedAnswerText = JSON.stringify(inputs);
    } else if (questionType === "ordering") {
      if (!Array.isArray(submittedAnswer)) {
        return jsonResponse(400, { error: "submittedAnswer must be an array of strings" });
      }
      const order = submittedAnswer.map((v) => (typeof v === "string" ? v : ""));
      const canonical = orderingItemsFromPayload(question.payload);
      if (canonical.length === 0) {
        return jsonResponse(500, { error: "Question has no answer key" });
      }
      const result = gradeOrdering(order, canonical);
      const correctCount = result.perPosition.filter(Boolean).length;
      const totalCount = result.perPosition.length;
      grade = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
      gapResults = { perPosition: result.perPosition, allCorrect: result.allCorrect };
      submittedAnswerText = JSON.stringify(order);
    } else {
      // classification
      if (
        !submittedAnswer ||
        typeof submittedAnswer !== "object" ||
        Array.isArray(submittedAnswer)
      ) {
        return jsonResponse(400, { error: "submittedAnswer must be an object" });
      }
      const submitted: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(submittedAnswer as Record<string, unknown>)) {
        submitted[k] = typeof v === "string" ? v : null;
      }
      const canonical = classificationAssignmentsFromAnswerKey(question.answer_key);
      if (Object.keys(canonical).length === 0) {
        return jsonResponse(500, { error: "Question has no answer key" });
      }
      const result = gradeClassification(submitted, canonical);
      grade = result.totalCount > 0
        ? Math.round((result.correctCount / result.totalCount) * 100)
        : 0;
      // Hints used is reported by the renderer — it's purely metadata for
      // the review surface and doesn't affect the grade.
      const hintsUsed = typeof body.hintsUsed === "number" && body.hintsUsed >= 0
        ? Math.floor(body.hintsUsed)
        : 0;
      gapResults = {
        perItem: result.perItem,
        allCorrect: result.allCorrect,
        hintsUsed,
      };
      submittedAnswerText = JSON.stringify(submitted);
    }

    const { error: gradeError } = await supabase
      .from("open_question_grades")
      .insert({
        open_question_id: questionId,
        user_id: userId,
        course_id: question.course_id,
        offering_id: offeringId,
        grade,
        submitted_answer: submittedAnswerText,
        gap_results: gapResults,
        graded_at: new Date().toISOString(),
      });

    if (gradeError) {
      // Race with another in-flight submit — the UNIQUE(question, user)
      // index rejects the second one. Treat it as already-submitted.
      if (gradeError.code === "23505") {
        return jsonResponse(409, {
          error: "already_submitted",
          message: "You have already submitted an answer for this question.",
        });
      }
      logger.error("Failed to insert grade", { error: gradeError.message });
      return jsonResponse(500, { error: "Failed to store grade" });
    }

    const { error: progressError } = await supabase
      .from("chat_sessions")
      .upsert(
        {
          open_question_id: questionId,
          user_id: userId,
          course_id: question.course_id,
          offering_id: offeringId,
          status: "completed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,open_question_id" },
      );

    if (progressError) {
      logger.error("Failed to upsert progress to completed", { error: progressError.message });
    }

    return jsonResponse(200, {
      success: true,
      grade,
      gapResults,
      // The key material for the answer now on record (#1011). The practice
      // panels no longer fetch `answer_key` with the question — it used to
      // arrive with a whole course's worth of questions, before the student
      // opened any of them — so this is what makes the review renderable.
      //
      // Unconditional here, unlike `submit-quiz-answers`: practice is a
      // self-serve drill with no attempt to protect and nothing to release,
      // and these three surfaces are practice-only. The gate that matters —
      // an answer actually on record — is the write above, which this line
      // is only reached after.
      reveal: buildReveal(question),
    });
  } catch (error) {
    logger.exception(error as Error, "grade-deterministic-answer error");
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
