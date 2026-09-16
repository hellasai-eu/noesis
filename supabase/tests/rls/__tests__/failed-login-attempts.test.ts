// Tables under test: public.failed_login_attempts
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260729000000_failed_login_attempts.sql
//       - CREATE TABLE failed_login_attempts, RLS policy
//         "Super admins can read failed login attempts", and the deliberate
//         ABSENCE of any INSERT/UPDATE/DELETE policy (service-role writes
//         only, via the record-login-attempt edge fn).
//   * 20260729110000_failed_login_attempts_superadmin_only.sql
//       - DROPPED "Institution admins can read their failed login attempts",
//         leaving super admins as the only readers.
//
// The property under test is now simply: NOBODY but a super admin reads this
// table, and NOBODY at all writes it from a client.
//
// The institution-admin cases below assert the *absence* of access, and they
// matter more than they look. Rows here are self-reported through an endpoint
// that cannot be authenticated, so anyone can forge an attempt against any
// address. An institution admin acting on such a claim — locking an account,
// resetting a password, confronting a student — is precisely the lever an
// attacker would want, so the audience is deliberately kept to super admins.
//
// Shaped after audit-logs.test.ts, which guards the same write-nothing shape.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  addUserToInstitution,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

async function seedAttempt(
  admin: SupabaseClient,
  row: { email: string; institutionId: string | null; userId?: string | null; reason?: string }
): Promise<string> {
  const { data, error } = await admin
    .from('failed_login_attempts')
    .insert({
      email_attempted: row.email,
      institution_id: row.institutionId,
      user_id: row.userId ?? null,
      ip_address: '203.0.113.9',
      user_agent: 'RlsTest/1.0',
      reason: row.reason ?? 'invalid_credentials',
    })
    .select('id')
    .single();
  if (error) throw new Error(`seedAttempt: ${error.message}`);
  return data.id;
}

describe('failed_login_attempts RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;

  let ownRowId: string;
  let otherRowId: string;
  let unattributedRowId: string; // institution_id IS NULL — address matched no account

  let adminClient: SupabaseClient;
  let superAdminClient: SupabaseClient;
  let otherInstAdminClient: SupabaseClient;
  let studentClient: SupabaseClient;

  const userIds: string[] = [];
  const superAdminEmail = `rls-fla-sa-${uid}@test.local`;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS FLA ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS FLA Other ${uid}`);

    const adm = await createTestUserClient(admin, `rls-fla-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    const otherAdm = await createTestUserClient(admin, `rls-fla-otheradm-${uid}@test.local`);
    otherInstAdminClient = otherAdm.client; userIds.push(otherAdm.userId);
    await addUserToInstitution(admin, otherAdm.userId, otherInstitutionId, 'admin');

    const stu = await createTestUserClient(admin, `rls-fla-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');

    ownRowId = await seedAttempt(admin, { email: `victim-${uid}@school.gr`, institutionId });
    otherRowId = await seedAttempt(admin, { email: `victim-${uid}@other.gr`, institutionId: otherInstitutionId });
    unattributedRowId = await seedAttempt(admin, { email: `nobody-${uid}@example.com`, institutionId: null });
  });

  afterAll(async () => {
    await admin
      .from('failed_login_attempts')
      .delete()
      .in('id', [ownRowId, otherRowId, unattributedRowId]);
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await admin.from('user_institutions').delete().eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // SELECT — super-admin sees everything
  it('super-admin can read an institution-scoped attempt', async () => {
    const { data, error } = await superAdminClient
      .from('failed_login_attempts').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super-admin can read an attempt from another institution', async () => {
    const { data, error } = await superAdminClient
      .from('failed_login_attempts').select('id').eq('id', otherRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super-admin can read an unattributed attempt', async () => {
    const { data, error } = await superAdminClient
      .from('failed_login_attempts').select('id').eq('id', unattributedRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // SELECT — an institution admin reads NOTHING, not even their own tenant's
  // rows. This is the change 20260729110000 made: the reports are forgeable by
  // anyone who can reach the reporting endpoint, and an admin acting on a
  // forged one is the outcome an attacker would be buying.
  it('institution admin cannot read an attempt against their own institution', async () => {
    const { data, error } = await adminClient
      .from('failed_login_attempts').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin cannot read an attempt from another institution', async () => {
    const { data, error } = await adminClient
      .from('failed_login_attempts').select('id').eq('id', otherRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin cannot read an unattributed attempt', async () => {
    const { data, error } = await adminClient
      .from('failed_login_attempts').select('id').eq('id', unattributedRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin from a different institution cannot read this institution\'s attempt', async () => {
    const { data, error } = await otherInstAdminClient
      .from('failed_login_attempts').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // An institution admin querying the table unfiltered must come back empty,
  // not merely fail to find one seeded id — a scoped policy sneaking back in
  // would still pass the by-id assertions above if it matched other rows.
  it('institution admin sees an entirely empty table', async () => {
    const { data, error } = await adminClient
      .from('failed_login_attempts').select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // SELECT — non-admins see nothing, including about themselves
  it('a student cannot read any attempt', async () => {
    const { data, error } = await studentClient
      .from('failed_login_attempts').select('id').eq('id', ownRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // INSERT — no client policy. An anon INSERT policy would let anyone forge
  // attempts against any address and poison the signal, so writes are
  // service-role only, from the record-login-attempt edge function.
  it('institution admin cannot insert an attempt', async () => {
    const { error } = await adminClient
      .from('failed_login_attempts')
      .insert({ email_attempted: 'forged@school.gr', reason: 'invalid_credentials' });
    expect(error).not.toBeNull();
  });

  it('super-admin cannot insert an attempt (writes are service-role only)', async () => {
    const { error } = await superAdminClient
      .from('failed_login_attempts')
      .insert({ email_attempted: 'forged@school.gr', reason: 'invalid_credentials' });
    expect(error).not.toBeNull();
  });

  it('a student cannot insert an attempt', async () => {
    const { error } = await studentClient
      .from('failed_login_attempts')
      .insert({ email_attempted: 'forged@school.gr', reason: 'invalid_credentials' });
    expect(error).not.toBeNull();
  });

  // UPDATE / DELETE — no client policy, so nothing is ever matched. Since
  // 20260729110000 an institution admin cannot read these rows either, but the
  // write path is asserted separately: a future scoped SELECT policy must not
  // silently bring write access with it.
  it('institution admin cannot update an attempt', async () => {
    const { data } = await adminClient
      .from('failed_login_attempts')
      .update({ reason: 'tampered' })
      .eq('id', ownRowId)
      .select();
    expect(data ?? []).toHaveLength(0);

    const { data: check } = await admin
      .from('failed_login_attempts').select('reason').eq('id', ownRowId).single();
    expect(check?.reason).toBe('invalid_credentials');
  });

  it('institution admin cannot delete an attempt', async () => {
    const { data } = await adminClient
      .from('failed_login_attempts').delete().eq('id', ownRowId).select();
    expect(data ?? []).toHaveLength(0);

    const { count } = await admin
      .from('failed_login_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('id', ownRowId);
    expect(count).toBe(1);
  });

  it('super-admin cannot update an attempt they can read', async () => {
    const { data } = await superAdminClient
      .from('failed_login_attempts')
      .update({ reason: 'tampered' })
      .eq('id', ownRowId)
      .select();
    expect(data ?? []).toHaveLength(0);

    const { data: check } = await admin
      .from('failed_login_attempts').select('reason').eq('id', ownRowId).single();
    expect(check?.reason).toBe('invalid_credentials');
  });

  it('super-admin cannot delete an attempt', async () => {
    const { data } = await superAdminClient
      .from('failed_login_attempts').delete().eq('id', ownRowId).select();
    expect(data ?? []).toHaveLength(0);
  });
});
