import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

export type VerifyStudyGuideEnrollmentResult =
  | {
      ok: true;
      /**
       * Every open route authorizing this student has a `due_date` in the
       * past. The caller decides what that means: submissions from a student
       * with existing progress keep their grace period; a never-started
       * student is refused (the server-side twin of the locked student tile).
       */
      deadlinePassed: boolean;
    }
  | { ok: false; status: 403 | 500; error: string; code?: "guide_closed" };

/**
 * Verify that `userId` may submit study-guide answers for `(studyGuideId,
 * offeringId)`. The study-guide analogue of `verify-question-enrollment.ts`:
 * because the grader runs under the service role, `auth.uid()` is null there,
 * so the RLS helpers `has_offering_access` / `is_offering_group_member` can't
 * be relied on — this reproduces their checks explicitly with the known
 * `userId`. Split queries because there is no FK between `offerings` and
 * `class_enrollments`.
 *
 * The user qualifies when:
 *   1. a published `offering_study_guides` row exists for `(offering, guide)`,
 *   2. the user is enrolled in that offering's class, and
 *   3. group scoping passes — some published row is whole-class
 *      (`group_id IS NULL`) OR names an `offering_groups` group the user
 *      belongs to.
 *
 * Closure (20260910120000): a row with `closed_at` set no longer accepts
 * submissions. The scoping in step 3 is therefore evaluated twice — once over
 * every published row (may the user see this guide here at all?) and once
 * over the still-open rows (may they still submit?). Authorized-but-closed
 * returns the distinct `guide_closed` code so the player can say what
 * actually happened instead of "not authorized".
 */
export async function verifyStudyGuideEnrollment(
  supabase: SupabaseClient,
  params: { userId: string; studyGuideId: string; offeringId: string },
): Promise<VerifyStudyGuideEnrollmentResult> {
  const { userId, studyGuideId, offeringId } = params;

  const { data: assignmentRows, error: assignmentErr } = await supabase
    .from("offering_study_guides")
    .select("group_id, closed_at, due_date, offerings!inner(id, class_id)")
    .eq("offering_id", offeringId)
    .eq("study_guide_id", studyGuideId)
    .not("published_at", "is", null);

  if (assignmentErr) {
    logger.error("Failed to fetch study guide assignment", {
      error: assignmentErr.message,
      studyGuideId,
      offeringId,
      userId,
    });
    return { ok: false, status: 500, error: "Failed to verify enrollment" };
  }

  const rows = (assignmentRows ?? []) as Array<{
    group_id: string | null;
    closed_at: string | null;
    due_date: string | null;
    offerings:
      | { id: string; class_id: string }
      | { id: string; class_id: string }[]
      | null;
  }>;

  if (rows.length === 0) {
    return { ok: false, status: 403, error: "Not authorized for this study guide" };
  }

  // Every row shares the same offering, hence the same class.
  const first = Array.isArray(rows[0].offerings) ? rows[0].offerings[0] : rows[0].offerings;
  const classId = first?.class_id;
  if (!classId) {
    return { ok: false, status: 403, error: "Not authorized for this study guide" };
  }

  const { data: enrollmentRows, error: enrollErr } = await supabase
    .from("class_enrollments")
    .select("class_id")
    .eq("user_id", userId)
    .eq("class_id", classId)
    .limit(1);

  if (enrollErr) {
    logger.error("Study guide enrollment check failed", {
      error: enrollErr.message,
      studyGuideId,
      offeringId,
      userId,
    });
    return { ok: false, status: 500, error: "Failed to verify enrollment" };
  }

  if (!enrollmentRows || enrollmentRows.length === 0) {
    return { ok: false, status: 403, error: "Not authorized for this study guide" };
  }

  const closed = (): VerifyStudyGuideEnrollmentResult => ({
    ok: false,
    status: 403,
    code: "guide_closed",
    error: "This study guide has been marked as done and no longer accepts submissions.",
  });

  const openRows = rows.filter((r) => !r.closed_at);
  const expired = (r: { due_date: string | null }) =>
    !!r.due_date && new Date(r.due_date).getTime() < Date.now();

  // Group scoping: a whole-class row (group_id NULL) authorises everyone in
  // the class; otherwise the user must belong to one of the named groups.
  // Submission additionally needs that route to be OPEN. An open whole-class
  // row with a live deadline settles everything without a membership lookup;
  // an all-expired whole-class picture falls through, because an open group
  // row the student belongs to could still carry a later deadline.
  const openWholeClass = openRows.filter((r) => r.group_id === null);
  if (openWholeClass.some((r) => !expired(r))) {
    return { ok: true, deadlinePassed: false };
  }

  const groupIds = rows
    .map((r) => r.group_id)
    .filter((g): g is string => typeof g === "string");
  const wholeClass = rows.some((r) => r.group_id === null);
  if (!wholeClass && groupIds.length === 0) {
    return { ok: false, status: 403, error: "Not authorized for this study guide" };
  }

  // All memberships among the named groups (no limit — we must know WHICH
  // groups matched, to tell "not in any group" apart from "only in closed
  // ones").
  const memberGroupIds = new Set<string>();
  if (groupIds.length > 0) {
    const { data: memberships, error: memberErr } = await supabase
      .from("offering_group_members")
      .select("group_id")
      .eq("user_id", userId)
      .in("group_id", groupIds);

    if (memberErr) {
      logger.error("Study guide group membership check failed", {
        error: memberErr.message,
        studyGuideId,
        offeringId,
        userId,
      });
      return { ok: false, status: 500, error: "Failed to verify enrollment" };
    }
    for (const m of (memberships ?? []) as Array<{ group_id: string }>) {
      memberGroupIds.add(m.group_id);
    }
  }

  const authorized = wholeClass || memberGroupIds.size > 0;
  if (!authorized) {
    return { ok: false, status: 403, error: "Not authorized for this study guide" };
  }

  // Every open row that actually authorizes THIS student — open whole-class
  // rows plus open rows of groups they belong to. None → closed; some, all
  // past due → open but expired (the caller applies the grace-period rule).
  const authorizingOpen = openRows.filter(
    (r) => r.group_id === null || memberGroupIds.has(r.group_id),
  );
  if (authorizingOpen.length === 0) return closed();
  return { ok: true, deadlinePassed: authorizingOpen.every(expired) };
}
