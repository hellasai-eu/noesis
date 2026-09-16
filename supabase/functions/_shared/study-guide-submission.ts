// Pure readers for the per-type `submission` jsonb a study-guide player sends
// (#980). The player mirrors the quiz submission shapes so both surfaces round-
// trip through the same keys. These extract the raw value the shared graders
// expect (`grade-mcq`, `grade-fill-gaps`, `grade-ordering`,
// `grade-classification`). Kept dependency-free so they
// can be unit-tested without a Supabase client.

// deno-lint-ignore no-explicit-any
type Json = any;

function asRecord(value: Json): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{ selected_indices: number[] }` → the picked option indices (non-negative ints). */
export function extractMcqSelection(submission: Json): number[] | null {
  const sub = asRecord(submission);
  if (!sub) return null;
  const raw = sub.selected_indices;
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out.push(v);
    else return null;
  }
  return out;
}

/** `{ [key]: string[] }` → the string array (e.g. fill_gaps inputs, ordering order). */
export function extractStringArray(submission: Json, key: string): string[] | null {
  const sub = asRecord(submission);
  if (!sub) return null;
  const raw = sub[key];
  if (!Array.isArray(raw)) return null;
  return raw.map((v) => (typeof v === "string" ? v : ""));
}

/** `{ classification: Record<item_id, category_id> }` → the placements map. */
export function extractClassification(
  submission: Json,
): Record<string, string | null> | null {
  const sub = asRecord(submission);
  if (!sub) return null;
  const raw = asRecord(sub.classification);
  if (!raw) return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v === "string" ? v : null;
  }
  return out;
}

/** `{ open_text: string }` → the trimmed answer text. */
export function extractOpenText(submission: Json): string | null {
  const sub = asRecord(submission);
  if (!sub) return null;
  const raw = sub.open_text;
  return typeof raw === "string" ? raw : null;
}

/** A 0-100 percentage grade from a correct/total tally. */
export function percentGrade(correct: number, total: number): number {
  return total > 0 ? Math.round((correct / total) * 100) : 0;
}
