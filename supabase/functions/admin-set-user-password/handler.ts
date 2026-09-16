import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { recordAudit } from "../_shared/audit.ts";
import { sendPasswordChangeNotice } from "../_shared/password-change-notice.ts";
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

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userId, newPassword } = await req.json();

    if (!userId || !newPassword) {
      return json({ error: "userId and newPassword are required" }, 400);
    }

    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return json({ error: "Password must be at least 8 characters" }, 400);
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

    // An MFA-enrolled caller must present an aal2 token: setting another
    // user's password is exactly the authority a stolen password alone must
    // not confer.
    if (!callerMfaSatisfied(callerUser, token)) {
      logger.warn("Password reset attempted with an aal1 session", { callerId: callerUser.id });
      return json({ error: "Two-factor verification required" }, 403);
    }

    // ── Authorization gate ────────────────────────────────────────────────
    // The caller must be a super-admin, or an institution-admin of an
    // institution the target user belongs to. A super-admin's password can
    // only ever be reset by another super-admin.
    const { data: callerIsSuperAdmin } = await supabaseAdmin.rpc("is_super_admin", {
      _user_id: callerUser.id,
    });

    // MFA is MANDATED for super-admins: aal2 outright, enrolled or not.
    if (callerIsSuperAdmin && !callerIsAal2(token)) {
      logger.warn("Super-admin password reset attempted without aal2", { callerId: callerUser.id });
      return json({ error: "Two-factor verification required" }, 403);
    }

    // Institution that authorized an institution-admin caller (null for a
    // super-admin caller) — used to scope the audit row.
    let authorizingInstitutionId: string | null = null;

    if (!callerIsSuperAdmin) {
      // Privilege-escalation guard: an institution-admin cannot reset a
      // super-admin's password. It must FAIL CLOSED: an RPC error here would
      // leave targetIsSuperAdmin falsy and wave the caller through to the
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
        logger.warn("Institution admin attempted to reset a super-admin password", {
          callerId: callerUser.id,
          userId,
        });
        return json({ error: "Only a super-admin can reset another super-admin's password" }, 403);
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
        logger.warn("Unauthorized password reset attempt", { callerId: callerUser.id, userId });
        return json({ error: "You are not authorized to reset this user's password" }, 403);
      }

      // Once the operator-set deadline (security_policies.admin_mfa_deadline)
      // has passed, institution admins are under the same outright-aal2
      // mandate as super-admins. Checked only for a caller who IS an admin —
      // everyone else gets the ordinary authorization refusal above.
      if (!callerIsAal2(token) && await adminMfaMandateActive(supabaseAdmin)) {
        logger.warn("Admin password reset attempted without aal2 after mandate", {
          callerId: callerUser.id,
        });
        return json({ error: "Two-factor verification required" }, 403);
      }
    }

    // ── Perform the update via the service-role admin API ─────────────────
    logger.info("Resetting user password", { callerId: callerUser.id, userId });

    const { data: updated, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      { password: newPassword },
    );

    if (updateError) {
      logger.error("Error updating user password", { error: updateError.message });
      return json({ error: updateError.message }, 400);
    }

    logger.info("User password reset successfully", { userId });

    // ── Notify the account holder ─────────────────────────────────────────
    // An admin reset locks the user out of their own account until they are
    // told, and is exactly what an account takeover looks like from inside. The
    // notice goes to the TARGET (from the admin API's own record of the user,
    // not from the request body), never to the acting admin. Best-effort: the
    // password is already changed, so a failed send is recorded in the audit
    // metadata rather than returned as an error — see `password-change-notice.ts`.
    const targetEmail = updated?.user?.email ?? null;
    const targetName =
      (updated?.user?.user_metadata as { full_name?: string } | undefined)?.full_name ?? null;

    let emailNotified = false;
    if (targetEmail) {
      emailNotified = await sendPasswordChangeNotice({
        email: targetEmail,
        fullName: targetName,
        kind: "admin_reset",
      });
    } else {
      logger.warn("No email on the target account, password reset notice not sent", { userId });
    }

    // Durable audit trail. No password material or PII in metadata — whether
    // the notice was delivered is itself part of the accountability record.
    await recordAudit({
      action: "user.password_reset",
      actorUserId: callerUser.id,
      actorEmail: callerUser.email ?? null,
      targetUserId: userId,
      targetEntityType: "user",
      targetEntityId: userId,
      institutionId: authorizingInstitutionId,
      metadata: {
        via: callerIsSuperAdmin ? "super_admin" : "institution_admin",
        email_notified: emailNotified,
      },
    });

    return json({ success: true }, 200);
  } catch (error: unknown) {
    logger.exception(error as Error, "Error in admin-set-user-password function");
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return json({ error: errorMessage }, 500);
  }
};
