import type { SupabaseClient } from "@supabase/supabase-js";
import type { StudentScope, SurfaceClass, SurfaceCourse } from "./types";

/**
 * Resolve everything the rest of the surface hangs off: the student's active
 * classes in this institution, the offerings those classes carry, and the
 * courses behind them.
 *
 * Split queries, never a PostgREST embed from `class_enrollments` through to
 * `offerings`: there is no FK between them (both only reference `classes`), so
 * the embed errors at request time. That defect has bitten four call sites —
 * see `lib/student-offerings.ts`, which does the same job for a single course.
 */
export async function loadStudentScope(
  supabase: SupabaseClient,
  params: { userId: string; institutionId: string },
): Promise<StudentScope> {
  const { userId, institutionId } = params;

  const { data: enrollments, error: enrollmentError } = await supabase
    .from("class_enrollments")
    .select(
      `class_id, role,
       classes!inner(id, name, grade_level_id, section_name, category, academic_period, institution_id, is_active)`,
    )
    .eq("user_id", userId)
    .eq("role", "student");
  if (enrollmentError) throw enrollmentError;

  const classes: SurfaceClass[] = ((enrollments ?? []) as unknown as {
    classes: SurfaceClass & { institution_id: string; is_active: boolean };
  }[])
    .map((row) => row.classes)
    .filter((c) => c && c.institution_id === institutionId && c.is_active === true)
    .map((c) => ({
      id: c.id,
      name: c.name,
      grade_level_id: c.grade_level_id,
      section_name: c.section_name,
      category: c.category,
      academic_period: c.academic_period,
    }));

  const classIds = classes.map((c) => c.id);

  let offeringRows: { id: string; class_id: string; course_id: string }[] = [];
  if (classIds.length > 0) {
    const { data, error } = await supabase
      .from("offerings")
      .select("id, class_id, course_id")
      .in("class_id", classIds)
      .eq("is_active", true);
    if (error) throw error;
    offeringRows = (data ?? []) as typeof offeringRows;
  }

  const offeringsByCourse: Record<string, string[]> = {};
  const courseByOffering: Record<string, string> = {};
  for (const row of offeringRows) {
    (offeringsByCourse[row.course_id] ??= []).push(row.id);
    courseByOffering[row.id] = row.course_id;
  }

  const { data: courseRows, error: courseError } = await supabase
    .from("courses")
    .select("id, title, description, theme")
    .eq("institution_id", institutionId)
    .order("title");
  if (courseError) throw courseError;

  const allCourses = (courseRows ?? []) as SurfaceCourse[];
  const enrolledCourses = allCourses.filter((c) => offeringsByCourse[c.id]?.length);

  // A course the student has no offering for can carry no assignment, no
  // practice and no cards — as a chip it would only ever be empty, so the
  // surface lists the courses they are actually taking. The fallback keeps
  // institutions that publish courses without offerings working exactly as the
  // old dashboard did, rather than showing such a student an empty page.
  const courses = enrolledCourses.length > 0 ? enrolledCourses : allCourses;

  return {
    institutionId,
    classes,
    courses,
    offeringIds: offeringRows.map((o) => o.id),
    offeringsByCourse,
    courseByOffering,
  };
}
