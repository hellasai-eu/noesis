import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';

/**
 * Default local Supabase credentials.
 * Override via SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY env vars.
 */
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * Returns a Supabase client authenticated with the service-role key.
 * This client bypasses RLS and is used for test data setup / teardown.
 */
export function getAdminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Returns an unauthenticated client using the anon key — no session, so
 * PostgREST runs its queries as the `anon` role.
 *
 * Most policies key on `auth.uid()`, which is null here, so anon is denied by
 * construction and there is little point asserting it table by table. Use this
 * where the *absence* of a policy is what does the work and the anon role is a
 * distinct path worth naming (see ai_rate_limit_events, #1127).
 */
export function getAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Local demo JWT secret (the CLI default). Override via SUPABASE_JWT_SECRET.
 * Used only to re-sign a GoTrue-issued token with `aal: "aal2"` — see the
 * `aal2` option below.
 */
const JWT_SECRET =
  process.env.SUPABASE_JWT_SECRET ??
  'super-secret-jwt-token-with-at-least-32-characters-long';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Re-sign a GoTrue-issued access token with its `aal` claim set to aal2,
 * leaving every other claim intact. PostgREST only checks the signature, so
 * the result is indistinguishable from a post-TOTP-challenge token.
 *
 * This exists for the SUPER-ADMIN test clients: since the admin MFA mandate
 * (migration 20260914180000), is_super_admin demands an aal2 session
 * outright, and a password-only sign-in would strip every super-admin test
 * user of their authority. The REAL enroll → challenge → verify flow is
 * covered end-to-end by mfa-aal2-enforcement.test.ts and
 * mfa-admin-mandate.test.ts; the data-access suites only need the claim.
 */
function withAal2(accessToken: string): string {
  const [, payloadPart] = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  payload.aal = 'aal2';
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * Creates a new auth user and returns a Supabase client authenticated as that user.
 *
 * Uses the admin API (`admin.createUser`) so no email verification is needed.
 * The returned client uses the anon key with the user's access token set,
 * so all queries go through RLS as that user.
 *
 * Pass `{ aal2: true }` for clients that represent an MFA-challenged session
 * (required for super-admin clients — see withAal2 above). Ordinary users
 * deliberately stay aal1, so a policy that wrongly demands aal2 of them
 * still fails these suites.
 */
export async function createTestUserClient(
  admin: SupabaseClient,
  email: string,
  password = 'testpass123',
  opts: { aal2?: boolean } = {}
): Promise<{ client: SupabaseClient; userId: string }> {
  // Create the user via the admin API (service role)
  const { data: userData, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createError) throw new Error(`createTestUserClient: ${createError.message}`);

  const userId = userData.user.id;

  // Sign in as the user to get a valid session
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signInData, error: signInError } =
    await anonClient.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`createTestUserClient signIn: ${signInError.message}`);

  // Return a client with the user's access token baked in
  const accessToken = opts.aal2
    ? withAal2(signInData.session!.access_token)
    : signInData.session!.access_token;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  return { client: userClient, userId };
}
