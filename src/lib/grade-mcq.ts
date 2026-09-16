/**
 * Grading helper for multi-correct MCQ (issue #592).
 *
 * Exact set match: the student's selected indices and the question's correct
 * indices must be the same set. Order is ignored; duplicates on either side
 * are ignored (treated as the set of distinct values). An empty selection is
 * always incorrect.
 *
 * Used by every grading site that previously did `selected === correct_index`
 * so single-correct and multi-correct items grade through one code path.
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
