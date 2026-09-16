import type { Session } from '@supabase/supabase-js';

/**
 * MFA assurance-level helpers.
 *
 * Computed locally from the session instead of through
 * `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` because these run
 * inside the `onAuthStateChange` callback, where calling back into
 * supabase-js auth methods can deadlock on the client's internal lock.
 */

type AalLevel = 'aal1' | 'aal2';

/** Decode a JWT payload without verifying it (we only read our own session's claims). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const base64Url = token.split('.')[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/** The assurance level the current access token was issued at. */
export function getCurrentAal(session: Session | null): AalLevel | null {
  if (!session?.access_token) return null;
  const payload = decodeJwtPayload(session.access_token);
  const aal = payload?.aal;
  return aal === 'aal2' ? 'aal2' : aal === 'aal1' ? 'aal1' : null;
}

/** Whether the session's user has at least one verified TOTP factor enrolled. */
export function hasVerifiedTotpFactor(session: Session | null): boolean {
  const factors = session?.user?.factors;
  if (!Array.isArray(factors)) return false;
  return factors.some((f) => f.factor_type === 'totp' && f.status === 'verified');
}

/**
 * True when the session is signed in with a password but still owes a TOTP
 * code: a verified factor exists and the token is only aal1. While this holds,
 * the app must treat the user as not signed in and show the challenge.
 *
 * Fails open (returns false) on an undecodable token: this gate is login UX,
 * not the security boundary. That is RLS — every table carries a restrictive
 * `mfa_enforced` policy (migration 20260914150000_enforce_aal2_rls.sql) that
 * denies an aal1 session of an enrolled user, so a session that slips past
 * this gate reads nothing. Failing closed here could lock every user out on
 * a decode bug.
 */
export function isMfaPending(session: Session | null): boolean {
  if (!session) return false;
  if (!hasVerifiedTotpFactor(session)) return false;
  return getCurrentAal(session) === 'aal1';
}
