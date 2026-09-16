import type { SupabaseClient } from "@supabase/supabase-js";
import { GRADE_OPTIONS, getGradeLabel, type SchoolLevel } from "./greek-school";
import { collatorFor } from "@/i18n/formatters";

export interface GradeLevelRow {
  id: string;
  institution_id: string;
  code: string;
  label_el: string;
  label_en: string;
  ordinal: number;
  school_level: string | null;
  is_generic: boolean;
}

export interface GradeLevelOption {
  id: string;
  value: string;
  labelEl: string;
  labelEn: string;
  ordinal: number;
  schoolLevel: string | null;
  isGeneric: boolean;
}

/**
 * Turn `grade_levels` rows into dropdown options, sorted by ordinal.
 * `value` mirrors the historical `grade_level` code (Greek code or generic
 * label) so existing components that key by that string keep working.
 */
export function deriveGradeOptions(
  rows: GradeLevelRow[] | null | undefined,
): GradeLevelOption[] {
  return (rows ?? [])
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => ({
      id: r.id,
      value: r.code,
      labelEl: r.label_el,
      labelEn: r.label_en,
      ordinal: r.ordinal,
      schoolLevel: r.school_level,
      isGeneric: r.is_generic,
    }));
}

/**
 * Restrict institution grade options to a set of school levels. The backfill
 * seeds `grade_levels` rows across every school level, so an institution's full
 * option list can include grades outside the levels it actually offers (see
 * #825). Falls back to the full list when `schoolLevels` is empty/null, or when
 * filtering would leave nothing to pick, so the dropdown is never empty.
 */
export function filterGradeOptionsBySchoolLevels(
  options: GradeLevelOption[],
  schoolLevels: string[] | null | undefined,
): GradeLevelOption[] {
  if (!schoolLevels || schoolLevels.length === 0) return options;
  const filtered = options.filter(
    (o) => o.schoolLevel != null && schoolLevels.includes(o.schoolLevel),
  );
  return filtered.length > 0 ? filtered : options;
}

/**
 * Look up a `grade_levels.id` from a `code` (grade_level string). Returns
 * null when the code is missing or no matching row exists yet.
 */
export function findGradeLevelIdByCode(
  rows: GradeLevelRow[] | null | undefined,
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const row = (rows ?? []).find((r) => r.code === code);
  return row?.id ?? null;
}

/**
 * Look up a `grade_levels.code` from a `grade_levels.id`. The inverse of
 * `findGradeLevelIdByCode`; used by call sites that need the string code
 * (e.g. display helpers that key on the historical grade string) after
 * #799 dropped the denormalized `grade_level` TEXT column.
 */
export function findGradeCodeById(
  rows: GradeLevelRow[] | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  const row = (rows ?? []).find((r) => r.id === id);
  return row?.code ?? null;
}

/**
 * Render a grade label using the institution's `grade_levels` rows as the
 * source of truth. Generic grades render their real label from `label_el` /
 * `label_en` (that's the #798 acceptance criterion). Falls back to the fixed
 * Greek taxonomy for callers that don't have the rows yet — so nothing
 * renders blank during initial load.
 */
export function getGradeLabelFromRows(
  rows: GradeLevelRow[] | null | undefined,
  code: string | null | undefined,
  lang: string,
): string {
  if (!code) return "";
  const row = (rows ?? []).find((r) => r.code === code);
  if (row) return lang === "el" ? row.label_el : row.label_en;
  return getGradeLabel(code, lang);
}

export interface GradeLevelGroupById<C extends {
  id: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
} = {
  id: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
}> {
  gradeLevelId: string | null;
  gradeLevel: string;
  label: string;
  schoolLevel: string | null;
  ordinal: number;
  classes: C[];
}

/**
 * Group classes by `grade_level_id` — Labels come from the institution's
 * `grade_levels` rows, ordering from `ordinal`. Classes without a
 * `grade_level_id` are dropped from the result (the caller usually renders
 * them under a separate "Other classes" bucket).
 */
export function getGradeLevelGroupsById<
  C extends {
    id: string;
    grade_level_id: string | null;
    section_name: string | null;
    category: string | null;
  },
>(
  classes: C[],
  rows: GradeLevelRow[] | null | undefined,
  lang = "el",
): GradeLevelGroupById<C>[] {
  const rowMap = new Map((rows ?? []).map((r) => [r.id, r]));
  const groups = new Map<string, GradeLevelGroupById<C>>();

  for (const cls of classes) {
    if (!cls.grade_level_id) continue;
    let group = groups.get(cls.grade_level_id);
    if (!group) {
      const row = rowMap.get(cls.grade_level_id);
      group = {
        gradeLevelId: cls.grade_level_id,
        gradeLevel: row?.code ?? "",
        label: row
          ? lang === "el"
            ? row.label_el
            : row.label_en
          : "",
        schoolLevel: row?.school_level ?? null,
        ordinal: row?.ordinal ?? Number.MAX_SAFE_INTEGER,
        classes: [],
      };
      groups.set(cls.grade_level_id, group);
    }
    group.classes.push(cls);
  }

  const sorted = Array.from(groups.values()).sort((a, b) => {
    if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
    return collatorFor(lang).compare(a.label, b.label);
  });

  return sorted;
}

/**
 * SELECT-or-INSERT for a `(institution_id, code)` grade_level. Used by the two
 * grade-creation flows where the picked/typed grade may not yet exist as a
 * `grade_levels` row. Seeds Greek codes from the fixed taxonomy; generic
 * grades are self-labeled with `is_generic=true` and the next
 * per-institution ordinal starting at 100 (mirrors the backfill in
 * `20260708000000_grade_levels_expand.sql`).
 */
export async function ensureGradeLevel(
  supabase: SupabaseClient,
  institutionId: string,
  code: string,
): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from("grade_levels")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("code", code)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) return existing.id as string;

  const taxonomyIndex = GRADE_OPTIONS.findIndex((g) => g.value === code);
  const taxonomy = taxonomyIndex >= 0 ? GRADE_OPTIONS[taxonomyIndex] : null;

  let ordinal: number;
  if (taxonomy) {
    ordinal = taxonomyIndex + 1;
  } else {
    const { data: maxRow, error: maxError } = await supabase
      .from("grade_levels")
      .select("ordinal")
      .eq("institution_id", institutionId)
      .eq("is_generic", true)
      .order("ordinal", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxError) throw maxError;
    ordinal = (maxRow?.ordinal ?? 99) + 1;
  }

  const row = taxonomy
    ? {
        institution_id: institutionId,
        code,
        label_el: taxonomy.labelEl,
        label_en: taxonomy.labelEn,
        ordinal,
        school_level: taxonomy.level as SchoolLevel,
        is_generic: false,
      }
    : {
        institution_id: institutionId,
        code,
        label_el: code,
        label_en: code,
        ordinal,
        school_level: null,
        is_generic: true,
      };

  // ignoreDuplicates preserves any admin-customised labels if a race causes a
  // concurrent insert of the same (institution_id, code).
  const { error: insertError } = await supabase
    .from("grade_levels")
    .upsert(row, { onConflict: "institution_id,code", ignoreDuplicates: true });
  if (insertError) throw insertError;

  const { data: inserted, error: fetchError } = await supabase
    .from("grade_levels")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("code", code)
    .single();
  if (fetchError) throw fetchError;
  return inserted.id as string;
}
