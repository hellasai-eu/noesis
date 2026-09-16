import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface AcceptInvitationRequest {
  invitationId: string;
}

/** Case- and whitespace-insensitive email comparison. */
const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // `userId` used to be read from the body. It is deliberately ignored now —
    // see the authentication gate below.
    const { invitationId } = await req.json() as AcceptInvitationRequest;

    if (!invitationId) {
      return json({ error: "Missing invitationId" }, 400);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // ── Authentication ────────────────────────────────────────────────────
    // The accepting user is whoever holds the bearer token, never whoever the
    // request body names. The previous version took `userId` from the body and
    // bound it to a body-supplied `invitationId`, so an anonymous caller could
    // grant any account the role and institution of any invitation (#1135).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth
      .getUser(token);

    if (authError || !callerUser) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(callerUser, token)) {
      return json({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
    }

    const userId = callerUser.id;
    logger.info("Processing invitation acceptance", { invitationId, userId });

    // 1. Fetch the invitation with all details
    const { data: invitation, error: invitationError } = await supabaseAdmin
      .from("invitations")
      .select("id, email, institution_id, role, invited_class_id, invited_grade_level_id, status")
      .eq("id", invitationId)
      .single();

    if (invitationError || !invitation) {
      logger.error("Failed to fetch invitation", { error: invitationError?.message });
      return json({ error: "Invitation not found" }, 404);
    }

    logger.setContext({ institutionId: invitation.institution_id, userId });

    // ── Authorization ─────────────────────────────────────────────────────
    // An invitation is addressed to one email. Only the account that owns that
    // address may redeem it. All three call sites already match the invitation
    // to the signed-in user's email client-side; this is the same rule, stated
    // where it cannot be skipped.
    if (!sameEmail(invitation.email as string, callerUser.email)) {
      logger.warn("Invitation redeemed by a different address than it was issued to", {
        invitationId,
        userId,
      });
      return json({ error: "This invitation was issued to a different email address" }, 403);
    }

    logger.info("Found invitation", {
      id: invitation.id,
      role: invitation.role,
      status: invitation.status,
      invited_class_id: invitation.invited_class_id,
    });

    // 2. Does the caller already hold membership? Needed twice below: to keep
    //    the grant idempotent, and to answer a replay of a spent invitation.
    const { data: existingMembership } = await supabaseAdmin
      .from("user_institutions")
      .select("id")
      .eq("user_id", userId)
      .eq("institution_id", invitation.institution_id)
      .maybeSingle();

    // 3. Claim the invitation BEFORE granting anything. The compare-and-swap is
    //    the gate — not the `status` read a moment ago — for two reasons:
    //
    //    * Cancelling an invitation deletes the row (Dashboard.tsx:566,
    //      UserManagement.tsx:855), so a cancellation landing between that
    //      SELECT and these writes would otherwise still be honoured.
    //    * It makes an invitation spendable exactly once. An accepted one can
    //      no longer be replayed to restore access an admin has since removed —
    //      `handleRemoveUser` deletes the membership and the invitation in two
    //      separate non-transactional statements, and skips the second entirely
    //      when the profile carries no email.
    //
    //    What the claim does NOT cover: once it has committed, a cancellation
    //    landing before the grants below still loses, because the delete is
    //    unconditional and nothing locks the row. Closing that needs the claim
    //    and the grants in one transaction — a SECURITY DEFINER function with
    //    SELECT ... FOR UPDATE, tracked in #1148. The window is the gap between
    //    two HTTP requests, and the party it favours is the invited user
    //    mid-acceptance rather than an attacker, so it is logged and left.
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invitationId)
      .eq("status", "pending")
      .select("id");

    if (claimError) {
      logger.error("Failed to claim invitation", { error: claimError.message });
      return json({ error: "Failed to accept invitation" }, 500);
    }

    if (!claimed || claimed.length === 0) {
      // Already spent, cancelled, or another request won the race. Confirm
      // success only if the membership it created still stands — so a double
      // submit stays green, while a replay after removal is refused rather
      // than quietly handing the access back.
      //
      // Re-read rather than reusing the snapshot from before the claim. A
      // membership removed in between would otherwise turn a refusal into a
      // success the caller acts on, navigating into an institution it no
      // longer belongs to. Nothing is granted either way; the cost of being
      // wrong here is a misleading 200, not access.
      const { data: membershipNow } = await supabaseAdmin
        .from("user_institutions")
        .select("id")
        .eq("user_id", userId)
        .eq("institution_id", invitation.institution_id)
        .maybeSingle();

      if (membershipNow) {
        logger.info("Invitation already accepted and its membership still stands");
        return json({
          success: true,
          message: "Invitation already accepted",
          membership: {
            institution_id: invitation.institution_id,
            role: invitation.role,
          },
          class_enrolled: (invitation.invited_class_id as string | null) ?? null,
        }, 200);
      }

      logger.warn("Refused to replay a spent or cancelled invitation", {
        invitationId,
        userId,
      });
      return json({ error: "This invitation is no longer valid" }, 409);
    }

    logger.info("Claimed invitation", { invitationId });

    if (existingMembership) {
      logger.info("User already has membership, skipping creation");
    } else {
      // The invitation was created with invited_grade_level_id already
      // populated (#799 dropped the TEXT column), so we just copy the FK.
      // 4. Create user_institutions entry
      const { error: membershipError } = await supabaseAdmin
        .from("user_institutions")
        .insert({
          user_id: userId,
          institution_id: invitation.institution_id,
          role: invitation.role,
          grade_level_id: invitation.invited_grade_level_id ?? null,
        });

      if (membershipError) {
        logger.error("Failed to create membership", { error: membershipError.message });

        // Before releasing the claim, establish that the membership really is
        // absent. `user_institutions` is UNIQUE(user_id, institution_id)
        // (20251206091421_…sql:8), so another writer creating it between the
        // lookup above and this insert arrives here as a failed insert even
        // though the invitation has in fact been fulfilled. Releasing the claim
        // then would re-open a spent invitation — handing back precisely the
        // replay-after-removal that claiming exists to prevent.
        const { data: membershipNow } = await supabaseAdmin
          .from("user_institutions")
          .select("id")
          .eq("user_id", userId)
          .eq("institution_id", invitation.institution_id)
          .maybeSingle();

        if (membershipNow) {
          logger.info("Membership already existed; keeping the claim spent");
        } else {
          // Hand the invitation back. The claim above is the only record that
          // it was spent, and it bought nothing — leaving it accepted would
          // strand the invitee with no membership and no way to retry.
          const { error: rollbackError } = await supabaseAdmin
            .from("invitations")
            .update({ status: "pending", accepted_at: null })
            .eq("id", invitationId);
          if (rollbackError) {
            logger.error("Failed to release the claimed invitation", {
              invitationId,
              error: rollbackError.message,
            });
          }
          return json(
            { error: "Failed to create membership", details: membershipError.message },
            500,
          );
        }
      } else {
        logger.info("Created user_institutions entry", { role: invitation.role });
      }
    }

    // 5. Create class enrollment if invited_class_id is specified
    const invitedClassId = invitation.invited_class_id as string | null;
    if (invitedClassId) {
      logger.info("Creating class enrollment", { classId: invitedClassId });

      // Check if enrollment already exists
      const { data: existingEnrollment } = await supabaseAdmin
        .from("class_enrollments")
        .select("class_id")
        .eq("user_id", userId)
        .eq("class_id", invitedClassId)
        .maybeSingle();

      if (existingEnrollment) {
        logger.info("User already enrolled in class, skipping");
      } else {
        // Map invitation role to class enrollment role
        // admin -> instructor, instructor -> instructor, student -> student
        const classRole = invitation.role === "admin" ? "instructor" : invitation.role;

        const { error: enrollmentError } = await supabaseAdmin
          .from("class_enrollments")
          .insert({
            user_id: userId,
            class_id: invitedClassId,
            role: classRole,
          });

        if (enrollmentError) {
          logger.error("Failed to create class enrollment", { error: enrollmentError.message });
          // Don't fail the whole operation, just log the error
          // Enrollment is secondary to membership
        } else {
          logger.info("Successfully enrolled user in class", { role: classRole });
        }
      }
    } else {
      logger.info("No class enrollment to create");
    }

    // 6. For evaluator invitations, replay invitation_courses into
    // course_evaluators so the user is scoped to the courses the admin picked.
    if (invitation.role === "evaluator") {
      const { data: invitationCourses, error: invitationCoursesError } = await supabaseAdmin
        .from("invitation_courses")
        .select("course_id")
        .eq("invitation_id", invitationId);

      if (invitationCoursesError) {
        logger.error("Failed to fetch invitation_courses", {
          error: invitationCoursesError.message,
        });
      } else if (invitationCourses && invitationCourses.length > 0) {
        const rows = invitationCourses.map((ic: { course_id: string }) => ({
          course_id: ic.course_id,
          user_id: userId,
        }));
        const { error: evaluatorInsertError } = await supabaseAdmin
          .from("course_evaluators")
          .upsert(rows, { onConflict: "course_id,user_id", ignoreDuplicates: true });
        if (evaluatorInsertError) {
          logger.error("Failed to insert course_evaluators", {
            error: evaluatorInsertError.message,
          });
        } else {
          logger.info("Created course_evaluators entries", { count: rows.length });
        }
      } else {
        logger.info("Evaluator invitation has no course assignments");
      }
    }

    logger.info("Invitation acceptance completed successfully");

    return json({
      success: true,
      message: "Invitation accepted successfully",
      membership: {
        institution_id: invitation.institution_id,
        role: invitation.role,
      },
      class_enrolled: invitedClassId || null,
    }, 200);
  } catch (error) {
    logger.exception(error, "Unexpected error");
    return json({ error: "Internal server error", details: String(error) }, 500);
  }
};
