// Shared helper for dual-writing grade_level_id alongside the legacy TEXT
// grade columns. Resolves an (institution_id, code) pair to a grade_levels
// row, creating it on the fly if the institution has never seen that grade
// before. Used by every server-side path that writes a grade during the
// dual-write phase (#796). The read cutover (#798) will make the FK
// canonical; this helper's job is only to keep the two columns in sync while
// the TEXT column is still the source of truth.

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

interface ResolveArgs {
  institutionId: string;
  code: string | null | undefined;
}

interface GreekTaxonomyRow {
  code: string;
  label_el: string;
  label_en: string;
  ordinal: number;
  school_level: "dimotiko" | "gymnasio" | "lykeio";
}

// Same taxonomy the #795 migration and src/lib/greek-school.ts carry. Kept
// inline because Deno edge functions can't import from the client src/ tree.
const GREEK_TAXONOMY: readonly GreekTaxonomyRow[] = [
  { code: "dimotiko_1", label_el: "1η Δημοτικού", label_en: "1st Grade Primary",       ordinal: 1,  school_level: "dimotiko" },
  { code: "dimotiko_2", label_el: "2η Δημοτικού", label_en: "2nd Grade Primary",       ordinal: 2,  school_level: "dimotiko" },
  { code: "dimotiko_3", label_el: "3η Δημοτικού", label_en: "3rd Grade Primary",       ordinal: 3,  school_level: "dimotiko" },
  { code: "dimotiko_4", label_el: "4η Δημοτικού", label_en: "4th Grade Primary",       ordinal: 4,  school_level: "dimotiko" },
  { code: "dimotiko_5", label_el: "5η Δημοτικού", label_en: "5th Grade Primary",       ordinal: 5,  school_level: "dimotiko" },
  { code: "dimotiko_6", label_el: "6η Δημοτικού", label_en: "6th Grade Primary",       ordinal: 6,  school_level: "dimotiko" },
  { code: "gymnasio_1", label_el: "1η Γυμνασίου", label_en: "1st Grade Middle School", ordinal: 7,  school_level: "gymnasio" },
  { code: "gymnasio_2", label_el: "2η Γυμνασίου", label_en: "2nd Grade Middle School", ordinal: 8,  school_level: "gymnasio" },
  { code: "gymnasio_3", label_el: "3η Γυμνασίου", label_en: "3rd Grade Middle School", ordinal: 9,  school_level: "gymnasio" },
  { code: "lykeio_1",   label_el: "1η Λυκείου",   label_en: "1st Grade High School",   ordinal: 10, school_level: "lykeio" },
  { code: "lykeio_2",   label_el: "2η Λυκείου",   label_en: "2nd Grade High School",   ordinal: 11, school_level: "lykeio" },
  { code: "lykeio_3",   label_el: "3η Λυκείου",   label_en: "3rd Grade High School",   ordinal: 12, school_level: "lykeio" },
];

const GREEK_BY_CODE = new Map(GREEK_TAXONOMY.map((r) => [r.code, r]));

const GENERIC_ORDINAL_BASE = 100;

function greekTaxonomyFor(code: string): GreekTaxonomyRow | null {
  return GREEK_BY_CODE.get(code) ?? null;
}

/**
 * Resolve (institution_id, code) → grade_levels.id, inserting the row if
 * missing. Returns `null` when `code` is null/empty (callers can pass through
 * without extra branching). Race-safe: a concurrent inserter racing on the
 * same (institution_id, code) will hit the UNIQUE constraint, and we re-select
 * on conflict.
 */
export async function resolveOrCreateGradeLevel(
  supabase: SupabaseClient,
  { institutionId, code }: ResolveArgs,
): Promise<string | null> {
  if (!institutionId) return null;
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) return null;

  // Fast path: existing row.
  const { data: existing, error: selectError } = await supabase
    .from("grade_levels")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("code", trimmed)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing?.id) return existing.id as string;

  // Missing — build the payload from the Greek taxonomy or fall back to generic.
  const greek = greekTaxonomyFor(trimmed);
  let payload: Record<string, unknown>;
  if (greek) {
    payload = {
      institution_id: institutionId,
      code: greek.code,
      label_el: greek.label_el,
      label_en: greek.label_en,
      ordinal: greek.ordinal,
      school_level: greek.school_level,
      is_generic: false,
    };
  } else {
    // Generic ordinal starts at 100 and increments per institution so it can
    // never collide with the 1-12 Greek ordinals inside the same institution.
    const { data: maxRow, error: maxError } = await supabase
      .from("grade_levels")
      .select("ordinal")
      .eq("institution_id", institutionId)
      .eq("is_generic", true)
      .order("ordinal", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxError) throw maxError;
    const nextOrdinal = maxRow?.ordinal
      ? Math.max(GENERIC_ORDINAL_BASE, (maxRow.ordinal as number) + 1)
      : GENERIC_ORDINAL_BASE;
    payload = {
      institution_id: institutionId,
      code: trimmed,
      label_el: trimmed,
      label_en: trimmed,
      ordinal: nextOrdinal,
      school_level: null,
      is_generic: true,
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("grade_levels")
    .insert(payload)
    .select("id")
    .maybeSingle();

  if (!insertError && inserted?.id) return inserted.id as string;

  // Race: a concurrent inserter won. Re-select — the UNIQUE(institution_id, code)
  // guarantees the row is there now. `23505` is Postgres unique_violation.
  // `ordinal` has no unique constraint, so any 23505 here is always a code conflict.
  if (insertError?.code !== "23505") throw insertError;

  const { data: raced, error: raceError } = await supabase
    .from("grade_levels")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("code", trimmed)
    .maybeSingle();
  if (raceError) throw raceError;
  return (raced?.id as string) ?? null;
}
