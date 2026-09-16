import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { recordAudit } from "../_shared/audit.ts";
import { sendMfaResetNotice } from "../_shared/mfa-reset-notice.ts";
import {
  adminMfaMandateActive,
  callerIsAal2,
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
 * Remove every MFA factor from a user's account — the recovery path for a
 * member who lost their authenticator. Privileged (see AUTHORIZATION.md):
 * caller resolved from the bearer token, then authorized as a super-admin or
 * as an institution-admin of an institution the TARGET belongs to. An admin
 * may target their own account; only a super-admin may target a super-admin.
 *
 * GoTrue signs the target out of all active sessions when a verified factor
 * is deleted, so a takeover-by-reset leaves the holder logged out and (via the
 * notice below) informed.
 */
export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userId } = await req.json();

    if (!userId || typeof userId !== "string") {
      return json({ error: "userId is required" }, 400);
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
      },
    );

    // Resolve the caller identity from the bearer token.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !callerUser) {
      return json({ error: "Unauthorized" }, 401);
    }

    // An MFA-enrolled caller must present an aal2 token: removing a second
    // factor with only a password is the takeover this endpoint exists to
    // recover FROM.
    if (!callerMfaSatisfied(callerUser, token)) {
      logger.warn("MFA reset attempted with an aal1 session", { callerId: callerUser.id });
      return json({ error: "Two-factor verification required" }, 403);
    }

    // ── Authorization gate ────────────────────────────────────────────────
    // Mirrors admin-set-user-password: the caller must be a super-admin, or an
    // institution-admin of an institution the target user belongs to (which
    // includes the caller's own account). A super-admin's MFA can only ever be
    // removed by another super-admin — removing a second factor is exactly the
    // kind of downgrade a privilege-escalation attempt would start with.
    const { data: callerIsSuperAdmin } = await supabaseAdmin.rpc("is_super_admin", {
      _user_id: callerUser.id,
    });

    // MFA is MANDATED for super-admins: aal2 outright, enrolled or not.
    if (callerIsSuperAdmin && !callerIsAal2(token)) {
      logger.warn("Super-admin MFA reset attempted without aal2", { callerId: callerUser.id });
      return json({ error: "Two-factor verification required" }, 403);
    }

    // Institution that authorized an institution-admin caller (null for a
    // super-admin caller) — used to scope the audit row.
    let authorizingInstitutionId: string | null = null;

    if (!callerIsSuperAdmin) {
      // The escalation guard must FAIL CLOSED: an RPC error here would leave
      // targetIsSuperAdmin falsy and wave the caller through to the
      // institution-admin path — which can authorize them, since super-admins
      // hold ordinary institution memberships too.
      const { data: targetIsSuperAdmin, error: targetSuperAdminError } = await supabaseAdmin.rpc(
        "is_super_admin",
        { _user_id: userId },
      );

      if (targetSuperAdminError) {
        logger.error("Failed to check target super-admin status", {
          error: targetSuperAdminError.message,
        });
        return json({ error: "Failed to verify authorization" }, 500);
      }

      if (targetIsSuperAdmin) {
        logger.warn("Institution admin attempted to remove a super-admin's MFA", {
          callerId: callerUser.id,
          userId,
        });
        return json(
          { error: "Only a super-admin can remove another super-admin's two-factor authentication" },
          403,
        );
      }

      // Resolve the target's institution memberships and require the caller to
      // be an institution-admin of at least one of them.
      const { data: memberships, error: membershipError } = await supabaseAdmin
        .from("user_institutions")
        .select("institution_id")
        .eq("user_id", userId);

      if (membershipError) {
        logger.error("Failed to resolve target institutions", { error: membershipError.message });
        return json({ error: "Failed to verify authorization" }, 500);
      }

      const institutionIds = (memberships ?? [])
        .map((m: { institution_id: string | null }) => m.institution_id)
        .filter((id: string | null): id is string => typeof id === "string" && id.length > 0);

      let authorized = false;
      for (const institutionId of institutionIds) {
        const { data: isInstAdmin } = await supabaseAdmin.rpc("is_institution_admin", {
          _user_id: callerUser.id,
          _institution_id: institutionId,
        });
        if (isInstAdmin) {
          authorized = true;
          authorizingInstitutionId = institutionId;
          break;
        }
      }

      if (!authorized) {
        logger.warn("Unauthorized MFA reset attempt", { callerId: callerUser.id, userId });
        return json(
          { error: "You are not authorized to remove this user's two-factor authentication" },
          403,
        );
      }

      // Once the operator-set deadline (security_policies.admin_mfa_deadline)
      // has passed, institution admins are under the same outright-aal2
      // mandate as super-admins. Checked only for a caller who IS an admin —
      // everyone else gets the ordinary authorization refusal above.
      if (!callerIsAal2(token) && await adminMfaMandateActive(supabaseAdmin)) {
        logger.warn("Admin MFA reset attempted without aal2 after mandate", {
          callerId: callerUser.id,
        });
        return json({ error: "Two-factor verification required" }, 403);
      }
    }

    // ── Remove the factors via the service-role admin API ─────────────────
    logger.info("Removing user MFA factors", { callerId: callerUser.id, userId });

    const { data: factorData, error: listError } = await supabaseAdmin.auth.admin.mfa.listFactors({
      userId,
    });

    if (listError) {
      logger.error("Error listing user MFA factors", { error: listError.message });
      return json({ error: listError.message }, 400);
    }

    const factors = factorData?.factors ?? [];
    let removed = 0;

    // Removing the second factor weakens the account, and from inside it looks
    // exactly like the first step of a takeover, so the holder is notified as
    // soon as ANYTHING was removed — the partial-failure path included, where a
    // verified factor may already be gone and the user already signed out. The
    // notice goes to the TARGET (from the admin API's own record of the user,
    // never the request body). Best-effort: the factors are already gone, so a
    // failed send is recorded in the audit metadata rather than returned as an
    // error.
    const notifyTarget = async (): Promise<boolean> => {
      const { data: targetData } = await supabaseAdmin.auth.admin.getUserById(userId);
      const targetEmail = targetData?.user?.email ?? null;
      const targetName =
        (targetData?.user?.user_metadata as { full_name?: string } | undefined)?.full_name ?? null;

      if (!targetEmail) {
        logger.warn("No email on the target account, MFA reset notice not sent", { userId });
        return false;
      }
      return await sendMfaResetNotice({ email: targetEmail, fullName: targetName });
    };

    for (const factor of factors) {
      const { error: deleteError } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: factor.id,
        userId,
      });

      if (deleteError) {
        // A mid-loop failure leaves the account partially reset; the factors
        // already removed are real (a verified one has signed the user out),
        // so the holder is still notified, and the partial state is made
        // visible in the audit trail before reporting the error.
        logger.error("Error deleting user MFA factor", {
          error: deleteError.message,
          factorId: factor.id,
        });
        const partialEmailNotified = removed > 0 ? await notifyTarget() : false;
        await recordAudit({
          action: "user.mfa_reset",
          actorUserId: callerUser.id,
          actorEmail: callerUser.email ?? null,
          targetUserId: userId,
          targetEntityType: "user",
          targetEntityId: userId,
          institutionId: authorizingInstitutionId,
          metadata: {
            via: callerIsSuperAdmin ? "super_admin" : "institution_admin",
            factors_removed: removed,
            partial: true,
            email_notified: partialEmailNotified,
          },
        });
        return json({ error: `Failed to remove a factor: ${deleteError.message}` }, 500);
      }

      removed++;
    }

    logger.info("User MFA factors removed", { userId, removed });

    const emailNotified = removed > 0 ? await notifyTarget() : false;

    // Durable audit trail — whether the notice was delivered is itself part of
    // the accountability record.
    await recordAudit({
      action: "user.mfa_reset",
      actorUserId: callerUser.id,
      actorEmail: callerUser.email ?? null,
      targetUserId: userId,
      targetEntityType: "user",
      targetEntityId: userId,
      institutionId: authorizingInstitutionId,
      metadata: {
        via: callerIsSuperAdmin ? "super_admin" : "institution_admin",
        factors_removed: removed,
        email_notified: emailNotified,
      },
    });

    return json({ success: true, removed }, 200);
  } catch (error: unknown) {
    logger.exception(error as Error, "Error in admin-reset-user-mfa function");
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return json({ error: errorMessage }, 500);
  }
};
