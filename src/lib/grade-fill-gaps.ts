/**
 * Grading helper for the fill-the-gaps (cloze) question type (#604).
 *
 * Per-gap match is exact-after-normalization: NFC → lowercase → trim →
 * collapse internal whitespace. A submitted gap is correct iff the
 * normalized submission equals the normalized form of any entry in that
 * gap's acceptable[] list. Empty / missing submissions are always false.
 *
 * Greek diacritics matter — NFC normalization makes the canonical form
 * stable across input methods, but `κάτω` and `κατω` remain distinct
 * (no diacritic stripping). This is the deterministic v1; LLM fuzzy
 * grading is explicitly out of scope.
 */

function normalize(s: string): string {
  return s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface GradeFillGapsResult {
  perGap: boolean[];
  allCorrect: boolean;
}

export function gradeFillGaps(
  submitted: string[],
  acceptablePerGap: string[][],
): GradeFillGapsResult {
  const perGap: boolean[] = acceptablePerGap.map((acceptable, i) => {
    const raw = submitted[i];
    if (typeof raw !== "string") return false;
    const norm = normalize(raw);
    if (norm.length === 0) return false;
    return acceptable.some((a) => normalize(a) === norm);
  });
  return { perGap, allCorrect: perGap.length > 0 && perGap.every(Boolean) };
}
