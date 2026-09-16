// Grade and record quiz / practice answers (#1094).
//
// This is the sole writer of `quiz_answers`. Every answer surface that used to
// insert the row from the browser — the formal quiz player (immediate, deferred
// and time-up auto-submit), practice mode, the student question generator and
// the community question list — posts its raw submissions here instead, and the
// grade is recomputed from `questions.answer_key` with the shared graders. A
// client-supplied `is_correct` is not read; there is no parameter for one.
//
// The verdict comes from the LIVE question, not from the snapshot the player
// froze at quiz start. That is deliberate: `update_question_content` refuses to
// edit a question that has any recorded answer, so the only key that can differ
// from the snapshot is one edited before this student answered anything, and
// the instructor's current key is the one the whole class is marked against.
//
// `record_quiz_answers` then persists under `FOR KEY SHARE` on each question and
// rejects (HINT `stale_answer_key`) if its `updated_at` moved since the read
// below, which is the half of the race a lock alone could not close — see the
// migration.
//
// Grading is deterministic except for fill-gaps, which is exact-match first and
// then the shared LLM equivalence judge, the same second pass the practice and
// study-guide surfaces already had. Open answers inside a quiz are recorded for
// review and never auto-scored.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  classificationAssignmentsFromAnswerKey,
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsStemFromPayload,
  mcqCorrectIndicesFromAnswerKey,
  orderingItemsFromPayload,
} from "../_shared/question-payload.ts";
// Shared with `grade-deterministic-answer`, so the two graders that record a
// student answer hand back the same review payload (#1011).
import { buildReveal } from "../_shared/question-reveal.ts";
import { gradeMcq } from "../_shared/grade-mcq.ts";
import { gradeFillGaps } from "../_shared/grade-fill-gaps.ts";
import { gradeOrdering } from "../_shared/grade-ordering.ts";
import { gradeClassification } from "../_shared/grade-classification.ts";
import { judgeFillGapsWithLLM } from "../_shared/llm-judge-fill-gaps.ts";
import { createUsageContext } from "../_shared/usage-tracker.ts";
import {
  extractClassification,
  extractMcqSelection,
  extractOpenText,
  extractStringArray,
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

// A quiz is a bounded set of questions; this only has to be larger than the
// longest real one to stop a single call from locking the question bank.
const MAX_ANSWERS = 200;

// How many questions are graded at once. Only fill-gaps grading is ever slow
// (it may call the equivalence judge), so this is really a cap on concurrent
// model calls per submission.
const GRADE_CONCURRENCY = 4;

interface RequestBody {
  courseId?: unknown;
  quizId?: unknown;
  offeringId?: unknown;
  sessionId?: unknown;
  answers?: unknown;
  finalizeSession?: unknown;
}

// deno-lint-ignore no-explicit-any
type Json = any;

interface QuestionRow {
  id: string;
  type: string;
  payload: Json;
  answer_key: Json;
  explanation: string | null;
  course_id: string;
  updated_at: string;
}

/**
 * Whether the caller may be shown the key for what they just answered.
 *
 * Practice (no quiz) always may: it is a self-serve drill with no attempt to
 * protect, and the answer after the guess is the whole point. A quiz may only
 * once its answers are released — globally on the quiz, or on the assignment
 * of it to this offering.
 *
 * `every`, not `some`, and only over a non-empty list. The same quiz can be
 * assigned to one offering more than once and each assignment releases
 * separately, but an attempt does not record which assignment it belongs to:
 * `quiz_sessions` carries `offering_id`, never the `offering_quizzes` row. The
 * caller cannot supply it either — a student naming the released sibling would
 * be indistinguishable from one naming their own, since both match the same
 * (quiz, offering) pair. So when sibling assignments disagree, this cannot know
 * which one is being answered, and returns the key for neither. The student
 * sees no marks; a released assignment does not open an unreleased one.
 *
 * That makes it no more permissive than the per-assignment value
 * `StudentCourse` already computes for the player's `showAnswersEnabled` prop,
 * and identical to it whenever there is exactly one assignment, which is the
 * ordinary case. Binding the reveal to the actual assignment needs
 * `quiz_sessions` to record it, and that is a schema change, not this PR.
 *
 * The empty case reveals nothing on purpose: `[].every(...)` is vacuously
 * true, and a quiz with no assignment found — including one whose lookup
 * failed — is not a quiz whose answers were released.
 *
 * Pure, and separated from the reads that feed it, because it is the rule that
 * decides whether a key leaves the server.
 */
export function revealAllowedFrom(
  quizId: string | null,
  quizShowAnswers: boolean | null | undefined,
  offeringRows: Array<{ answers_released: boolean | null }> | null | undefined,
): boolean {
  if (!quizId) return true;
  if (quizShowAnswers === true) return true;
  const rows = offeringRows ?? [];
  return rows.length > 0 && rows.every((r) => r.answers_released === true);
}

interface GradedAnswer {
  question_id: string;
  question_version: string;
  selected_answer: number;
  submission: Json;
  is_correct: boolean;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * `null` for an absent id, the id for a present one, `undefined` for a value
 * that is not an id at all (the caller turns that into a 400). The uuid FORMAT
 * is left to the database — it casts these, and inventing a second opinion here
 * would only add a way for the two to disagree.
 */
function optionalId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : undefined;
}

/**
 * Grade one submission against the stored question.
 *
 * A submission that does not parse into its type's shape is graded as
 * unanswered rather than rejected: these calls carry a whole attempt, including
 * the time-up auto-submit, and refusing the batch over one malformed entry
 * would throw away answers the student did give. Same for a question whose
 * answer key is empty — every shared grader already returns "not correct" for an
 * empty key, which is exactly what the browser recorded before this function
 * existed.
 */
async function gradeOne(
  question: QuestionRow,
  submission: Json,
  ctx: { userId: string; judged: Map<string, boolean[]> },
): Promise<{
  isCorrect: boolean;
  selectedAnswer: number;
  submission: Json;
  perGap?: boolean[];
}> {
  switch (question.type) {
    case "mcq": {
      const selected = extractMcqSelection(submission) ?? [];
      return {
        isCorrect: gradeMcq(selected, mcqCorrectIndicesFromAnswerKey(question.answer_key)),
        // Legacy `selected_answer` keeps carrying the first picked index (#592).
        selectedAnswer: selected[0] ?? 0,
        submission: { selected_indices: selected },
      };
    }
    case "fill_gaps": {
      const inputs = extractStringArray(submission, "fill_gaps") ?? [];
      const gaps = fillGapsAcceptableAnswersFromAnswerKey(question.answer_key);
      const exact = gradeFillGaps(inputs, gaps.map((g) => g.acceptable));

      // Exact first, then the LLM equivalence net (#784) — the same second pass
      // `grade-deterministic-answer` gives the practice surfaces and
      // `submit-study-guide-piece` gives a guide. A quiz was the one place a
      // synonym, an accent or an obvious typo still counted as wrong, which put
      // the strictest grading on the surface where being marked wrong costs the
      // student most.
      //
      // The judge only ever upgrades a false to a true, makes no call at all
      // when every gap already matched exactly (the common case, so a class
      // submitting correct answers costs nothing), and returns the exact result
      // untouched on any failure — a quiz submission is never blocked by it.
      //
      // Memoised across the stale-key retry: re-grading re-runs this function,
      // and a question whose `updated_at` has not moved has the same stem, the
      // same key and the same submission, so its verdict cannot differ. Only a
      // question the instructor actually edited is judged twice.
      const memoKey = `${question.id}::${question.updated_at}`;
      let perGap = ctx.judged.get(memoKey);
      if (!perGap) {
        const judged = await judgeFillGapsWithLLM({
          stem: fillGapsStemFromPayload(question.payload),
          gaps,
          submitted: inputs,
          exactPerGap: exact.perGap,
          usageContext: createUsageContext("submit-quiz-answers", {
            promptKey: "fill_gaps_equivalence_judge",
            courseId: question.course_id,
            userId: ctx.userId,
          }),
        });
        if (judged.llmFailed) {
          // Not an error the student should see — their exact-match grade
          // stands — but silent stricter grading is worth being able to find
          // afterwards.
          logger.warn("fill-gaps judge unavailable; exact match stands", {
            questionId: question.id,
          });
        }
        perGap = judged.perGap;
        ctx.judged.set(memoKey, perGap);
      }

      return {
        isCorrect: perGap.length > 0 && perGap.every(Boolean),
        selectedAnswer: 0,
        submission: { fill_gaps: inputs },
        perGap,
      };
    }
    case "ordering": {
      const order = extractStringArray(submission, "ordering") ?? [];
      return {
        isCorrect: gradeOrdering(order, orderingItemsFromPayload(question.payload)).allCorrect,
        selectedAnswer: 0,
        submission: { ordering: order },
      };
    }
    case "classification": {
      const placements = extractClassification(submission) ?? {};
      return {
        isCorrect: gradeClassification(
          placements,
          classificationAssignmentsFromAnswerKey(question.answer_key),
        ).allCorrect,
        selectedAnswer: 0,
        submission: { classification: placements },
      };
    }
    case "open":
    default: {
      // An open answer inside a quiz is recorded for review, never auto-scored
      // — the same contract the browser had (`gradeNonMcq` returns false for
      // `open`), and since AI grading was removed, the contract every open
      // answer surface shares: the instructor grades, never the model.
      const text = extractOpenText(submission) ?? "";
      return { isCorrect: false, selectedAnswer: 0, submission: { open_text: text } };
    }
  }
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const { courseId, sessionId } = body;

    if (typeof courseId !== "string" || typeof sessionId !== "string") {
      return jsonResponse(400, { error: "Missing required parameters" });
    }
    const quizId = optionalId(body.quizId);
    const offeringId = optionalId(body.offeringId);
    if (quizId === undefined || offeringId === undefined) {
      return jsonResponse(400, { error: "Malformed quizId or offeringId" });
    }
    if (!Array.isArray(body.answers) || body.answers.length === 0) {
      return jsonResponse(400, { error: "answers must be a non-empty array" });
    }
    if (body.answers.length > MAX_ANSWERS) {
      return jsonResponse(400, { error: `At most ${MAX_ANSWERS} answers per submission` });
    }

    // One submission per question — the client sending the same question twice
    // is a bug, and the RPC would refuse the batch anyway.
    const submittedById = new Map<string, unknown>();
    for (const a of body.answers as unknown[]) {
      if (!a || typeof a !== "object") continue;
      const { questionId, submission } = a as { questionId?: unknown; submission?: unknown };
      if (typeof questionId !== "string") continue;
      submittedById.set(questionId, submission);
    }
    if (submittedById.size !== body.answers.length) {
      return jsonResponse(400, { error: "Each answer must name a distinct question" });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
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
    logger.setContext({ userId, courseId });

    // May this caller see the key for what they are about to answer?
    //
    // Practice always may: it is a self-serve drill with no attempt to protect
    // and its whole point is the answer that follows the guess. A quiz may only
    // once the instructor has released answers — globally on the quiz, or for
    // this assignment — which is the same disjunction `StudentCourse` computes
    // for the player's `showAnswersEnabled` prop.
    //
    // Deciding it here is what makes that setting mean anything. The player used
    // to hold every key from the moment the quiz opened and merely decline to
    // paint it, so "don't show answers" was a rendering choice sitting on top of
    // data the browser already had (#1011).
    let quizShowAnswers: boolean | null = null;
    let offeringQuizRows: Array<{ answers_released: boolean | null }> = [];
    if (quizId) {
      const { data: quizRow, error: quizError } = await supabase
        .from("quizzes")
        .select("show_answers")
        .eq("id", quizId)
        .maybeSingle();
      if (quizError) {
        // A read that failed is not a read that said yes. Leaving these null /
        // empty withholds the key, which is the direction to fail in.
        logger.warn("Could not read show_answers; withholding review data", {
          quizId,
          error: quizError.message,
        });
      }
      quizShowAnswers = quizRow?.show_answers ?? null;

      if (quizShowAnswers !== true && offeringId) {
        // Not `maybeSingle`: the same quiz can be assigned to one offering more
        // than once, and each assignment releases separately. Every matching
        // row is read so `revealAllowedFrom` can see them disagree — see there
        // for why disagreement withholds rather than picking one.
        const { data: oqRows, error: oqError } = await supabase
          .from("offering_quizzes")
          .select("answers_released")
          .eq("quiz_id", quizId)
          .eq("offering_id", offeringId);
        if (oqError) {
          logger.warn("Could not read answers_released; withholding review data", {
            quizId,
            offeringId,
            error: oqError.message,
          });
        }
        offeringQuizRows = oqRows ?? [];
      }
    }
    const revealAllowed = revealAllowedFrom(quizId, quizShowAnswers, offeringQuizRows);

    const questionIds = Array.from(submittedById.keys());

    // Fill-gaps judgements survive the retry below, keyed by question version,
    // so a re-grade does not pay for the same model call twice.
    const judged = new Map<string, boolean[]>();

    // Read → grade → record, retrying once when the record step reports that a
    // key changed under it. The retry re-reads, so the second attempt grades
    // against the key the instructor just saved.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: questionRows, error: questionError } = await supabase
        .from("questions")
        .select("id, type, payload, answer_key, explanation, course_id, updated_at")
        .in("id", questionIds);

      if (questionError) {
        logger.error("Question fetch failed", { error: questionError.message });
        return jsonResponse(500, { error: "Failed to load questions" });
      }

      const questions = (questionRows ?? []) as QuestionRow[];
      if (questions.length !== questionIds.length) {
        return jsonResponse(404, { error: "One or more questions no longer exist" });
      }
      // The answer is filed under `courseId`; a question from another course
      // would make that attribution a lie. The RPC refuses this too — reported
      // here so the caller gets 403 rather than a generic write failure.
      //
      // Deliberately the course and not the individual entitlement, and the
      // course is not an arbitrary line: `questions` RLS ("Users can view
      // questions for accessible courses") is course-scoped too, so a student
      // enrolled in it can already SELECT any of its questions — `answer_key`
      // included. This endpoint therefore tells them nothing they could not
      // read directly, and grading it server-side is about who decides the
      // verdict that gets STORED, not about hiding the key.
      //
      // That equivalence is why `reveal` can be returned from here at all
      // today. It stops holding once #1011 revokes the column: this gate is
      // then a real boundary rather than a restatement of RLS, and the pair of
      // conditions that guard `reveal` — an answer on record, and answers
      // released — are what it will have to stand on.
      //
      // A tighter gate was considered and rejected for the flows it breaks: a
      // `verifyQuestionEnrollment` per question would refuse the two surfaces
      // whose questions have no `offering_questions` row at all — the student
      // question generator and community questions — and a `quiz_questions`
      // membership check would make an instructor editing a quiz's composition
      // mid-attempt fail the student's whole submit. What the course gate
      // leaves open is a practice row for an unassigned question in the
      // student's own course, which no quiz-scoped report reads (they all
      // filter on `quiz_id`).
      const foreign = questions.find((q) => q.course_id !== courseId);
      if (foreign) {
        return jsonResponse(403, { error: "Question does not belong to this course" });
      }

      // Graded in bounded parallel. A deferred submit carries the whole quiz,
      // so serial grading would add one LLM round-trip per fill-gaps question
      // to a student's wait — but letting a 40-question submit fan out to 40
      // concurrent calls, times a class finishing a timed quiz together, is how
      // the judge starts returning 429s. It fails soft when it does (the exact
      // grade stands), and a silent slide into stricter grading under load is
      // exactly the failure worth not arranging. Only gaps the exact pass
      // rejected reach the model at all, so a mostly-correct class stays near
      // zero calls either way.
      const graded: GradedAnswer[] = [];
      const gradedPerGap = new Map<string, boolean[]>();
      const questionById = new Map(questions.map((q) => [q.id, q]));
      for (let i = 0; i < questions.length; i += GRADE_CONCURRENCY) {
        const slice = questions.slice(i, i + GRADE_CONCURRENCY);
        const results = await Promise.all(
          slice.map((q) => gradeOne(q, submittedById.get(q.id), { userId, judged })),
        );
        slice.forEach((q, n) => {
          const result = results[n];
          if (result.perGap) gradedPerGap.set(q.id, result.perGap);
          graded.push({
            question_id: q.id,
            question_version: q.updated_at,
            selected_answer: result.selectedAnswer,
            submission: result.submission,
            is_correct: result.isCorrect,
          });
        });
      }

      const { data: recorded, error: rpcError } = await supabase.rpc("record_quiz_answers", {
        _user_id: userId,
        _course_id: courseId,
        _quiz_id: quizId,
        _offering_id: offeringId,
        _session_id: sessionId,
        _answers: graded,
        _finalize: body.finalizeSession === true,
      });

      if (rpcError) {
        // An instructor's edit landed between the read above and the write.
        // Nothing is wrong with the submission; grade it again.
        //
        // Matched on the RPC's hint, not on SQLSTATE 40001: a code that means
        // "retryable transaction" gets acted on by the layers between here and
        // Postgres, and did (see the migration). The message is checked too, so
        // a hint dropped somewhere in transit does not silently turn a retry
        // into a 500.
        const staleKey = rpcError.hint === "stale_answer_key" ||
          rpcError.message?.includes("answer key changed while grading");

        if (staleKey && attempt === 0) {
          logger.warn("Answer key changed while grading, retrying", { questionIds });
          continue;
        }
        if (staleKey) {
          return jsonResponse(409, {
            error: "question_changed",
            message: "This question was edited while your answer was being graded. Please try again.",
          });
        }
        if (rpcError.code === "42501" || rpcError.message?.includes("insufficient_privilege")) {
          return jsonResponse(403, { error: "not_authorized", message: rpcError.message });
        }
        logger.error("Failed to record quiz answers", { error: rpcError.message });
        return jsonResponse(500, { error: "Failed to store answers" });
      }

      const rows = (recorded ?? []) as Array<
        { question_id: string; is_correct: boolean; recorded_now: boolean }
      >;
      const results = rows.map((r) => ({
        questionId: r.question_id,
        isCorrect: r.is_correct,
        recordedNow: r.recorded_now,
        // Per-gap breakdown of the submission just graded, for the review that
        // renders it. Without it the player would mark the gaps from its own
        // exact matcher and contradict the verdict stored here — showing a gap
        // red under an answer the judge accepted is worse than not marking it.
        //
        // Only when this call is what recorded the answer. `is_correct` above
        // is whatever the attempt already held, so on a resubmission — where
        // the earlier answer stands and this one was dropped — attaching marks
        // derived from the dropped text would describe one answer with the
        // verdict of another. The two halves of the result have to be about the
        // same submission or neither is worth having.
        ...(r.recorded_now && gradedPerGap.has(r.question_id)
          ? { perGap: gradedPerGap.get(r.question_id) }
          : {}),
        // The key material for the answer now on record, so the caller can
        // paint the review without having held it while the student answered
        // (#1011). Unlike `perGap` this is not derived from the submission —
        // it is the question's own key — so a resubmission whose answer was
        // dropped still gets it: the student has an answer on record either
        // way, which is the only thing that earns it.
        ...(revealAllowed && questionById.has(r.question_id)
          ? { reveal: buildReveal(questionById.get(r.question_id)!) }
          : {}),
      }));
      const correctCount = results.filter((r) => r.isCorrect).length;

      return jsonResponse(200, {
        success: true,
        results,
        correctCount,
        totalCount: results.length,
      });
    }

    // Unreachable: the loop either returns or `continue`s exactly once.
    return jsonResponse(500, { error: "Failed to store answers" });
  } catch (error) {
    logger.exception(error as Error, "submit-quiz-answers error");
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
