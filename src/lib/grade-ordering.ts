/**
 * Grading helper for the ordering question type (#606).
 *
 * Per-position match is reference-equality against the canonical order: the
 * renderer tracks each item's identity through drag operations, so the
 * submitted array contains the original item strings in the student's final
 * order. Length mismatch (defensive — the renderer guarantees equal lengths)
 * → every position is false.
 *
 * Grading is deterministic and binary per position. v1 supports a single
 * canonical order — ties / multiple acceptable orders are out of scope.
 */

export interface GradeOrderingResult {
  perPosition: boolean[];
  allCorrect: boolean;
}

export function gradeOrdering(
  submitted: string[],
  canonical: string[],
): GradeOrderingResult {
  if (
    !Array.isArray(submitted) ||
    !Array.isArray(canonical) ||
    submitted.length !== canonical.length ||
    canonical.length === 0
  ) {
    const len = Array.isArray(canonical) ? canonical.length : 0;
    return {
      perPosition: new Array(len).fill(false),
      allCorrect: false,
    };
  }
  const perPosition = canonical.map((item, i) => submitted[i] === item);
  return {
    perPosition,
    allCorrect: perPosition.every(Boolean),
  };
}
