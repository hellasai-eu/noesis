/**
 * Prepend "Select all that apply." to an MCQ stem when more than one option
 * is marked correct (issue #592). Skips the prefix if the stem already
 * contains the phrase (case-insensitive substring), so instructors who type
 * it manually don't end up with a duplicate.
 *
 * Takes the fact, not the count. The hint is the one thing a student needs to
 * know before answering that used to be derived from the answer key, which
 * forced every answering surface to hold the key while the student answered
 * (#1011). It now comes from `payload.multi_correct` on the surfaces that have
 * not yet earned the key, and from the key itself on the review surfaces that
 * have. Both are the same boolean.
 *
 * The prefix is intentionally English-only for v1 — matches the rest of the
 * static UI strings in this codebase.
 */
const MULTI_HINT = "Select all that apply.";

export function renderQuestionStem(stem: string, multiCorrect: boolean): string {
  if (!multiCorrect) return stem;
  if (stem.toLowerCase().includes("select all that apply")) return stem;
  return `${MULTI_HINT} ${stem}`;
}
