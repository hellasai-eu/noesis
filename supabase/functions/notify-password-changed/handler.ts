import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { recordAudit } from "../_shared/audit.ts";
import { sendPasswordChangeNotice } from "../_shared/password-change-notice.ts";

/**
 * Notify + audit a SELF-SERVICE password change.
 *
 * The admin reset path runs through `admin-set-user-password`, so it can email
 * and audit inline. A user changing their own password does not: the browser
 * calls GoTrue's `auth.updateUser` directly and nothing server-side of ours
 * ever sees it. `ChangePasswordDialog` calls this immediately afterwards to
 * close that gap.
 *
 * AUTHORIZATION: the subject is derived SOLELY from the bearer token. There is
 * no user id in the request body, by design — a body-supplied id would let any
 * signed-in user mail a "your password was changed" alarm to any address and
 * write an audit row naming someone else. The rule is therefore "you may report
 * your own password change and no one else's", which is the whole of what this
 * endpoint can do.
 *
 * A caller can still assert a change they did not make about themselves. That
 * is the residual limit of an after-the-fact client callback and is why the row
 * is marked `reported_by: "client"` — it evidences a self-service change, it
 * does not prove one. The reverse (a real change going unrecorded because the
 * browser closed first) is the more likely gap of the two.
 */

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      logger.error("Supabase credentials are not configured");
      return json({ error: "Server is not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !callerUser) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Deliberately NO aal2 gate here (the #1440 sweep's one caller-resolving
    // exception): the subject is always the token's caller, the only effects
    // are emailing and auditing that caller's own password change, and
    // password RECOVERY legitimately happens at aal1 — suppressing the
    // security notification for exactly that flow would help an attacker.

    // Institution scope so institution admins can see the row: the RLS read
    // policy on `audit_logs` only exposes rows with a non-null institution_id
    // to them. A user in none leaves it null and the row is super-admin only.
    //
    // A password is not an institutional resource, so for a user in several
    // institutions there is no single right answer. The row is scoped to their
    // EARLIEST membership — ordered, because an unordered `limit(1)` lets
    // Postgres return a different institution run to run, which would scatter
    // one user's security events across tenants at random (#1232 review).
    // Every membership is listed in the metadata so a super-admin reading the
    // global trail still sees the full picture; the accepted limit is that
    // admins of the user's other institutions do not see this row. One event
    // stays one row — writing one per membership would make the trail read as
    // several password changes where only one happened.
    let institutionId: string | null = null;
    let institutionIds: string[] = [];
    const { data: memberships, error: membershipError } = await supabaseAdmin
      .from("user_institutions")
      .select("institution_id, created_at")
      .eq("user_id", callerUser.id)
      .order("created_at", { ascending: true })
      .order("institution_id", { ascending: true });

    if (membershipError) {
      // Not fatal — an unscoped audit row is better than none.
      logger.warn("Failed to resolve institution for password change audit", {
        error: membershipError.message,
      });
    } else {
      institutionIds = (memberships ?? [])
        .map((m: { institution_id: string | null }) => m.institution_id)
        .filter((id: string | null): id is string => typeof id === "string" && id.length > 0);
      institutionId = institutionIds[0] ?? null;
    }

    // The profile carries the display name; missing is fine, the copy degrades.
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("user_id", callerUser.id)
      .maybeSingle();

    const emailNotified = await sendPasswordChangeNotice({
      email: callerUser.email ?? "",
      fullName: profile?.full_name ?? null,
      kind: "self_service",
    });

    // Durable audit trail. Actor and target are the same person; no password
    // material and no PII beyond the actor's own email, which the table already
    // records for every actor.
    await recordAudit({
      action: "user.password_changed",
      actorUserId: callerUser.id,
      actorEmail: callerUser.email ?? null,
      targetUserId: callerUser.id,
      targetEntityType: "user",
      targetEntityId: callerUser.id,
      institutionId,
      metadata: {
        via: "self_service",
        email_notified: emailNotified,
        reported_by: "client",
        // Every institution the user belongs to, so the single scoped row above
        // does not lose the rest. Institution ids, not PII.
        institution_ids: institutionIds,
      },
    });

    logger.info("Recorded a self-service password change", {
      userId: callerUser.id,
      emailNotified,
    });

    return json({ success: true, emailNotified }, 200);
  } catch (error: unknown) {
    logger.exception(error as Error, "Error in notify-password-changed function");
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return json({ error: errorMessage }, 500);
  }
};
