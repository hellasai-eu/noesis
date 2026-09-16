/**
 * Durable audit logging for sensitive admin actions (issue #934).
 *
 * Writes a row to `public.audit_logs` using the service-role key so the insert
 * bypasses RLS (no client write policies exist on that table). Fire-and-forget,
 * modelled on `_shared/usage-tracker.ts`: it NEVER throws into the caller — a
 * failure to record the audit row must not fail the underlying admin action.
 * Console logging via `_shared/logger.ts` stays; this adds durability.
 *
 * ERASURE SAFETY: for deletion actions the caller MUST pass only
 * non-identifying data (target user id, institution, role) — never the deleted
 * user's name or email — so a GDPR erasure is not undone by the audit trail.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

/** Documented set of auditable actions — keep in sync with the CHECK on
 * `audit_logs.action` in migration 20260725064858_audit_logs.sql. */
export type AuditAction =
  | "user.create"
  | "user.delete"
  /** An admin set another user's password. */
  | "user.password_reset"
  /** A user changed their own password. */
  | "user.password_changed"
  /** An admin removed a user's MFA factors. */
  | "user.mfa_reset"
  | "user.bulk_invite"
  | "user.invite"
  | "data.export"
  | "data.preview";

export interface AuditEntry {
  /** What happened. */
  action: AuditAction;
  /** The acting admin, resolved from the request's bearer token. */
  actorUserId?: string | null;
  actorEmail?: string | null;
  /** The user acted upon, when the target is a user. */
  targetUserId?: string | null;
  /** Generic (type, id) reference for non-user targets (table, invitation…). */
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  /** Institution the action is scoped to (drives institution-admin reads). */
  institutionId?: string | null;
  /**
   * Non-identifying context. For `user.delete` this MUST NOT contain the
   * deleted user's name/email/PII.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Record a durable audit row. Fire-and-forget: awaited by callers so the insert
 * completes before the edge function returns (the runtime may terminate the
 * isolate right after the response), but it swallows every error internally.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      logger.warn("Supabase credentials not configured, skipping audit log insert", {
        action: entry.action,
      });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { error } = await supabase.from("audit_logs").insert({
      action: entry.action,
      actor_user_id: entry.actorUserId ?? null,
      actor_email: entry.actorEmail ?? null,
      target_user_id: entry.targetUserId ?? null,
      target_entity_type: entry.targetEntityType ?? null,
      target_entity_id: entry.targetEntityId ?? null,
      institution_id: entry.institutionId ?? null,
      metadata: entry.metadata ?? {},
    });

    if (error) {
      logger.error("Failed to insert audit log", {
        action: entry.action,
        error: error.message,
      });
    }
  } catch (error) {
    // Never fail the underlying admin action because auditing failed.
    logger.error("Error recording audit log", {
      action: entry.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
