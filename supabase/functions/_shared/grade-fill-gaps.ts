/**
 * Deno mirror of `src/lib/grade-fill-gaps.ts` — keep the two in sync.
 *
 * Per-gap match: NFC → lowercase → trim → collapse internal whitespace,
 * then string-equal against any of the gap's acceptable entries. Empty /
 * missing submissions are always false.
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
