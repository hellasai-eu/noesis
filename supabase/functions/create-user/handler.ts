import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { resolveOrCreateGradeLevel } from "../_shared/grade-levels.ts";
import { recordAudit } from "../_shared/audit.ts";
import { checkInstitutionAdmin } from "../_shared/institution-authz.ts";
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

/**
 * Roles this endpoint may write into `user_institutions`, mirroring the CHECK
 * constraint added in 20260624100000. Rejecting an unknown role up front —
 * rather than letting the INSERT fail — keeps a crafted request from creating
 * an auth user that then has to be rolled back. There is deliberately no
 * super-admin value: that role lives in `super_admins`, keyed by email, not in
 * a membership row, so it is not reachable from this endpoint at all.
 */
const ASSIGNABLE_ROLES = new Set(["admin", "instructor", "student", "evaluator"]);

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, password, fullName, institutionId, role, classId, gradeLevel, fatherName, dateOfBirth, courseIds } = await req.json();

    if (!email || !password || !institutionId) {
      return json({ error: "Email, password, and institutionId are required" }, 400);
    }

    if (password.length < 8) {
      return json({ error: "Password must be at least 8 characters" }, 400);
    }

    const requestedRole: string = role || "student";
    if (!ASSIGNABLE_ROLES.has(requestedRole)) {
      return json({ error: "Invalid role" }, 400);
    }

    // Create admin client with service role key
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );

    // ── Authentication + authorization gate (#926) ─────────────────────────
    // This function runs with `verify_jwt = false` and mints a fully confirmed
    // auth user carrying a CALLER-SUPPLIED role, using the service-role key, so
    // the checks below are the only thing between an anonymous request and a
    // privileged account in an arbitrary institution. They must stay ahead of
    // every side effect in this handler.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !callerUser) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(callerUser, token)) {
      return json({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
    }

    // `checkInstitutionAdmin` ORs in `is_super_admin`, so one call covers both
    // cases: a super-admin passes for any institution, an institution admin
    // only for their own. That — the institution, not the role — is the
    // escalation boundary here, matching what the Create User dialog already
    // offers an institution admin. The RPC also excludes suspended
    // memberships, so a suspended admin is refused.
    // A check that could not be PERFORMED is not one that said no (#1155).
    const adminCheck = await checkInstitutionAdmin(supabaseAdmin, callerUser.id, institutionId);
    if (!adminCheck.ok) {
      logger.error("Failed to check institution admin status", { error: adminCheck.error });
      return json({ error: "Failed to check authorization" }, 500);
    }
    if (!adminCheck.allowed) {
      logger.warn("Unauthorized user creation attempt", {
        callerId: callerUser.id,
        institutionId,
      });
      return json(
        { error: "You are not authorized to create users in this institution" },
        403,
      );
    }

    const actorUserId: string = callerUser.id;
    const actorEmail: string | null = callerUser.email ?? null;

    // A `classId` is NOT covered by the institution gate: an admin of
    // institution A could otherwise enrol the new account into a class of
    // institution B, exactly as the evaluator `courseIds` check further down
    // prevents for courses. Verified before the auth user exists, so a bad id
    // costs nothing to unwind.
    if (classId) {
      const { data: targetClass, error: classLookupError } = await supabaseAdmin
        .from("classes")
        .select("id")
        .eq("id", classId)
        .eq("institution_id", institutionId)
        .maybeSingle();

      if (classLookupError) {
        logger.error("Failed to verify class ownership", { error: classLookupError.message });
        return json({ error: "Failed to verify class" }, 500);
      }

      if (!targetClass) {
        logger.warn("classId did not belong to institution", { classId, institutionId });
        return json({ error: "The selected class does not belong to this institution" }, 400);
      }
    }

    logger.info("Creating user", { email, institutionId, role: requestedRole });

    // Check if user already exists
    const endCheckTimer = logger.startTimer("check-existing-user");
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === email);
    endCheckTimer();

    if (existingUser) {
      logger.warn("User already exists", { email });
      return new Response(
        JSON.stringify({ error: "A user with this email already exists" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create new user with admin API
    const endCreateTimer = logger.startTimer("create-auth-user");
    const { data: userData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm email
      user_metadata: {
        full_name: fullName || null,
      },
    });
    endCreateTimer();

    if (createError) {
      logger.error("Error creating user", { error: createError.message });
      return new Response(
        JSON.stringify({ error: createError.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = userData.user.id;
    logger.info("New user created", { userId, email });

    // Resolve the grade_level_id server-side from (institutionId, gradeLevel)
    // so we guarantee the returned id belongs to the target institution. A
    // client-supplied id is intentionally ignored — the FK alone cannot
    // enforce cross-row institution ownership. #799 dropped the TEXT column,
    // so a failed resolve here fails the whole request rather than silently
    // dropping the grade.
    let gradeLevelId: string | null = null;
    if (gradeLevel) {
      try {
        gradeLevelId = await resolveOrCreateGradeLevel(supabaseAdmin, {
          institutionId,
          code: gradeLevel,
        });
      } catch (e) {
        logger.error("Failed to resolve grade_level_id for user_institutions", {
          error: e instanceof Error ? e.message : String(e),
          institutionId,
          gradeLevel,
        });
        try {
          await supabaseAdmin.auth.admin.deleteUser(userId);
        } catch (deleteErr) {
          logger.error("Failed to delete orphaned auth user after grade level resolve failure", {
            error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
            userId,
          });
        }
        return new Response(
          JSON.stringify({ error: "Failed to resolve grade level" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Add user to institution
    const endMembershipTimer = logger.startTimer("create-membership");
    const { error: membershipError } = await supabaseAdmin
      .from("user_institutions")
      .insert({
        user_id: userId,
        institution_id: institutionId,
        role: requestedRole,
        grade_level_id: gradeLevelId,
      });
    endMembershipTimer();

    if (membershipError) {
      logger.error("Error creating membership", { error: membershipError.message });
      try {
        await supabaseAdmin.auth.admin.deleteUser(userId);
      } catch (deleteErr) {
        logger.error("Failed to delete orphaned auth user after membership failure", {
          error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
          userId,
        });
      }
      return new Response(
        JSON.stringify({ error: "Failed to add user to institution" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Scope an evaluator to the courses they may review. A scopeless evaluator
    // can see nothing, so a failure here is fatal — roll back the membership and
    // the auth user so the admin can retry cleanly (mirrors the invite flow,
    // which deletes the invitation on a course-scope failure).
    if (requestedRole === "evaluator") {
      const ids: string[] = Array.isArray(courseIds)
        ? courseIds.filter((c: unknown): c is string => typeof c === "string" && c.length > 0)
        : [];

      const rollback = async () => {
        await supabaseAdmin
          .from("user_institutions")
          .delete()
          .eq("user_id", userId)
          .eq("institution_id", institutionId);
        await supabaseAdmin.auth.admin.deleteUser(userId);
      };

      if (ids.length === 0) {
        logger.error("Evaluator created without course scope", { userId });
        await rollback();
        return new Response(
          JSON.stringify({ error: "Evaluators must be assigned at least one course" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Verify every submitted course belongs to the target institution. The
      // admin client bypasses RLS, so without this check a crafted request
      // could scope the evaluator to courses in another institution.
      const { data: ownedCourses, error: ownershipError } = await supabaseAdmin
        .from("courses")
        .select("id")
        .eq("institution_id", institutionId)
        .in("id", ids);

      if (ownershipError) {
        logger.error("Error verifying course ownership", { error: ownershipError.message });
        await rollback();
        return new Response(
          JSON.stringify({ error: "Failed to verify evaluator courses" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const ownedIds = new Set((ownedCourses ?? []).map((c: { id: string }) => c.id));
      if (ids.some((id) => !ownedIds.has(id))) {
        logger.warn("Evaluator courseIds did not all belong to institution", { userId, institutionId });
        await rollback();
        return new Response(
          JSON.stringify({ error: "One or more courses do not belong to this institution" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const evaluatorRows = ids.map((course_id) => ({ course_id, user_id: userId }));
      const { error: evaluatorError } = await supabaseAdmin
        .from("course_evaluators")
        .upsert(evaluatorRows, { onConflict: "course_id,user_id", ignoreDuplicates: true });

      if (evaluatorError) {
        logger.error("Error assigning evaluator courses", { error: evaluatorError.message });
        await rollback();
        return new Response(
          JSON.stringify({ error: "Failed to assign evaluator courses" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Update profile with father_name and date_of_birth if provided
    let profileWarning: string | null = null;
    if (fatherName || dateOfBirth) {
      const profileUpdate: Record<string, string | null> = {};
      if (fatherName) profileUpdate.father_name = fatherName;
      if (dateOfBirth) profileUpdate.date_of_birth = dateOfBirth;

      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .update(profileUpdate)
        .eq("user_id", userId);

      if (profileError) {
        logger.warn("Error updating profile with father_name/date_of_birth", { error: profileError.message });
        profileWarning = "User created, but some profile fields (father's name, date of birth) could not be saved.";
      }
    }

    // Enroll user in class if provided
    if (classId) {
      const { error: classError } = await supabaseAdmin
        .from("class_enrollments")
        .insert({
          class_id: classId,
          user_id: userId,
          role: requestedRole === "instructor" ? "instructor" : "student",
        });

      if (classError) {
        logger.warn("Error enrolling user in class", { error: classError.message });
      }
    }

    logger.info("User creation complete", { userId, email });

    // Durable audit trail. Every request that reaches here has cleared the gate
    // above, so the record can never be forged by an anonymous caller. Metadata
    // stays non-identifying (role + institution); the created user is
    // referenced only by id.
    await recordAudit({
      action: "user.create",
      actorUserId,
      actorEmail,
      targetUserId: userId,
      targetEntityType: "user",
      targetEntityId: userId,
      institutionId,
      metadata: {
        role: requestedRole,
        enrolled_in_class: !!classId,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        ...(profileWarning && { warning: profileWarning }),
        user: {
          id: userId,
          email: email,
          full_name: fullName
        }
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    logger.exception(error as Error, "Error in create-user function");
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
