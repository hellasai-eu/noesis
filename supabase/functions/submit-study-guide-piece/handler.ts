// Grade and record a study-guide piece's answers (#980).
//
// The sequential player submits every question in a piece at once. This
// function is the sole writer of `study_guide_answers`: it grades each answer
// SERVER-SIDE (reusing the shared graders), inserts the graded rows under
// the service role, and advances the student's progress so the next piece
// unlocks. The client never computes correctness — grades are always recomputed
// here from `answer_key`, never trusted from the wire.
//
// Open questions are the exception: like open answers inside a quiz, they are
// recorded for instructor review and never auto-scored (grade/feedback NULL
// until the instructor writes them). After the transaction commits, the model
// drafts qualitative review notes into `open_answer_ai_drafts` — a
// manager-only table — as a best-effort background task.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import { getEffectiveLanguage, getLanguageInstruction } from "../_shared/language-utils.ts";
import { AiFeatureDisabledError } from "../_shared/openai-client.ts";
import { draftOpenAnswerReview } from "../_shared/open-answer-review-draft.ts";
import {
  classificationAssignmentsFromAnswerKey,
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsStemFromPayload,
  mcqCorrectIndicesFromAnswerKey,
  openExplanationFromAnswerKey,
  openModelAnswerFromAnswerKey,
  openRubricFromAnswerKey,
  orderingItemsFromPayload,
} from "../_shared/question-payload.ts";
import { gradeMcq } from "../_shared/grade-mcq.ts";
import { gradeFillGaps } from "../_shared/grade-fill-gaps.ts";
import { gradeOrdering } from "../_shared/grade-ordering.ts";
import { gradeClassification } from "../_shared/grade-classification.ts";
import { judgeFillGapsWithLLM } from "../_shared/llm-judge-fill-gaps.ts";
import { verifyStudyGuideEnrollment } from "../_shared/verify-study-guide-enrollment.ts";
import {
  extractClassification,
  extractMcqSelection,
  extractOpenText,
  extractStringArray,
  percentGrade,
} from "../_shared/study-guide-submission.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Matches submit-open-answer — bounds a runaway paste before it hits the
// review surface (and, downstream, the draft prompt).
const ANSWER_CHAR_LIMIT = 4000;

// Open answers awaiting a review draft, collected during grading and
// processed only after the transaction commits.
interface PendingDraftInput {
  questionId: string;
  courseId: string;
  question: string;
  modelAnswer: string;
  rubric: string | null;
  explanation: string | null;
  studentAnswer: string;
}

interface RequestBody {
  studyGuideId?: unknown;
  offeringId?: unknown;
  pieceId?: unknown;
  answers?: unknown;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type QuestionRow = any;

interface GradedRow {
  question_id: string;
  is_correct: boolean | null;
  grade: number | null;
  feedback: string | null;
  strengths: string[] | null;
  areas_for_improvement: string[] | null;
  submission: unknown;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const { studyGuideId, offeringId, pieceId } = body;

    if (
      typeof studyGuideId !== "string" ||
      typeof offeringId !== "string" ||
      typeof pieceId !== "string"
    ) {
      return jsonResponse(400, { error: "Missing required parameters" });
    }
    if (!Array.isArray(body.answers)) {
      return jsonResponse(400, { error: "answers must be an array" });
    }

    // Map client submissions by question id — the type and grading come from
    // the stored question, never the client.
    const submittedById = new Map<string, unknown>();
    for (const a of body.answers as unknown[]) {
      if (!a || typeof a !== "object") continue;
      const { questionId, submission } = a as { questionId?: unknown; submission?: unknown };
      if (typeof questionId === "string") submittedById.set(questionId, submission);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // JWT-derived caller — never trust a user_id from the body.
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return jsonResponse(401, { error: "Missing authorization" });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user?.id) return jsonResponse(401, { error: "Invalid authorization" });

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(user, token)) {
      return jsonResponse(403, { error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE });
    }

    const userId = user.id;
    logger.setContext({ userId });

    const enrollment = await verifyStudyGuideEnrollment(supabase, {
      userId,
      studyGuideId,
      offeringId,
    });
    if (!enrollment.ok) {
      // `code` distinguishes a guide the instructor marked done from plain
      // not-authorized; the player surfaces `error` as the toast either way.
      return jsonResponse(enrollment.status, {
        error: enrollment.error,
        ...(enrollment.code ? { code: enrollment.code } : {}),
      });
    }

    // Confirm the piece belongs to the guide, and read its position.
    const { data: piece, error: pieceError } = await supabase
      .from("study_guide_pieces")
      .select("id, position, study_guide_id")
      .eq("id", pieceId)
      .eq("study_guide_id", studyGuideId)
      .maybeSingle();
    if (pieceError) {
      logger.error("Piece fetch failed", { error: pieceError.message });
      return jsonResponse(500, { error: "Failed to load piece" });
    }
    if (!piece) return jsonResponse(404, { error: "Piece not found" });

    // Only the student's CURRENT piece may be submitted. Without this, a
    // student who knows a future piece's id could submit it directly —
    // `study_guide_piece_questions`/`questions` RLS authorizes every piece of
    // a published guide, not just the reached ones — grading it and jumping
    // `current_piece_position` past every piece in between via the
    // `Math.max` progress advance below.
    const { data: progressRow, error: progressFetchError } = await supabase
      .from("study_guide_progress")
      .select("current_piece_position")
      .eq("user_id", userId)
      .eq("study_guide_id", studyGuideId)
      .eq("offering_id", offeringId)
      .maybeSingle();
    if (progressFetchError) {
      logger.error("Progress fetch failed", { error: progressFetchError.message });
      return jsonResponse(500, { error: "Failed to load progress" });
    }
    // Deadline gate, mirroring the student tile's lock: a guide the student
    // never STARTED (no progress row — the player creates one on first open)
    // cannot be begun after its due date, while a started one keeps its grace
    // period. Without this, the lock was presentational only and a direct
    // call here could start the guide late. Post-deadline fabrication of
    // "started" state is blocked at the source: the progress INSERT policy
    // (20260910130000) refuses to create a row once the deadline has passed.
    if (!progressRow && enrollment.deadlinePassed) {
      return jsonResponse(403, {
        error: "The due date for this study guide has passed.",
        code: "guide_expired",
      });
    }

    const currentPosition = progressRow?.current_piece_position ?? 0;
    if (piece.position !== currentPosition) {
      return jsonResponse(403, {
        error: "piece_locked",
        message: "This piece is not currently unlocked.",
      });
    }

    // Load the piece's questions in order.
    const { data: linkRows, error: linkError } = await supabase
      .from("study_guide_piece_questions")
      // `question` is the stem itself: the review-draft prompt renders it, so
      // omitting it here drafts notes against an empty question. Same column
      // list `submit-open-answer` reads.
      .select(
        "question_id, position, questions!inner(id, question, type, payload, answer_key, explanation, course_id)",
      )
      .eq("piece_id", pieceId)
      .order("position", { ascending: true });
    if (linkError) {
      logger.error("Piece questions fetch failed", { error: linkError.message });
      return jsonResponse(500, { error: "Failed to load questions" });
    }

    const questions = (linkRows ?? []).map((row) => {
      const r = row as unknown as { questions: QuestionRow };
      return r.questions;
    });
    if (questions.length === 0) {
      return jsonResponse(400, { error: "Piece has no questions" });
    }

    // Every question in the piece must have a submission — the server mirror of
    // the per-piece submit gate.
    const missing = questions
      .filter((q: QuestionRow) => !submittedById.has(q.id))
      .map((q: QuestionRow) => q.id);
    if (missing.length > 0) {
      return jsonResponse(400, {
        error: "incomplete_piece",
        message: "Every question in the piece must be answered before submitting.",
        unanswered: missing,
      });
    }

    const questionIds = questions.map((q: QuestionRow) => q.id);

    // One-shot guard — answers are immutable, one attempt per question.
    const { data: existing, error: existingError } = await supabase
      .from("study_guide_answers")
      .select("question_id")
      .eq("user_id", userId)
      .eq("offering_id", offeringId)
      .in("question_id", questionIds)
      .limit(1);
    if (existingError) {
      logger.error("Existing answer check failed", { error: existingError.message });
      return jsonResponse(500, { error: "Failed to check submission" });
    }
    if (existing && existing.length > 0) {
      return jsonResponse(409, {
        error: "already_submitted",
        message: "You have already submitted this piece.",
      });
    }

    // Grade every question IN MEMORY first, so a mid-piece LLM failure inserts
    // nothing and the student can retry the whole piece cleanly.
    const graded: GradedRow[] = [];
    const pendingDrafts: PendingDraftInput[] = [];

    for (const q of questions as QuestionRow[]) {
      const submission = submittedById.get(q.id);
      const explanation: string | null = q.explanation || null;

      if (q.type === "mcq") {
        const selected = extractMcqSelection(submission);
        if (!selected) return jsonResponse(400, { error: `Malformed MCQ answer for ${q.id}` });
        const isCorrect = gradeMcq(selected, mcqCorrectIndicesFromAnswerKey(q.answer_key));
        graded.push({
          question_id: q.id,
          is_correct: isCorrect,
          grade: isCorrect ? 100 : 0,
          feedback: explanation,
          strengths: null,
          areas_for_improvement: null,
          submission: { selected_indices: selected },
        });
      } else if (q.type === "fill_gaps") {
        const inputs = extractStringArray(submission, "fill_gaps");
        if (!inputs) return jsonResponse(400, { error: `Malformed fill-gaps answer for ${q.id}` });
        const gapsForKey = fillGapsAcceptableAnswersFromAnswerKey(q.answer_key);
        const acceptable = gapsForKey.map((g) => g.acceptable);
        if (acceptable.length === 0) return jsonResponse(500, { error: "Question has no answer key" });
        const exact = gradeFillGaps(inputs, acceptable);
        const judged = await judgeFillGapsWithLLM({
          stem: fillGapsStemFromPayload(q.payload),
          gaps: gapsForKey,
          submitted: inputs,
          exactPerGap: exact.perGap,
          usageContext: createUsageContext("submit-study-guide-piece", {
            promptKey: "fill_gaps_equivalence_judge",
            courseId: q.course_id,
            userId,
          }),
        });
        const perGap = judged.perGap;
        const allCorrect = perGap.length > 0 && perGap.every(Boolean);
        graded.push({
          question_id: q.id,
          is_correct: allCorrect,
          grade: percentGrade(perGap.filter(Boolean).length, perGap.length),
          feedback: explanation,
          strengths: null,
          areas_for_improvement: null,
          submission: { fill_gaps: inputs },
        });
      } else if (q.type === "ordering") {
        const order = extractStringArray(submission, "ordering");
        if (!order) return jsonResponse(400, { error: `Malformed ordering answer for ${q.id}` });
        const canonical = orderingItemsFromPayload(q.payload);
        if (canonical.length === 0) return jsonResponse(500, { error: "Question has no answer key" });
        const result = gradeOrdering(order, canonical);
        graded.push({
          question_id: q.id,
          is_correct: result.allCorrect,
          grade: percentGrade(result.perPosition.filter(Boolean).length, result.perPosition.length),
          feedback: explanation,
          strengths: null,
          areas_for_improvement: null,
          submission: { ordering: order },
        });
      } else if (q.type === "classification") {
        const placements = extractClassification(submission);
        if (!placements) return jsonResponse(400, { error: `Malformed classification answer for ${q.id}` });
        const canonical = classificationAssignmentsFromAnswerKey(q.answer_key);
        if (Object.keys(canonical).length === 0) return jsonResponse(500, { error: "Question has no answer key" });
        const result = gradeClassification(placements, canonical);
        graded.push({
          question_id: q.id,
          is_correct: result.allCorrect,
          grade: percentGrade(result.correctCount, result.totalCount),
          feedback: explanation,
          strengths: null,
          areas_for_improvement: null,
          submission: { classification: placements },
        });
      } else if (q.type === "open") {
        const text = extractOpenText(submission);
        if (text === null) return jsonResponse(400, { error: `Malformed open answer for ${q.id}` });
        const trimmed = text.trim();
        if (!trimmed) return jsonResponse(400, { error: `Empty open answer for ${q.id}` });
        if (trimmed.length > ANSWER_CHAR_LIMIT) {
          return jsonResponse(400, {
            error: "answer_too_long",
            message: `An answer is too long (${trimmed.length} characters). Please shorten it to ${ANSWER_CHAR_LIMIT} characters or less.`,
            questionId: q.id,
          });
        }

        const modelAnswer = openModelAnswerFromAnswerKey(q.answer_key);
        if (!modelAnswer) return jsonResponse(500, { error: "Question has no model answer" });

        // Moderation, mirroring grade-open-answer — a flagged answer blocks the
        // whole submit (nothing is inserted) and is reported to course admins.
        const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
        if (!openaiApiKey) throw new Error("OPENAI_API_KEY is not configured");
        const { moderateContent } = await import("../_shared/moderation.ts");
        const moderationResult = await moderateContent({ content: trimmed, apiKey: openaiApiKey });
        if (moderationResult.flagged) {
          logger.warn("Study guide open answer flagged by moderation", {
            questionId: q.id,
            userId,
            categories: moderationResult.flaggedCategories,
          });
          await supabase.from("admin_notifications").insert({
            course_id: q.course_id,
            student_id: userId,
            type: "content_moderation",
            title: "Study guide answer flagged",
            message: `A student's study-guide answer was flagged by content moderation. Categories: ${moderationResult.flaggedCategories.join(", ")}.`,
          });
          return jsonResponse(422, {
            error: "content_blocked",
            message: "Your answer has been flagged by our content moderation system. Please contact your instructor.",
            flagged: true,
            categories: moderationResult.flaggedCategories,
            questionId: q.id,
          });
        }

        // Recorded for instructor review, never auto-scored — the same
        // contract as an open answer inside a quiz. The review draft is
        // generated after the transaction commits (see below).
        pendingDrafts.push({
          questionId: q.id,
          courseId: q.course_id,
          question: q.question ?? "",
          modelAnswer,
          rubric: openRubricFromAnswerKey(q.answer_key),
          explanation: openExplanationFromAnswerKey(q.answer_key),
          studentAnswer: trimmed,
        });
        graded.push({
          question_id: q.id,
          is_correct: null,
          grade: null,
          feedback: null,
          strengths: null,
          areas_for_improvement: null,
          submission: { open_text: trimmed },
        });
      } else {
        return jsonResponse(400, { error: `Unsupported question type: ${q.type}` });
      }
    }

    // Is this the final piece?
    const { data: allPieces } = await supabase
      .from("study_guide_pieces")
      .select("position")
      .eq("study_guide_id", studyGuideId);
    const maxPosition = (allPieces ?? []).reduce(
      (m, p) => Math.max(m, (p as { position: number }).position),
      0,
    );
    const isFinal = piece.position >= maxPosition;

    // Insert the graded rows and advance progress in ONE transaction (RPC),
    // so a mid-write failure can never leave the answers committed with
    // progress still stuck on this piece — which the immutable-answer
    // constraint would make impossible to retry.
    const { data: rpcResult, error: rpcError } = await supabase
      .rpc("submit_study_guide_piece_answers", {
        _user_id: userId,
        _study_guide_id: studyGuideId,
        _offering_id: offeringId,
        _piece_id: pieceId,
        _piece_position: piece.position,
        _is_final: isFinal,
        _answers: graded,
      })
      .single();
    if (rpcError) {
      if (rpcError.code === "23505") {
        return jsonResponse(409, {
          error: "already_submitted",
          message: "You have already submitted this piece.",
        });
      }
      if (rpcError.message?.includes("is not the current piece")) {
        return jsonResponse(403, {
          error: "piece_locked",
          message: "This piece is not currently unlocked.",
        });
      }
      logger.error("Failed to submit study guide piece", { error: rpcError.message });
      return jsonResponse(500, { error: "Failed to store answers" });
    }

    const nextPosition = (rpcResult as { current_piece_position: number }).current_piece_position;
    const completedAt = (rpcResult as { completed_at: string | null }).completed_at;

    // Best-effort review drafts for the instructor, generated AFTER the
    // answers are committed and (where possible) after the response goes out
    // — the student is not waiting for anything a draft contains. A draft
    // failure, including the school's grading toggle being off, only means
    // the instructor reviews without one.
    if (pendingDrafts.length > 0) {
      const work = (async () => {
        const effectiveLanguage = await getEffectiveLanguage(
          supabase,
          pendingDrafts[0].courseId,
        );
        const langInfo = getLanguageInstruction(effectiveLanguage);
        for (const p of pendingDrafts) {
          try {
            const endTimer = logger.startTimer("ai-draft-study-guide-open-review");
            const draft = await draftOpenAnswerReview({
              languageName: langInfo.name,
              question: p.question,
              modelAnswer: p.modelAnswer,
              rubric: p.rubric,
              explanation: p.explanation,
              studentAnswer: p.studentAnswer,
              usageContext: createUsageContext("submit-study-guide-piece", {
                promptKey: "grading",
                courseId: p.courseId,
                userId,
              }),
            });
            endTimer();

            const { error: draftError } = await supabase
              .from("open_answer_ai_drafts")
              .insert({
                question_id: p.questionId,
                user_id: userId,
                course_id: p.courseId,
                offering_id: offeringId,
                source: "study_guide",
                feedback: draft.feedback,
                strengths: draft.strengths,
                areas_for_improvement: draft.areas_for_improvement,
              });
            if (draftError && draftError.code !== "23505") {
              logger.error("Failed to store review draft", {
                error: draftError.message,
                questionId: p.questionId,
              });
            }
          } catch (error) {
            if (error instanceof AiFeatureDisabledError) {
              // Policy refusal — the whole family is off; stop trying.
              logger.info("Review drafts skipped: grading family disabled for institution");
              break;
            }
            logger.exception(error as Error, "Review draft failed (answers already recorded)");
          }
        }
      })().catch((error) => {
        logger.exception(error as Error, "Review draft batch failed (answers already recorded)");
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

    // Feedback for the UI, keyed by question, in the piece's order.
    const explanationById = new Map(
      (questions as QuestionRow[]).map((q) => [q.id, q.explanation || null]),
    );
    const results = graded.map((g) => ({
      questionId: g.question_id,
      isCorrect: g.is_correct,
      grade: g.grade,
      feedback: g.feedback,
      strengths: g.strengths,
      areasForImprovement: g.areas_for_improvement,
      explanation: explanationById.get(g.question_id) ?? null,
    }));

    return jsonResponse(200, {
      success: true,
      results,
      progress: { currentPiecePosition: nextPosition, completedAt },
    });
  } catch (error) {
    logger.exception(error as Error, "submit-study-guide-piece error");
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
