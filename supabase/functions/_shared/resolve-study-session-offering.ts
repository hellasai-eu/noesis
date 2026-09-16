import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

/**
 * Which offering does this student's tutoring on this study session belong to?
 *
 * The open-question surface has always had an answer — `verifyQuestionEnrollment`
 * returns the offering the question was published through, and `runChatTurn`
 * stamps it onto the session — while the study-tutor surface returned only a
 * course. Every study-tutor `chat_sessions` row therefore carried
 * `offering_id = NULL`, and that is not merely a missing label: the write
 * policies on `chat_sessions` and `chat_messages` are
 * `instructor_can_access_student_work`, whose unattributed arm admits an
 * instructor only when they hold *no* `course_instructor_sections` rows for the
 * course. A section-restricted instructor could therefore read a study-tutor
 * transcript (staff SELECT is course-wide) but could not unpause it, delete it,
 * or post into it — while an institution admin, who bypasses both arms, could.
 * That asymmetry was the bug.
 *
 * Scope, not entitlement. Whether the caller may take a turn at all is a
 * separate question, decided by the subject's `authorize`; this only asks which
 * section the work sits in, so that the section-scoped policies have something
 * to decide on. It answers `null` rather than refusing whenever the answer is
 * not unambiguous, which leaves the row exactly as it is today.
 *
 * Split queries because there is no FK between `offerings` and
 * `class_enrollments` — both only reference `classes` — so a PostgREST embed
 * through the enrolment fails. Same shape, and same reason, as
 * `verify-question-enrollment.ts`.
 */
export async function resolveStudySessionOffering(
  supabase: SupabaseClient,
  params: { studySessionId: string; courseId: string; userId: string },
): Promise<string | null> {
  const { studySessionId, courseId, userId } = params;

  // Deliberately unfiltered by `published_at`. Publication decides whether the
  // student may work on the session, which is not what is being asked here: an
  // assignment row names the class this work is for either way, and the
  // enrolment join below is what makes the answer this student's own.
  const { data: assignmentRows, error: assignmentError } = await supabase
    .from("offering_study_sessions")
    .select("offering_id, offerings!inner(id, class_id, course_id)")
    .eq("study_session_id", studySessionId);

  if (assignmentError) {
    logger.warn("Failed to resolve the study session's offerings", {
      error: assignmentError.message,
      studySessionId,
    });
    return null;
  }

  const offeringByClass = new Map<string, string>();
  for (
    const row of (assignmentRows ?? []) as Array<{
      offering_id: string;
      offerings:
        | { id: string; class_id: string; course_id: string }
        | { id: string; class_id: string; course_id: string }[]
        | null;
    }>
  ) {
    const offering = Array.isArray(row.offerings) ? row.offerings[0] : row.offerings;
    // The offering must belong to the session's own course, because that is
    // what `instructor_can_access_student_work` requires of the pair before it
    // will read the offering at all.
    if (!offering?.class_id || offering.course_id !== courseId) continue;
    if (!row.offering_id) continue;
    offeringByClass.set(offering.class_id, row.offering_id);
  }

  if (offeringByClass.size === 0) return null;

  const { data: enrollmentRows, error: enrollmentError } = await supabase
    .from("class_enrollments")
    .select("class_id")
    .eq("user_id", userId)
    .eq("role", "student")
    .in("class_id", Array.from(offeringByClass.keys()));

  if (enrollmentError) {
    logger.warn("Failed to resolve the student's enrolment for a study session", {
      error: enrollmentError.message,
      studySessionId,
    });
    return null;
  }

  const candidates = new Set(
    ((enrollmentRows ?? []) as Array<{ class_id: string }>)
      .map((row) => offeringByClass.get(row.class_id))
      .filter((id): id is string => !!id),
  );

  // A student enrolled in two classes of the same course, both assigned this
  // session, leaves nothing in the data saying which section the tutoring
  // belongs to. Guessing would hand one instructor writes over the other's
  // pupil, so the row stays unattributed — the same answer the policies give a
  // row that names no offering.
  if (candidates.size !== 1) {
    if (candidates.size > 1) {
      logger.info("Study session offering is ambiguous; leaving the session unscoped", {
        studySessionId,
        candidates: candidates.size,
      });
    }
    return null;
  }

  return [...candidates][0];
}
