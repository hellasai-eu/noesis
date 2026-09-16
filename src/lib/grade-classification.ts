/**
 * Grading helper for the classification question type (#610).
 *
 * Per-item match is a strict-equality comparison of submitted vs canonical
 * category id. An item that the student never placed (`submitted[item_id]`
 * is `null` or missing) grades as `false`. An unknown category id in
 * `submitted` likewise grades as `false` — the comparison just fails the
 * equality check without throwing, so callers don't need to pre-validate.
 *
 * Grading is deterministic and binary per item. `totalCount` is derived
 * from the canonical map (the source of truth) so a partial submission
 * doesn't quietly reduce the denominator.
 */

export interface GradeClassificationResult {
  perItem: Record<string, boolean>;
  correctCount: number;
  totalCount: number;
  allCorrect: boolean;
}

export function gradeClassification(
  submitted: Record<string, string | null>,
  canonical: Record<string, string>,
): GradeClassificationResult {
  const perItem: Record<string, boolean> = {};
  let correctCount = 0;
  const itemIds = Object.keys(canonical);
  for (const itemId of itemIds) {
    const submittedCategory = submitted[itemId];
    const isCorrect =
      typeof submittedCategory === "string" && submittedCategory === canonical[itemId];
    perItem[itemId] = isCorrect;
    if (isCorrect) correctCount += 1;
  }
  const totalCount = itemIds.length;
  return {
    perItem,
    correctCount,
    totalCount,
    allCorrect: totalCount > 0 && correctCount === totalCount,
  };
}
