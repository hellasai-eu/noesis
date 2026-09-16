/**
 * Deno mirror of src/lib/grade-ordering.ts (#606). Keep the two in sync.
 *
 * Per-position match is reference-equality against the canonical order; the
 * renderer tracks each item's identity through drag operations. Length
 * mismatch → every position is false.
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
