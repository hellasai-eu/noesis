/**
 * The key material for a question the student has just answered (#1011).
 *
 * The answering surfaces no longer fetch `answer_key` with the question — it
 * used to sit in the browser, unrendered, for as long as the student took to
 * answer, and on the practice lists it arrived for a whole course at once. The
 * review data comes back from whichever grader recorded the answer instead:
 * `submit-quiz-answers` for quiz and MCQ practice, `grade-deterministic-answer`
 * for the fill-gaps / ordering / classification practice panels. Both return
 * this shape (`supabase/functions/_shared/question-reveal.ts`).
 *
 * Only the fields for the question's own type are populated. Absent entirely
 * when the server withholds it — a quiz whose instructor has not released
 * answers sends no `reveal` at all — and a caller with none must render the
 * submitted answer without correctness marks rather than fall back to a key of
 * its own, because it no longer has one.
 */
export interface QuestionReveal {
  explanation: string | null;
  correctIndices?: number[];
  fillGapsGaps?: { ordinal: number; acceptable: string[] }[];
  classificationAssignments?: Record<string, string>;
  orderingCanonical?: string[];
}

/**
 * Pull a `reveal` off a grader's JSON response.
 *
 * Present-or-absent is the only distinction that matters to a caller, so this
 * checks the envelope and passes the payload through as the server shaped it.
 * Narrowing each field here would only invent a second opinion about a
 * contract the handlers and this module define together.
 */
export function revealFrom(payload: unknown): QuestionReveal | undefined {
  const reveal = (payload as { reveal?: unknown } | null | undefined)?.reveal;
  return reveal && typeof reveal === "object" && !Array.isArray(reveal)
    ? (reveal as QuestionReveal)
    : undefined;
}
