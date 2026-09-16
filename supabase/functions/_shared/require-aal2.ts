/**
 * Server-side MFA assurance check for privileged handlers.
 *
 * The DB's restrictive `mfa_enforced` policies (migration
 * 20260914150000_enforce_aal2_rls.sql) do not protect edge functions: they
 * act through the service-role client, which bypasses RLS. So a privileged
 * handler must itself refuse an aal1 token from an MFA-enrolled caller —
 * otherwise a password-only session could drive exactly the admin actions
 * MFA is meant to gate.
 *
 * The token payload is decoded WITHOUT signature verification, which is
 * sound only because the caller passes the same token that
 * `auth.getUser(token)` just validated: GoTrue checked the signature, we
 * only read a claim from it. Likewise the factor list must come from that
 * validated GoTrue user object — never from the request body.
 *
 * Fail-closed: an enrolled caller whose token has a missing or undecodable
 * aal claim is refused. A caller with no verified factor passes (MFA is
 * opt-in; enforcement for them is the enrollment mandate, not this check).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Stable refusal shape for an MFA-enrolled caller presenting an aal1 token.
 * Every gate in the sweep replies 403 with this code so the frontend can
 * distinguish "complete your second factor" from an authorization failure.
 */
export const AAL2_REQUIRED_CODE = "aal2_required";
export const AAL2_REQUIRED_MESSAGE = "Multi-factor authentication required";

interface CallerLike {
  factors?: Array<{ factor_type?: string; status?: string }> | null;
}

function decodeAal(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.aal === "string" ? payload.aal : null;
  } catch {
    return null;
  }
}

/** True when the validated caller either has no verified factor or presents an aal2 token. */
export function callerMfaSatisfied(user: CallerLike, token: string): boolean {
  const enrolled = (user.factors ?? []).some((f) => f.status === "verified");
  if (!enrolled) return true;
  return decodeAal(token) === "aal2";
}

/**
 * True when the (already validated) token is aal2 outright — the rule for
 * super-admin callers, who are MANDATED to have MFA: enrollment is not
 * optional for them, so "unenrolled" is not a pass.
 */
export function callerIsAal2(token: string): boolean {
  return decodeAal(token) === "aal2";
}

/**
 * True once institution admins are required (not just recommended) to have
 * MFA — mirrors public.admin_mfa_mandate_active(): the deadline lives in
 * public.security_policies ('admin_mfa_deadline'), and a missing or
 * unreadable row fails CLOSED (mandate active), matching the SQL helper.
 */
export async function adminMfaMandateActive(
  supabaseAdmin: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("security_policies")
    .select("value")
    .eq("key", "admin_mfa_deadline")
    .maybeSingle();
  if (error || !data) return true;
  const deadline = Date.parse(String((data as { value: unknown }).value));
  if (Number.isNaN(deadline)) return true;
  return Date.now() >= deadline;
}
