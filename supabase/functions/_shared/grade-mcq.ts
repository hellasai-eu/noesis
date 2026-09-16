/**
 * Deno mirror of `src/lib/grade-mcq.ts`. Keep in sync — both implement the
 * exact set-match semantics used to grade MCQs after #592.
 */
export function gradeMcq(selected: number[], correct: number[]): boolean {
  if (!Array.isArray(selected) || !Array.isArray(correct)) return false;
  if (correct.length === 0) return false;
  const sel = new Set(selected);
  const cor = new Set(correct);
  if (sel.size === 0) return false;
  if (sel.size !== cor.size) return false;
  for (const c of cor) {
    if (!sel.has(c)) return false;
  }
  return true;
}
