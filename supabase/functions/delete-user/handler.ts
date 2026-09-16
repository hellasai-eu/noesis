import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { recordAudit } from "../_shared/audit.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";
import { eraseUnlinkedUserData, findNameReviewCandidates } from "./erasure.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "userId is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info("Deleting user", { userId });

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

    // Verify the caller is a super admin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(callerUser, token)) {
      return new Response(
        JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check if caller is super admin
    const { data: isSuperAdmin } = await supabaseAdmin.rpc("is_super_admin", {
      _user_id: callerUser.id,
    });

    if (!isSuperAdmin) {
      logger.warn("Non-super admin attempted to delete user", { callerId: callerUser.id });
      return new Response(
        JSON.stringify({ error: "Only super admins can delete users" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Delete user's related data first
    logger.info("Deleting user related data", { userId });

    // Capture NON-IDENTIFYING context for the audit rows BEFORE we delete the
    // memberships (they're gone afterwards). Only institution ids and roles are
    // read here — deliberately no email/name — so the audit trail cannot undo a
    // GDPR erasure (issue #934). Roles are grouped BY institution so each
    // institution's audit row carries only that institution's roles — never
    // another tenant's membership.
    const { data: targetMemberships, error: snapshotError } = await supabaseAdmin
      .from("user_institutions")
      .select("institution_id, role")
      .eq("user_id", userId);
    // A snapshot READ error is distinct from a legitimate zero-membership user.
    // We do NOT abort the deletion (audit must never block the admin action),
    // but we must not silently emit a null-institution row that looks identical
    // to a genuine no-membership delete. Flag it explicitly below.
    if (snapshotError) {
      logger.warn("Failed to snapshot user_institutions before deletion", {
        userId,
        error: snapshotError.message,
      });
    }
    const rolesByInstitution = new Map<string, string[]>();
    for (const m of (targetMemberships ?? []) as Array<{ institution_id: string | null; role: string | null }>) {
      if (typeof m.institution_id !== "string" || m.institution_id.length === 0) continue;
      const roles = rolesByInstitution.get(m.institution_id) ?? [];
      if (typeof m.role === "string" && m.role.length > 0) roles.push(m.role);
      rolesByInstitution.set(m.institution_id, roles);
    }

    // Erase everything a foreign key cannot reach — rows keyed by the
    // subject's email, the user id inside `flagged_content.data`, and their
    // storage objects. Runs BEFORE the auth user is deleted, because the
    // bug-report lookup keys off `reporter_id`, which the FK added in
    // 20260726000000 nulls out on deletion. Never fatal: an erasure request
    // must not be blocked by a storage hiccup, so failures come back as
    // warnings and are surfaced in the response and the audit record.
    //
    // The subject's email is read from auth rather than `profiles`: the two can
    // disagree, and auth is the record of what they actually sign in with.
    const { data: targetAuth } = await supabaseAdmin.auth.admin.getUserById(userId);
    const targetEmail: string | null = targetAuth?.user?.email ?? null;

    // The subject's display name, read BEFORE the profile row cascades — it is
    // the search key for the post-deletion sweep of instructor-typed names
    // (graded_tests.student_name / student_evaluations.student_name), the one
    // part of an erasure no foreign key can finish.
    const { data: targetProfile } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("user_id", userId)
      .maybeSingle();
    const targetFullName: string | null = targetProfile?.full_name ?? null;

    const { storageRemoved, warnings } = await eraseUnlinkedUserData(supabaseAdmin, {
      userId,
      email: targetEmail,
    });
    if (warnings.length > 0) {
      logger.warn("User erasure completed with warnings", { userId, warnings });
    }

    // Redundant since 20260726000000 gave both tables an ON DELETE CASCADE to
    // auth.users, and kept so the account still goes if that migration has not
    // reached this environment yet.
    await supabaseAdmin.from("user_institutions").delete().eq("user_id", userId);
    await supabaseAdmin.from("profiles").delete().eq("user_id", userId);

    // Delete the auth user. Everything else with a user id cascades from here.
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteError) {
      logger.error("Error deleting auth user", { error: deleteError.message });
      return new Response(
        JSON.stringify({ error: deleteError.message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    logger.info("User deleted successfully", { userId });

    // Sweep the free-text name columns now that the cascade has run: whatever
    // still matches the subject's name did not go with the account and needs a
    // human decision (clear it, or attest it belongs to a same-named other
    // student) before the erasure request is confirmed complete.
    const nameSweep = await findNameReviewCandidates(supabaseAdmin, targetFullName);
    warnings.push(...nameSweep.warnings);
    if (nameSweep.candidates.length > 0) {
      logger.info("Erasure left typed-name rows for review", {
        userId,
        count: nameSweep.candidates.length,
      });
    }

    // What the erasure did, recorded on every audit row this delete produces.
    // Only the WARNING SOURCES travel here — a driver error message can quote
    // the offending value, and an email echoed into the audit trail would undo
    // the erasure it is meant to evidence. Full messages go to the caller and
    // the logs instead. The name sweep contributes a COUNT only, for the same
    // reason: the candidate rows quote the typed name itself.
    const erasureMetadata = {
      storage_objects_removed: storageRemoved,
      erasure_warnings: warnings.map((w) => w.source),
      name_review_candidates: nameSweep.candidates.length,
    };

    // Durable audit trail. ERASURE SAFETY: metadata carries only the deleted
    // user's roles — never their name or email — so the audit record does not
    // re-introduce the erased personal data. TENANT ISOLATION: one row PER
    // institution, each scoped to that institution_id and carrying only that
    // institution's roles, so an institution admin never sees another tenant's
    // membership and every affected institution gets its own record.
    if (snapshotError) {
      // Membership snapshot failed — record a single super-admin-only row that
      // is CLEARLY distinguishable from a genuine no-membership delete, so a
      // transient read failure remains auditable and flagged. No PII: only a
      // marker (and a short, non-identifying error code from the DB driver).
      await recordAudit({
        action: "user.delete",
        actorUserId: callerUser.id,
        actorEmail: callerUser.email ?? null,
        targetUserId: userId,
        targetEntityType: "user",
        targetEntityId: userId,
        institutionId: null,
        metadata: {
          ...erasureMetadata,
          membership_snapshot_failed: true,
          snapshot_error_code: snapshotError.code ?? null,
        },
      });
    } else if (rolesByInstitution.size === 0) {
      // User genuinely belonged to no institution — a single super-admin-only
      // record (no failure flag).
      await recordAudit({
        action: "user.delete",
        actorUserId: callerUser.id,
        actorEmail: callerUser.email ?? null,
        targetUserId: userId,
        targetEntityType: "user",
        targetEntityId: userId,
        institutionId: null,
        metadata: { ...erasureMetadata, roles: [] },
      });
    } else {
      for (const [institutionId, roles] of rolesByInstitution) {
        await recordAudit({
          action: "user.delete",
          actorUserId: callerUser.id,
          actorEmail: callerUser.email ?? null,
          targetUserId: userId,
          targetEntityType: "user",
          targetEntityId: userId,
          institutionId,
          metadata: { ...erasureMetadata, roles },
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        storageObjectsRemoved: storageRemoved,
        warnings,
        nameReviewCandidates: nameSweep.candidates,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    logger.exception(error as Error, "Error in delete-user function");
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
