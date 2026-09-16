import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

export type VerifyQuestionEnrollmentResult =
  | { ok: true; offeringId: string }
  | { ok: false; status: 403 | 500; error: string };

// Verify that `userId` may submit an answer for `questionId`. The user
// qualifies when at least one published `offering_questions` row exists for
// the question whose offering belongs to a class they're enrolled in. Runs
// as split queries because there is no FK between `offerings` and
// `class_enrollments` (both only FK to `classes`), so a PostgREST embed
// through `class_enrollments` fails — every grader must go through this
// helper instead of re-inlining the check.
export async function verifyQuestionEnrollment(
  supabase: SupabaseClient,
  params: { questionId: string; userId: string },
): Promise<VerifyQuestionEnrollmentResult> {
  const { questionId, userId } = params;

  const { data: offeringRows, error: offeringErr } = await supabase
    .from("offering_questions")
    .select("offering_id, group_id, offerings!inner(id, class_id)")
    .eq("question_id", questionId)
    .not("published_at", "is", null)
    .order("published_at", { ascending: false });

  if (offeringErr) {
    logger.error("Failed to fetch offerings for question", {
      error: offeringErr.message,
      questionId,
      userId,
    });
    return { ok: false, status: 500, error: "Failed to verify enrollment" };
  }

  // The group travels with the offering: a question can be published to one
  // group within a class rather than the whole class, and `group_id` is what
  // says so (#1158).
  //
  // EVERY published row is kept, not one per class. A question can be published
  // to the same class more than once — class-wide and to a group, or to two
  // groups — and collapsing to the newest would refuse a learner entitled by
  // one of the others. Entitlement is a question of whether ANY target reaches
  // them, so all of them have to survive to the check below.
  const classToTargets = new Map<string, Array<{ offeringId: string; groupId: string | null }>>();
  for (
    const row of (offeringRows ?? []) as Array<{
      offering_id: string;
      group_id: string | null;
      offerings:
        | { id: string; class_id: string }
        | { id: string; class_id: string }[]
        | null;
    }>
  ) {
    const offering = Array.isArray(row.offerings) ? row.offerings[0] : row.offerings;
    const classId = offering?.class_id;
    if (!classId || !row.offering_id) continue;
    const targets = classToTargets.get(classId) ?? [];
    targets.push({ offeringId: row.offering_id, groupId: row.group_id });
    classToTargets.set(classId, targets);
  }

  if (classToTargets.size === 0) {
    return { ok: false, status: 403, error: "Not authorized for this question" };
  }

  const { data: enrollmentRows, error: enrollErr } = await supabase
    .from("class_enrollments")
    .select("class_id")
    .eq("user_id", userId)
    .in("class_id", Array.from(classToTargets.keys()))
    .limit(1);

  if (enrollErr) {
    logger.error("Enrollment check failed", {
      error: enrollErr.message,
      questionId,
      userId,
    });
    return { ok: false, status: 500, error: "Failed to verify enrollment" };
  }

  if (!enrollmentRows || enrollmentRows.length === 0) {
    return { ok: false, status: 403, error: "Not authorized for this question" };
  }

  const enrolledClassId = (enrollmentRows[0] as { class_id: string }).class_id;
  const targets = classToTargets.get(enrolledClassId)!;

  // A class-wide target settles it: enrollment is the whole rule there, and no
  // membership lookup is needed.
  // `!t.groupId` rather than `=== null`: a row that simply carries no group is
  // class-wide too, and a strict null check would send it down the membership
  // path and refuse everyone.
  const classWide = targets.find((t) => !t.groupId);
  if (classWide) return { ok: true, offeringId: classWide.offeringId };

  // Otherwise every target is group-scoped, and the caller needs membership of
  // at least one of them. Enrollment in the class is necessary but not
  // sufficient, which is the point of group targeting.
  //
  // The `is_offering_group_member` RPC cannot be used: it resolves the caller
  // through `auth.uid()`, which is null under the service-role key every one of
  // these handlers runs on.
  const groupIds = targets.map((t) => t.groupId).filter((g): g is string => !!g);

  const { data: memberships, error: membershipErr } = await supabase
    .from("offering_group_members")
    .select("group_id")
    .eq("user_id", userId)
    .in("group_id", groupIds);

  if (membershipErr) {
    logger.error("Group membership check failed", {
      error: membershipErr.message,
      questionId,
      userId,
    });
    return { ok: false, status: 500, error: "Failed to verify enrollment" };
  }

  const memberOf = new Set(
    ((memberships ?? []) as Array<{ group_id: string }>).map((m) => m.group_id),
  );
  const entitling = targets.find((t) => t.groupId && memberOf.has(t.groupId));

  if (!entitling) {
    return { ok: false, status: 403, error: "Not authorized for this question" };
  }

  return { ok: true, offeringId: entitling.offeringId };
}
