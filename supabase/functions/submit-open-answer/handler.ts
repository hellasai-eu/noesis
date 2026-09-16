// Record a single-mode open answer for instructor review (replaces the
// retired grade-open-answer function — the AI no longer assigns grades).
//
// The quiz model, applied to the practice surface: the submission is recorded
// ungraded (`open_question_grades` with grade/feedback NULL) and held for the
// instructor, who grades it manually. The model still reads the answer and
// writes a QUALITATIVE draft (feedback, strengths, areas for improvement — no
// number) into `open_answer_ai_drafts`, a manager-only table the student
// cannot read. The draft is best-effort: recording the submission must never
// depend on OpenAI being up or the school's grading toggle being on.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { draftOpenAnswerReview } from "../_shared/open-answer-review-draft.ts";
import {
  openAnsweringModeFromPayload,
  openExplanationFromAnswerKey,
  openModelAnswerFromAnswerKey,
  openRubricFromAnswerKey,
} from "../_shared/question-payload.ts";
import { verifyQuestionEnrollment } from "../_shared/verify-question-enrollment.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Hard ceiling on the raw submission so a runaway paste can't blow up the
// review surface (and, downstream, the draft prompt). Matches the per-turn
// limit the tutoring turn enforces (`_shared/chat-turn.ts`).
const ANSWER_CHAR_LIMIT = 4000;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // `courseId` in the body is accepted for the client contract but never
    // trusted — the governing course is resolved from the question below.
    const { questionId, courseId: requestedCourseId, studentAnswer } = await req.json();

    if (!questionId || !requestedCourseId || typeof studentAnswer !== "string") {
      return jsonResponse(400, { error: "Missing required parameters" });
    }

    const trimmedAnswer = studentAnswer.trim();
    if (!trimmedAnswer) {
      return jsonResponse(400, { error: "Empty answer" });
    }

    if (trimmedAnswer.length > ANSWER_CHAR_LIMIT) {
      return jsonResponse(400, {
        error: "answer_too_long",
        message: `Your answer is too long (${trimmedAnswer.length} characters). Please shorten it to ${ANSWER_CHAR_LIMIT} characters or less.`,
        maxLength: ANSWER_CHAR_LIMIT,
      });
    }

    logger.setContext({ courseId: requestedCourseId });

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

    // Load the question (unified `questions` table, type='open').
    const { data: question, error: questionError } = await supabase
      .from("questions")
      .select("question, answer_key, payload, course_id")
      .eq("id", questionId)
      .eq("type", "open")
      .single();

    if (questionError || !question) {
      logger.error("Question fetch failed", { error: questionError?.message, questionId });
      return jsonResponse(404, { error: "Question not found" });
    }

    // Authorize and store against the question's own course, never an id
    // from the request body — the same rule every privileged handler follows
    // (#1135). A client naming another course changes nothing.
    const courseId = question.course_id as string;
    logger.setContext({ courseId });

    // Guard against submitting interactive-mode questions through this
    // surface — the Socratic path is the only legitimate writer there.
    const answeringMode = openAnsweringModeFromPayload(question.payload);
    if (answeringMode !== "single") {
      return jsonResponse(400, {
        error: "wrong_mode",
        message: "This question is in interactive mode; use the Socratic chat instead.",
      });
    }

    // NO CONTENT MODERATION HERE, deliberately (#1040) — the decision made
    // for the grader carries over unchanged: a one-shot answer to a set
    // question is coursework read only by its author and their instructor.

    // Record the submission ungraded. `grade`/`feedback` stay NULL until the
    // instructor writes them; the row's existence is the one-shot guard and
    // the completion signal. (`graded_at` keeps its column default — it is
    // meaningful only once `grade` is set.)
    const { error: insertError } = await supabase
      .from("open_question_grades")
      .insert({
        open_question_id: questionId,
        user_id: userId,
        course_id: courseId,
        offering_id: offeringId,
        submitted_answer: trimmedAnswer,
      });

    if (insertError) {
      // Duplicate submit — the unique (question, user) index rejects the
      // second one, racing or not. Treat it as already-submitted.
      if (insertError.code === "23505") {
        return jsonResponse(409, {
          error: "already_submitted",
          message: "You have already submitted an answer for this question.",
        });
      }
      logger.error("Failed to record submission", { error: insertError.message });
      return jsonResponse(500, { error: "Failed to record submission" });
    }

    // Single-mode questions have no chat turn, so this upsert is the only
    // thing that ever creates the completion signal the student UI reads.
    const { error: progressError } = await supabase
      .from("chat_sessions")
      .upsert(
        {
          open_question_id: questionId,
          user_id: userId,
          course_id: courseId,
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

    // Best-effort review draft for the instructor, generated AFTER the
    // response goes out — the student is not waiting for anything the draft
    // contains. Every failure path is swallowed here: the submission is
    // already recorded, so the instructor just reviews without a draft.
    const modelAnswer = openModelAnswerFromAnswerKey(question.answer_key);
    if (modelAnswer) {
      const work = (async () => {
        const effectiveLanguage = await getEffectiveLanguage(supabase, courseId);
        const langInfo = getLanguageInstruction(effectiveLanguage);

        const endAiTimer = logger.startTimer("ai-draft-open-answer-review");
        const draft = await draftOpenAnswerReview({
          languageName: langInfo.name,
          question: question.question,
          modelAnswer,
          rubric: openRubricFromAnswerKey(question.answer_key),
          explanation: openExplanationFromAnswerKey(question.answer_key),
          studentAnswer: trimmedAnswer,
          usageContext: createUsageContext("submit-open-answer", {
            promptKey: "grading",
            courseId,
            userId,
          }),
        });
        endAiTimer();

        const { error: draftError } = await supabase
          .from("open_answer_ai_drafts")
          .insert({
            question_id: questionId,
            user_id: userId,
            course_id: courseId,
            offering_id: offeringId,
            source: "practice",
            feedback: draft.feedback,
            strengths: draft.strengths,
            areas_for_improvement: draft.areas_for_improvement,
          });
        if (draftError && draftError.code !== "23505") {
          logger.error("Failed to store review draft", { error: draftError.message });
        }
      })().catch((error) => {
        if (error instanceof AiFeatureDisabledError) {
          // The school switched the grading family off — a policy refusal,
          // not a failure. The submission stands; there is simply no draft.
          logger.info("Review draft skipped: grading family disabled for institution");
        } else {
          logger.exception(error as Error, "Review draft failed (submission already recorded)");
        }
      });

      // deno-lint-ignore no-explicit-any
      const er = (globalThis as any).EdgeRuntime;
      if (er && typeof er.waitUntil === "function") {
        er.waitUntil(work);
      } else {
        // No EdgeRuntime (local serve / tests): finish inline rather than
        // leave a floating promise behind.
        await work;
      }
    }

    return jsonResponse(200, { success: true, pendingReview: true });
  } catch (error) {
    logger.exception(error as Error, "submit-open-answer error");
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
