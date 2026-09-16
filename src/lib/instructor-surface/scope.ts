import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstructorClass, InstructorCourse, InstructorScope } from "./types";

/**
 * Resolve the courses this instructor teaches in the selected institution,
 * plus the class names behind each course's offerings (for the card kickers).
 *
 * Same derivation as `useClassManagement`: `course_instructors` → courses,
 * then offerings → classes, filtered to the current institution. Split
 * queries throughout — the student surface documents why embeds through
 * `offerings` are not to be trusted.
 */
/** The header's institution line: id + name of the selected institution. */
export async function loadInstitutionSummary(
  supabase: SupabaseClient,
  institutionId: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await supabase
    .from("institutions")
    .select("id, name")
    .eq("id", institutionId)
    .single();
  if (error) throw error;
  return data;
}

export async function loadInstructorScope(
  supabase: SupabaseClient,
  params: { userId: string; institutionId: string },
): Promise<InstructorScope> {
  const { userId, institutionId } = params;

  const { data: assignments, error: ciError } = await supabase
    .from("course_instructors")
    .select("course_id")
    .eq("user_id", userId);
  if (ciError) throw ciError;

  const empty: InstructorScope = {
    institutionId,
    courses: [],
    courseIds: [],
    classes: [],
    classNameByOffering: {},
    classIdByOffering: {},
    classIdsByCourse: {},
  };

  const assignedIds = [...new Set((assignments ?? []).map((a) => a.course_id))];
  if (assignedIds.length === 0) {
    return empty;
  }

  const { data: courseRows, error: courseError } = await supabase
    .from("courses")
    .select("id, title, description")
    .in("id", assignedIds)
    .eq("institution_id", institutionId)
    .order("title");
  if (courseError) throw courseError;

  const courseIds = (courseRows ?? []).map((c) => c.id);

  const classNamesByCourse: Record<string, string[]> = {};
  const classNameByOffering: Record<string, string> = {};
  const classIdByOffering: Record<string, string> = {};
  const classIdsByCourse: Record<string, string[]> = {};
  const classById: Record<string, InstructorClass> = {};
  if (courseIds.length > 0) {
    const { data: offeringRows, error: offeringError } = await supabase
      .from("offerings")
      .select("id, course_id, classes(id, name, institution_id, is_active)")
      .in("course_id", courseIds)
      .eq("is_active", true);
    if (offeringError) throw offeringError;

    for (const row of (offeringRows ?? []) as unknown as {
      id: string;
      course_id: string;
      classes: { id: string; name: string; institution_id: string; is_active: boolean } | null;
    }[]) {
      const cls = row.classes;
      if (!cls || cls.institution_id !== institutionId || !cls.is_active) continue;
      const names = (classNamesByCourse[row.course_id] ??= []);
      if (!names.includes(cls.name)) names.push(cls.name);
      classNameByOffering[row.id] = cls.name;
      classIdByOffering[row.id] = cls.id;
      const ids = (classIdsByCourse[row.course_id] ??= []);
      if (!ids.includes(cls.id)) ids.push(cls.id);
      classById[cls.id] = { id: cls.id, name: cls.name };
    }
  }

  const courses: InstructorCourse[] = (courseRows ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    classNames: (classNamesByCourse[c.id] ?? []).sort(),
  }));

  return {
    institutionId,
    courses,
    courseIds,
    classes: Object.values(classById).sort((a, b) => a.name.localeCompare(b.name)),
    classNameByOffering,
    classIdByOffering,
    classIdsByCourse,
  };
}
