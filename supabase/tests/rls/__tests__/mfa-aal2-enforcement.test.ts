// Server-side MFA enforcement (migration 20260914150000_enforce_aal2_rls.sql).
//
// The property under test: an MFA-enrolled user's session is only as good as
// its assurance level. A password-only (aal1) session for an enrolled user
// must read and write NOTHING — the restrictive `mfa_enforced` policy ANDs
// with every permissive policy — while the same user at aal2, and any
// unenrolled user at aal1, keep exactly the access they had before.
//
// Two layers of assertion:
//   1. Coverage (psql): every RLS-enabled table in public, plus
//      storage.objects, carries the `mfa_enforced` restrictive policy. This
//      is what makes the guarantee hold for tables added AFTER the sweep
//      migration — a new RLS-enabled table without the policy fails here by
//      name, and the fix is the CREATE POLICY snippet in the migration's
//      header comment.
//   2. Behavior (supabase-js): enroll a real TOTP factor through the public
//      API, then compare what the same user sees at aal1 vs aal2, using the
//      user's own profiles row — a row every user can otherwise always read.
//
// Idempotent by construction: each run enrolls its own per-run user (unique
// email) and never touches seeded data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAdminClient } from '../helpers/auth';
import { queryScalar } from '../helpers/sql';
import { sessionClient as freshClient, enrollTotp, passChallenge, currentAal } from '../helpers/mfa';

const PASSWORD = 'testpass123';

describe('mfa_enforced restrictive policies (aal2 enforcement)', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);
  const enrolledEmail = `rls-mfa-enrolled-${uid}@test.local`;
  const plainEmail = `rls-mfa-plain-${uid}@test.local`;

  let enrolledUserId: string;
  let plainUserId: string;
  let totpSecret: string;

  beforeAll(async () => {
    for (const email of [enrolledEmail, plainEmail]) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      if (email === enrolledEmail) enrolledUserId = data.user.id;
      else plainUserId = data.user.id;
    }

    // Enroll + verify a TOTP factor for the enrolled user through the real
    // public API, exactly as the settings dialog does.
    const client = freshClient();
    const { error: signInError } = await client.auth.signInWithPassword({
      email: enrolledEmail,
      password: PASSWORD,
    });
    if (signInError) throw new Error(`signIn: ${signInError.message}`);
    totpSecret = await enrollTotp(client);
  }, 60_000);

  afterAll(async () => {
    for (const id of [enrolledUserId, plainUserId]) {
      if (id) await admin.auth.admin.deleteUser(id);
    }
  });

  // ── 1. Coverage ─────────────────────────────────────────────────────────

  it('every RLS-enabled table carries the mfa_enforced restrictive policy', () => {
    const missing = queryScalar(`
      SELECT coalesce(string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY c.relname), '')
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relrowsecurity
        AND c.relkind IN ('r', 'p')
        AND (
          (n.nspname NOT IN ('auth', 'storage', 'realtime', 'supabase_functions',
                             'net', 'cron', 'vault', 'pgsodium', 'graphql',
                             'graphql_public', 'extensions', 'supabase_migrations',
                             'information_schema')
           AND n.nspname NOT LIKE 'pg\\_%')
          OR (n.nspname = 'storage' AND c.relname = 'objects')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = n.nspname
            AND p.tablename = c.relname
            AND p.policyname = 'mfa_enforced'
        );
    `);
    // A name here means a migration created an RLS-enabled table without the
    // policy — add the CREATE POLICY snippet from the header comment of
    // 20260914150000_enforce_aal2_rls.sql to that table's migration.
    expect(missing, `tables missing mfa_enforced: ${missing}`).toBe('');
  });

  it('mfa_enforced is restrictive and scoped to authenticated', () => {
    const row = queryScalar(`
      SELECT permissive || '|' || array_to_string(roles, ',')
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'institutions'
        AND policyname = 'mfa_enforced';
    `);
    expect(row).toBe('RESTRICTIVE|authenticated');
  });

  // ── 2. Behavior ─────────────────────────────────────────────────────────

  it('an enrolled user at aal1 (password only) reads nothing', async () => {
    const client = freshClient();
    const { error } = await client.auth.signInWithPassword({
      email: enrolledEmail,
      password: PASSWORD,
    });
    expect(error).toBeNull();
    expect(await currentAal(client)).toBe('aal1');

    // Own profile row: always visible under the permissive policies, so an
    // empty result isolates the restrictive policy as the cause.
    const { data, error: selectError } = await client
      .from('profiles')
      .select('user_id')
      .eq('user_id', enrolledUserId);
    expect(selectError).toBeNull();
    expect(data).toEqual([]);
  });

  it('an enrolled user at aal1 writes nothing', async () => {
    const client = freshClient();
    await client.auth.signInWithPassword({ email: enrolledEmail, password: PASSWORD });

    const { data } = await client
      .from('profiles')
      .update({ full_name: 'should-not-land' })
      .eq('user_id', enrolledUserId)
      .select('user_id');
    expect(data ?? []).toEqual([]);

    // Confirm through the service role that the write really did not land.
    const { data: check } = await admin
      .from('profiles')
      .select('full_name')
      .eq('user_id', enrolledUserId)
      .single();
    expect(check?.full_name ?? null).not.toBe('should-not-land');
  });

  it('the same user at aal2 (after the TOTP challenge) reads normally', async () => {
    const client = freshClient();
    await client.auth.signInWithPassword({ email: enrolledEmail, password: PASSWORD });
    await passChallenge(client, totpSecret);
    expect(await currentAal(client)).toBe('aal2');

    const { data, error } = await client
      .from('profiles')
      .select('user_id')
      .eq('user_id', enrolledUserId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  }, 60_000);

  it('an unenrolled user at aal1 keeps normal access', async () => {
    const client = freshClient();
    await client.auth.signInWithPassword({ email: plainEmail, password: PASSWORD });
    expect(await currentAal(client)).toBe('aal1');

    const { data, error } = await client
      .from('profiles')
      .select('user_id')
      .eq('user_id', plainUserId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('is_super_admin refuses an enrolled caller at aal1 and accepts aal2', async () => {
    // Make the enrolled user a super-admin, then ask the helper about the
    // calling session itself at both assurance levels.
    const { error: insertError } = await admin
      .from('super_admins')
      .insert({ email: enrolledEmail });
    expect(insertError).toBeNull();

    try {
      const aal1 = freshClient();
      await aal1.auth.signInWithPassword({ email: enrolledEmail, password: PASSWORD });
      const { data: deniedResult } = await aal1.rpc('is_super_admin', {
        _user_id: enrolledUserId,
      });
      expect(deniedResult).toBe(false);

      const aal2 = freshClient();
      await aal2.auth.signInWithPassword({ email: enrolledEmail, password: PASSWORD });
      await passChallenge(aal2, totpSecret);
      const { data: allowedResult } = await aal2.rpc('is_super_admin', {
        _user_id: enrolledUserId,
      });
      expect(allowedResult).toBe(true);
    } finally {
      await admin.from('super_admins').delete().eq('email', enrolledEmail);
    }
  }, 60_000);
});
