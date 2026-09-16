/**
 * Resolve a student's enrolled offerings for a given course.
 *
 * Done as split queries because there is no FK between `offerings` and
 * `class_enrollments` (both only FK to `classes`), so a PostgREST embed
 * through `class_enrollments` errors at request time. This defect has
 * already bitten three call sites (#743, #750, #770) — every edge function
 * that needs "the student's offerings for a course" must go through these
 * helpers instead of re-inlining the bad embed.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface StudentOfferingRow {
  id: string;
  class_id: string;
}

export async function resolveStudentEnrolledOfferingsForCourse(
  supabase: SupabaseClient,
  params: { userId: string; courseId: string; activeOnly?: boolean },
): Promise<StudentOfferingRow[]> {
  const { userId, courseId, activeOnly = false } = params;

  const { data: enrollmentRows, error: enrollmentErr } = await supabase
    .from("class_enrollments")
    .select("class_id")
    .eq("user_id", userId);
  if (enrollmentErr) throw enrollmentErr;

  const classIds = ((enrollmentRows ?? []) as Array<{ class_id: string }>)
    .map((r) => r.class_id);
  if (classIds.length === 0) return [];

  let query = supabase
    .from("offerings")
    .select("id, class_id")
    .eq("course_id", courseId)
    .in("class_id", classIds);
  if (activeOnly) query = query.eq("is_active", true);

  const { data: offeringRows, error: offeringErr } = await query;
  if (offeringErr) throw offeringErr;
  return (offeringRows ?? []) as StudentOfferingRow[];
}

/**
 * Convenience wrapper — return the first active offering for the student in
 * the given course, or `null` when none.
 */
export async function resolveStudentActiveOfferingForCourse(
  supabase: SupabaseClient,
  params: { userId: string; courseId: string },
): Promise<StudentOfferingRow | null> {
  const rows = await resolveStudentEnrolledOfferingsForCourse(supabase, {
    ...params,
    activeOnly: true,
  });
  return rows[0] ?? null;
}
