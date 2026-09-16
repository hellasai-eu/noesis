export type InstitutionType = "generic" | "greek_school";
export type SchoolLevel = "dimotiko" | "gymnasio" | "lykeio";

export const GREEK_SCHOOL_LEVELS: {
  id: SchoolLevel;
  labelEl: string;
  labelEn: string;
  years: number;
}[] = [
  { id: "dimotiko", labelEl: "Δημοτικό", labelEn: "Primary School", years: 6 },
  { id: "gymnasio", labelEl: "Γυμνάσιο", labelEn: "Middle School", years: 3 },
  { id: "lykeio", labelEl: "Λύκειο", labelEn: "High School", years: 3 },
];

export const ALL_SCHOOL_LEVELS: SchoolLevel[] = GREEK_SCHOOL_LEVELS.map((l) => l.id);

export type GradeLevel =
  | "dimotiko_1" | "dimotiko_2" | "dimotiko_3"
  | "dimotiko_4" | "dimotiko_5" | "dimotiko_6"
  | "gymnasio_1" | "gymnasio_2" | "gymnasio_3"
  | "lykeio_1" | "lykeio_2" | "lykeio_3";

export const GRADE_OPTIONS: {
  value: GradeLevel;
  level: SchoolLevel;
  year: number;
  labelEl: string;
  labelEn: string;
}[] = [
  { value: "dimotiko_1", level: "dimotiko", year: 1, labelEl: "1η Δημοτικού", labelEn: "1st Grade Primary" },
  { value: "dimotiko_2", level: "dimotiko", year: 2, labelEl: "2η Δημοτικού", labelEn: "2nd Grade Primary" },
  { value: "dimotiko_3", level: "dimotiko", year: 3, labelEl: "3η Δημοτικού", labelEn: "3rd Grade Primary" },
  { value: "dimotiko_4", level: "dimotiko", year: 4, labelEl: "4η Δημοτικού", labelEn: "4th Grade Primary" },
  { value: "dimotiko_5", level: "dimotiko", year: 5, labelEl: "5η Δημοτικού", labelEn: "5th Grade Primary" },
  { value: "dimotiko_6", level: "dimotiko", year: 6, labelEl: "6η Δημοτικού", labelEn: "6th Grade Primary" },
  { value: "gymnasio_1", level: "gymnasio", year: 1, labelEl: "1η Γυμνασίου", labelEn: "1st Grade Middle School" },
  { value: "gymnasio_2", level: "gymnasio", year: 2, labelEl: "2η Γυμνασίου", labelEn: "2nd Grade Middle School" },
  { value: "gymnasio_3", level: "gymnasio", year: 3, labelEl: "3η Γυμνασίου", labelEn: "3rd Grade Middle School" },
  { value: "lykeio_1", level: "lykeio", year: 1, labelEl: "1η Λυκείου", labelEn: "1st Grade High School" },
  { value: "lykeio_2", level: "lykeio", year: 2, labelEl: "2η Λυκείου", labelEn: "2nd Grade High School" },
  { value: "lykeio_3", level: "lykeio", year: 3, labelEl: "3η Λυκείου", labelEn: "3rd Grade High School" },
];

export function gradeOptionsForLevels(levels: SchoolLevel[]) {
  return GRADE_OPTIONS.filter((g) => levels.includes(g.level));
}

export interface StarterClass {
  name: string;
  institution_id: string;
  grade_code: string;
  section_name: string | null;
  is_active: boolean;
  created_by: string;
}

// Default grade name seeded for new generic institutions.
export const GENERIC_DEFAULT_GRADE = "General";

/**
 * Starter class templates seeded when an institution is created so it's
 * usable right away:
 * - greek_school → one section "Α" per grade across the selected school levels.
 * - generic → a single default "General" grade with one section, so the admin can
 *   immediately add sections and attach courses under it.
 *
 * Templates carry `grade_code` (the grade_levels.code) rather than a
 * grade_level_id — the caller resolves each code to an id via ensureGradeLevel
 * before the classes insert. The TEXT `grade_level` column no longer exists
 * (see migration 20260710000000_grade_levels_contract.sql).
 */
export function buildStarterClasses(
  institutionType: InstitutionType,
  schoolLevels: SchoolLevel[],
  lang: string,
  institutionId: string,
  createdBy: string,
): StarterClass[] {
  if (institutionType === "greek_school") {
    return gradeOptionsForLevels(schoolLevels).map((g) => ({
      name: lang === "el" ? g.labelEl : g.labelEn,
      institution_id: institutionId,
      grade_code: g.value,
      section_name: "Α",
      is_active: true,
      created_by: createdBy,
    }));
  }

  return [
    {
      name: `${GENERIC_DEFAULT_GRADE} - Section 1`,
      institution_id: institutionId,
      grade_code: GENERIC_DEFAULT_GRADE,
      section_name: "1",
      is_active: true,
      created_by: createdBy,
    },
  ];
}

export function getGradeLabel(grade: string, lang: string): string {
  const opt = GRADE_OPTIONS.find((g) => g.value === grade);
  if (!opt) return grade;
  return lang === "el" ? opt.labelEl : opt.labelEn;
}

// Section letters for Greek school τμήματα
export const SECTION_LETTERS = ["Α", "Β", "Γ", "Δ", "Ε", "ΣΤ", "Ζ", "Η", "Θ"] as const;

/** True when grade_level belongs to the fixed Greek taxonomy (vs a free-text generic grade). */
export function isGreekGradeLevel(gradeLevel: string | null | undefined): boolean {
  return !!gradeLevel && GRADE_OPTIONS.some((g) => g.value === gradeLevel);
}

/**
 * Next auto-numbered section name for a generic grade: max existing numeric
 * section + 1, as a string ("1", "2", …). Non-numeric section names are ignored.
 */
export function nextGenericSectionName(existing: (string | null | undefined)[]): string {
  let max = 0;
  for (const s of existing) {
    if (!s) continue;
    const n = parseInt(s, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * Build a short display name like "1Α" or "3Β" from a grade_level + section_name.
 */
export function getSectionDisplayName(gradeLevel: string, sectionName: string): string {
  const opt = GRADE_OPTIONS.find((g) => g.value === gradeLevel);
  if (!opt) return sectionName;
  return `${opt.year}${sectionName}`;
}

/**
 * Build a full class display name like "1η Δημοτικού – Τμήμα 1Α" from a class object.
 * For categorized sections, appends the category: "1η Δημοτικού – Τμήμα 1Α (English)"
 */
export function buildClassDisplayName(
  cls: { grade_level?: string | null; section_name?: string | null; category?: string | null; name?: string | null } | null | undefined,
): string {
  if (cls?.grade_level && cls?.section_name) {
    const base = isGreekGradeLevel(cls.grade_level)
      ? `${getGradeLabel(cls.grade_level, "el")} – Τμήμα ${getSectionDisplayName(cls.grade_level, cls.section_name)}`
      : `${cls.grade_level} – Section ${cls.section_name}`;
    return cls.category ? `${base} (${cls.category})` : base;
  }
  return cls?.name || "Unknown";
}

/**
 * Build a compact class display name like "Τμήμα 1Α" (section only) from a class object.
 * For categorized sections, appends the category: "Τμήμα 1Α (English)"
 * Falls back to the full display name only when there is no section to show.
 *
 * Two shapes reach this function. Callers that still carry the legacy
 * `grade_level` TEXT can render the year-prefixed section ("Τμήμα 1Α").
 * Callers built from the `classes` table cannot: `grade_level` became the
 * `grade_level_id` FK to `grade_levels`, so the first branch never matches for
 * them and every real class fell through to `cls.name` — which is the stored
 * *full* name ("3η Λυκείου – Section 1"). That made the "compact" variant a
 * no-op wherever it mattered. The second branch renders the section alone from
 * `section_name`, which is present on both shapes. The grade is deliberately
 * not resolved from `grade_level_id`: the point of this variant is to omit it.
 */
export function buildCompactClassDisplayName(
  cls: { grade_level?: string | null; section_name?: string | null; category?: string | null; name?: string | null } | null | undefined,
): string {
  if (cls?.grade_level && cls?.section_name) {
    const base = isGreekGradeLevel(cls.grade_level)
      ? `Τμήμα ${getSectionDisplayName(cls.grade_level, cls.section_name)}`
      : `Section ${cls.section_name}`;
    return cls?.category ? `${base} (${cls.category})` : base;
  }
  if (cls?.section_name) {
    const base = `Section ${cls.section_name}`;
    return cls.category ? `${base} (${cls.category})` : base;
  }
  return buildClassDisplayName(cls);
}

