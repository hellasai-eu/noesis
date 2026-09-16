/**
 * The one way the frontend records a quiz or practice answer (#1094).
 *
 * `quiz_answers` used to be written straight from the browser with an
 * `is_correct` the browser had computed. It no longer has a student INSERT
 * policy: the `submit-quiz-answers` edge function re-grades every submission
 * from `questions.answer_key` and writes the row under the service role. So
 * this module posts what the student did and reads back what the server
 * decided — the returned verdicts are the ones actually stored.
 *
 * Callers pass only the submission shapes. There is deliberately no way to
 * suggest a grade.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
// Shared with the practice panels, which get the same shape back from
// `grade-deterministic-answer` (#1011). Re-exported because it has been part
// of this module's surface since it was introduced here.
import { revealFrom, type QuestionReveal } from "@/lib/question-reveal";

export type { QuestionReveal };

export interface QuizAnswerSubmission {
  questionId: string;
  /**
   * Per-type submission jsonb, exactly as `quiz_answers.submission` stores it:
   * `{ selected_indices }` for MCQ, `{ classification }`, `{ ordering }`,
   * `{ fill_gaps }` or `{ open_text }` for the rest.
   */
  submission: Json;
}

export interface SubmitQuizAnswersInput {
  courseId: string;
  sessionId: string;
  answers: QuizAnswerSubmission[];
  quizId?: string | null;
  offeringId?: string | null;
  /** Mark the quiz session completed in the same transaction as the answers. */
  finalizeSession?: boolean;
}

export interface QuizAnswerVerdict {
  questionId: string;
  isCorrect: boolean;
  /** False when the attempt already held an answer for this question. */
  recordedNow: boolean;
  /**
   * Fill-gaps only: which gaps the server accepted, in ordinal order. Present
   * because the server's answer can differ from an exact match — the LLM
   * equivalence judge upgrades a synonym or an obvious typo (#784) — so a
   * renderer that re-derived per-gap marks locally would contradict the stored
   * verdict. Absent for every other type, and for a resubmission whose answer
   * was already on record.
   */
  perGap?: boolean[];
  /**
   * Present only when the server released it — practice always, a quiz once
   * its answers are released. A caller with no `reveal` must render the
   * submitted answer without correctness marks rather than fall back to a key
   * of its own, because it no longer has one.
   */
  reveal?: QuestionReveal;
}

export interface SubmitQuizAnswersResult {
  results: QuizAnswerVerdict[];
  correctCount: number;
  totalCount: number;
}

/** Thrown for every non-success response so callers can branch on `code`. */
export class SubmitQuizAnswersError extends Error {
  constructor(
    message: string,
    /** The function's machine-readable `error` field, when it sent one. */
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "SubmitQuizAnswersError";
  }
}

function verdictsFrom(payload: unknown): QuizAnswerVerdict[] {
  const raw = (payload as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return [];
  const out: QuizAnswerVerdict[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { questionId, isCorrect, recordedNow, perGap } = r as Record<string, unknown>;
    if (typeof questionId !== "string") continue;
    out.push({
      questionId,
      isCorrect: isCorrect === true,
      recordedNow: recordedNow !== false,
      ...(Array.isArray(perGap) && perGap.every((v) => typeof v === "boolean")
        ? { perGap: perGap as boolean[] }
        : {}),
      ...(revealFrom(r) ? { reveal: revealFrom(r)! } : {}),
    });
  }
  return out;
}

export async function submitQuizAnswers(
  input: SubmitQuizAnswersInput,
): Promise<SubmitQuizAnswersResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    throw new SubmitQuizAnswersError("Not authenticated", "unauthenticated", 401);
  }

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/submit-quiz-answers`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      courseId: input.courseId,
      sessionId: input.sessionId,
      quizId: input.quizId ?? null,
      offeringId: input.offeringId ?? null,
      finalizeSession: input.finalizeSession === true,
      answers: input.answers,
    }),
  });

  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

  if (!resp.ok || json.error) {
    const code = typeof json.error === "string" ? json.error : null;
    const message = typeof json.message === "string"
      ? json.message
      : code ?? "Failed to save answers";
    throw new SubmitQuizAnswersError(message, code, resp.status);
  }

  const results = verdictsFrom(json);
  return {
    results,
    correctCount: typeof json.correctCount === "number"
      ? json.correctCount
      : results.filter((r) => r.isCorrect).length,
    totalCount: typeof json.totalCount === "number" ? json.totalCount : results.length,
  };
}

/** Verdict lookup keyed by question id, for callers folding results into state. */
export function verdictMap(result: SubmitQuizAnswersResult): Map<string, boolean> {
  return new Map(result.results.map((r) => [r.questionId, r.isCorrect]));
}
