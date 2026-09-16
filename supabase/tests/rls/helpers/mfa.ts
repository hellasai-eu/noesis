import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { TOTP } from 'otpauth';

/**
 * TOTP enrollment helpers for the MFA suites (aal2 enforcement, admin
 * mandate). Enrollment goes through the real public API — exactly what the
 * settings dialog does — so the factors and the aal claims are GoTrue's own,
 * not fixtures.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * A client that holds its session in memory: sign in on it, and subsequent
 * PostgREST/auth calls carry that session's token — including the aal2 token
 * that mfa.verify swaps in. (The header-baked client from helpers/auth.ts
 * pins one token forever, which is exactly wrong here.)
 */
export function sessionClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Generate a TOTP code with enough of its 30s window left to be verified.
 * Near a period boundary, wait for the next window instead of racing it
 * (same shape as the browser suite's TOTP helper).
 */
export async function freshCode(secret: string): Promise<string> {
  const secondsIntoPeriod = Math.floor(Date.now() / 1000) % 30;
  const remaining = 30 - secondsIntoPeriod;
  if (remaining < 5) {
    await new Promise((r) => setTimeout(r, (remaining + 1) * 1000));
  }
  return new TOTP({ secret, digits: 6, period: 30 }).generate();
}

/**
 * Enroll + challenge + verify a TOTP factor on a signed-in session client.
 * On return the client's session is aal2. Returns the factor secret so the
 * caller can complete later challenges (e.g. a fresh aal1 → aal2 login).
 */
export async function enrollTotp(client: SupabaseClient): Promise<string> {
  const { data: enrollData, error: enrollError } = await client.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'rls-test',
  });
  if (enrollError) throw new Error(`enroll: ${enrollError.message}`);
  const secret = enrollData.totp.secret;

  const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({
    factorId: enrollData.id,
  });
  if (challengeError) throw new Error(`challenge: ${challengeError.message}`);

  const { error: verifyError } = await client.auth.mfa.verify({
    factorId: enrollData.id,
    challengeId: challengeData.id,
    code: await freshCode(secret),
  });
  if (verifyError) throw new Error(`verify: ${verifyError.message}`);

  return secret;
}

/**
 * Complete the TOTP challenge on a freshly signed-in (aal1) session client
 * whose user already has a verified factor with the given secret.
 */
export async function passChallenge(client: SupabaseClient, secret: string): Promise<void> {
  const { data: factorData, error: listError } = await client.auth.mfa.listFactors();
  if (listError) throw new Error(`listFactors: ${listError.message}`);
  const factor = factorData.totp[0];
  if (!factor) throw new Error('passChallenge: no TOTP factor on the account');

  const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({
    factorId: factor.id,
  });
  if (challengeError) throw new Error(`challenge: ${challengeError.message}`);

  const { error: verifyError } = await client.auth.mfa.verify({
    factorId: factor.id,
    challengeId: challengeData.id,
    code: await freshCode(secret),
  });
  if (verifyError) throw new Error(`verify: ${verifyError.message}`);
}

/** aal claim of the client's current access token (decode only, local token). */
export async function currentAal(client: SupabaseClient): Promise<string | undefined> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token ?? '';
  const part = token.split('.')[1] ?? '';
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).aal;
  } catch {
    return undefined;
  }
}
