/**
 * Resolve the offerings a student is enrolled in for a given course.
 *
 * Done as split queries because there is no FK between `offerings` and
 * `class_enrollments` (both only FK to `classes`), so a PostgREST embed
 * through `class_enrollments` errors at request time. This defect has
 * already bitten three call sites (#743, #750, #770) — every frontend
 * call site that needs "the student's offerings for a course" must go
 * through this helper instead of re-inlining the bad embed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface StudentOfferingRow {
  id: string;
  class_id: string;
}

export async function resolveStudentEnrolledOfferingsForCourse(
  supabase: SupabaseClient,
  params: { userId: string; courseId: string },
): Promise<StudentOfferingRow[]> {
  const { userId, courseId } = params;
  const { data: enrollmentRows, error: enrollmentErr } = await supabase
    .from("class_enrollments")
    .select("class_id")
    .eq("user_id", userId);
  if (enrollmentErr) throw enrollmentErr;

  const classIds = (enrollmentRows ?? []).map(
    (r) => (r as { class_id: string }).class_id,
  );
  if (classIds.length === 0) return [];

  const { data: offeringRows, error: offeringErr } = await supabase
    .from("offerings")
    .select("id, class_id")
    .eq("course_id", courseId)
    .in("class_id", classIds);
  if (offeringErr) throw offeringErr;

  return (offeringRows ?? []) as StudentOfferingRow[];
}
