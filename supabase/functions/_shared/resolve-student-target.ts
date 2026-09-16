import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ensureIndividualGroup } from "./individual-group.ts";
import { buildStudentSnapshot } from "./student-snapshot.ts";
import { logger } from "./logger.ts";

export interface ResolvedStudentTarget {
  targetGroupId: string;
  groupAudienceHintText: string;
  resolvedTarget: {
    kind: "student";
    offering_id: string;
    group_id: string;
    student_user_id: string;
    student_full_name: string | null;
    used_admin_notes: boolean;
  };
}

export type ResolveStudentTargetResult =
  | { ok: true; data: ResolvedStudentTarget | null }
  | { ok: false; reason: "forbidden" | "unavailable" };

/**
 * Map a failed resolution to the HTTP response every question-generation
 * handler should return: 403 for a caller without access, 503 when the
 * snapshot could not be built safely (profile read failed, so the PII
 * redaction backstop has no name tokens — targeted generation is aborted
 * rather than silently produced without personalization).
 */
export function studentTargetErrorResponse(
  result: { ok: false; reason: "forbidden" | "unavailable" },
  corsHeaders: Record<string, string>,
): Response {
  if (result.reason === "unavailable") {
    return new Response(
      JSON.stringify({
        error: "The student's profile could not be read, so targeted generation was not run. Please try again.",
      }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ error: "Forbidden: you do not have permission to generate questions for this student" }),
    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Resolve a targeted student for question generation.
 *
 * Uses `serviceClient` (service role) for data reads/writes and `authedClient`
 * (caller's JWT) to enforce `can_manage_offering` RLS — the same guard used in
 * `cluster-students-by-performance`. Returns `{ ok: false, reason: "forbidden" }`
 * when the caller can't manage the offering, `{ ok: false, reason: "unavailable" }`
 * when the snapshot cannot be built safely, or `{ ok: true, data: null }` when
 * the student isn't enrolled.
 */
export async function resolveStudentTarget(
  serviceClient: SupabaseClient,
  authedClient: SupabaseClient,
  courseId: string,
  targetStudentUserId: string,
): Promise<ResolveStudentTargetResult> {
  // 1. Find which offering this student is in for this course.
  const { data: enrollmentRow, error: enrollmentErr } = await serviceClient
    .from("class_enrollments")
    .select("class_id, offerings!inner(id, course_id, class_id, is_active)")
    .eq("user_id", targetStudentUserId)
    .eq("role", "student")
    .eq("offerings.course_id", courseId)
    .eq("offerings.is_active", true)
    .limit(1)
    .maybeSingle();

  if (enrollmentErr) {
    logger.warn("Failed to resolve offering for targeted student; ignoring", {
      targetStudentUserId,
      error: enrollmentErr.message,
    });
  }

  // deno-lint-ignore no-explicit-any
  const offering = (enrollmentRow as any)?.offerings;
  const resolvedOfferingId = Array.isArray(offering) ? offering[0]?.id : offering?.id;

  if (!resolvedOfferingId) {
    logger.warn("Targeted student is not enrolled in any class for this course; ignoring", {
      targetStudentUserId,
    });
    return { ok: true, data: null };
  }

  // 2. Verify the caller has can_manage_offering access via the RLS-respecting authed client.
  const { data: offeringCheck } = await authedClient
    .from("offerings")
    .select("id")
    .eq("id", resolvedOfferingId)
    .maybeSingle();

  if (!offeringCheck) {
    logger.warn("Authorization check failed: caller cannot manage offering for targeted student", {
      targetStudentUserId,
      resolvedOfferingId,
    });
    return { ok: false, reason: "forbidden" };
  }

  // 3. Ensure the hidden singleton group and build the student performance snapshot.
  try {
    const { group_id } = await ensureIndividualGroup(serviceClient, resolvedOfferingId, targetStudentUserId);
    const snapshot = await buildStudentSnapshot(serviceClient, courseId, targetStudentUserId);

    if (!snapshot) {
      // The snapshot fails closed when the profile read errors (the PII
      // redaction backstop has no name tokens). Abort targeted generation
      // rather than record generic questions as targeted to this student.
      logger.warn("Student snapshot unavailable; aborting targeted generation", {
        student_user_id: targetStudentUserId,
        offering_id: resolvedOfferingId,
      });
      return { ok: false, reason: "unavailable" };
    }

    const groupAudienceHintText = "TARGETED STUDENT:\n" + snapshot.hint;
    logger.info("Targeting individual student", {
      student_user_id: targetStudentUserId,
      offering_id: resolvedOfferingId,
      singleton_group_id: group_id,
      used_admin_notes: snapshot.used_admin_notes,
      total_quiz_answers: snapshot.total_quiz_answers,
    });

    return {
      ok: true,
      data: {
        targetGroupId: group_id,
        groupAudienceHintText,
        resolvedTarget: {
          kind: "student",
          offering_id: resolvedOfferingId,
          group_id,
          student_user_id: targetStudentUserId,
          student_full_name: snapshot.full_name,
          used_admin_notes: snapshot.used_admin_notes,
        },
      },
    };
  } catch (e) {
    logger.error("Failed to ensure individual offering group; falling back to ungrouped", {
      error: e instanceof Error ? e.message : String(e),
      targetStudentUserId,
    });
    return { ok: true, data: null };
  }
}
