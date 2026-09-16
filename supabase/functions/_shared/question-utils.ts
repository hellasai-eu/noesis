export const MAX_QUESTIONS = 5;

/**
 * Clamps numQuestions to [1, MAX_QUESTIONS], defaulting to MAX_QUESTIONS when
 * the value is falsy (undefined, null, 0).
 */
export function capNumQuestions(n: number | undefined): number {
  return Math.min(Math.max(1, n || MAX_QUESTIONS), MAX_QUESTIONS);
}
