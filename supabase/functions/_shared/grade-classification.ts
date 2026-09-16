/**
 * Deno mirror of src/lib/grade-classification.ts (#610). Keep the two in
 * sync.
 *
 * Per-item match is strict equality of submitted vs canonical category id.
 * Missing / null submission → false. Unknown category id in `submitted`
 * just fails the equality check without throwing. `totalCount` is derived
 * from the canonical map.
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
