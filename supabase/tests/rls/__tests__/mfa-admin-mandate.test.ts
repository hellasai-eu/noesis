// Admin MFA mandate (migration 20260914180000_admin_mfa_mandate.sql).
//
// Policy: MFA is REQUIRED for super-admins immediately, RECOMMENDED for
// institution admins until the security_policies deadline (2026-11-01),
// REQUIRED after it.
//
// Properties under test:
//   1. An UNENROLLED super-admin at aal1 has no super-admin authority —
//      is_super_admin demands aal2 outright for the calling session. After
//      enrolling (aal2), authority returns.
//   2. An unenrolled institution admin keeps admin authority before the
//      deadline and loses it after (flipped via the security_policies row —
//      safe to mutate here because vitest.config.rls.ts sets
//      fileParallelism: false, and it is restored in a finally).
//   3. mfa_enrollment_status() tells the frontend which of the two gates to
//      show, and only ever speaks about the caller.
//   4. security_policies is service-role only: no reads, no writes for
//      authenticated (and the operator deadline cannot be moved by a
//      client).
//
// Idempotent: per-run users and institution, cleaned up per RLS-suite
// convention (cleanupScaffold — this is the local-DB harness, not the E2E
// no-cleanup policy).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution, addSuperAdmin } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';
import { sessionClient, enrollTotp } from '../helpers/mfa';

const PASSWORD = 'testpass123';
const DEADLINE = '2026-11-01T00:00:00Z';

async function signedInClient(email: string): Promise<SupabaseClient> {
  const client = sessionClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return client;
}

interface EnrollmentStatus {
  required: boolean;
  recommended: boolean;
  deadline: string | null;
}

async function enrollmentStatus(client: SupabaseClient): Promise<EnrollmentStatus> {
  const { data, error } = await client.rpc('mfa_enrollment_status');
  if (error) throw new Error(`mfa_enrollment_status: ${error.message}`);
  return data as unknown as EnrollmentStatus;
}

async function setDeadline(admin: SupabaseClient, value: string): Promise<void> {
  const { error } = await admin
    .from('security_policies')
    .update({ value })
    .eq('key', 'admin_mfa_deadline');
  if (error) throw new Error(`setDeadline: ${error.message}`);
}

describe('admin MFA mandate', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);
  const superEmail = `rls-mandate-super-${uid}@test.local`;
  const adminEmail = `rls-mandate-admin-${uid}@test.local`;

  let institutionId: string;
  let superUserId: string;
  let adminUserId: string;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `Mandate Test ${uid}`);

    for (const email of [superEmail, adminEmail]) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      if (email === superEmail) superUserId = data.user.id;
      else adminUserId = data.user.id;
    }

    await addSuperAdmin(admin, superEmail);
    await addUserToInstitution(admin, adminUserId, institutionId, 'admin');
    // The super-admin also holds an ordinary admin membership — the seam
    // case: their institution-level authority must be on the super-admin
    // timeline too.
    await addUserToInstitution(admin, superUserId, institutionId, 'admin');
  }, 60_000);

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superEmail);
    await cleanupScaffold(admin, {
      institutionId,
      userIds: [superUserId, adminUserId],
    });
  });

  // ── Super-admin: required immediately ───────────────────────────────────

  it('an unenrolled super-admin at aal1 has no super-admin authority', async () => {
    const client = await signedInClient(superEmail);

    const { data: isSuper, error } = await client.rpc('is_super_admin', {
      _user_id: superUserId,
    });
    expect(error).toBeNull();
    expect(isSuper).toBe(false);

    const status = await enrollmentStatus(client);
    expect(status.required).toBe(true);
    expect(status.recommended).toBe(false);
  });

  it("a super-admin's ordinary admin membership is on the super-admin timeline too", async () => {
    // Pre-deadline, an unenrolled plain admin keeps authority — but a
    // super_admins member does not get institution-admin authority through
    // their membership row at aal1: no password-only side door.
    const client = await signedInClient(superEmail);

    const { data: isAdmin, error } = await client.rpc('is_institution_admin', {
      _user_id: superUserId,
      _institution_id: institutionId,
    });
    expect(error).toBeNull();
    expect(isAdmin).toBe(false);
  });

  it('anon cannot call mfa_enrollment_status', async () => {
    const { getAnonClient } = await import('../helpers/auth');
    const { error } = await getAnonClient().rpc('mfa_enrollment_status');
    expect(error).not.toBeNull();
  });

  it('after enrolling (aal2) super-admin authority returns', async () => {
    const client = await signedInClient(superEmail);
    await enrollTotp(client);

    const { data: isSuper, error } = await client.rpc('is_super_admin', {
      _user_id: superUserId,
    });
    expect(error).toBeNull();
    expect(isSuper).toBe(true);

    const status = await enrollmentStatus(client);
    expect(status.required).toBe(false);
    expect(status.recommended).toBe(false);
  }, 60_000);

  // ── Institution admin: recommended now, required after the deadline ────

  it('an unenrolled admin keeps authority before the deadline, and is told to enroll', async () => {
    const client = await signedInClient(adminEmail);

    const { data: isAdmin, error } = await client.rpc('is_institution_admin', {
      _user_id: adminUserId,
      _institution_id: institutionId,
    });
    expect(error).toBeNull();
    expect(isAdmin).toBe(true);

    const status = await enrollmentStatus(client);
    expect(status.required).toBe(false);
    expect(status.recommended).toBe(true);
    expect(status.deadline).toBe(DEADLINE);
  });

  it('after the deadline an unenrolled admin loses authority until enrolled', async () => {
    const client = await signedInClient(adminEmail);
    await setDeadline(admin, '2020-01-01T00:00:00Z');
    try {
      const { data: isAdmin } = await client.rpc('is_institution_admin', {
        _user_id: adminUserId,
        _institution_id: institutionId,
      });
      expect(isAdmin).toBe(false);

      const { data: isAdminAny } = await client.rpc('is_admin', {
        _user_id: adminUserId,
      });
      expect(isAdminAny).toBe(false);

      const status = await enrollmentStatus(client);
      expect(status.required).toBe(true);
      expect(status.recommended).toBe(false);
    } finally {
      await setDeadline(admin, DEADLINE);
    }
  });

  it('an unparseable deadline fails closed (mandate active), not with an error', async () => {
    const client = await signedInClient(adminEmail);
    await setDeadline(admin, 'not-a-date');
    try {
      const { data: isAdmin, error } = await client.rpc('is_institution_admin', {
        _user_id: adminUserId,
        _institution_id: institutionId,
      });
      expect(error).toBeNull();
      expect(isAdmin).toBe(false);

      const status = await enrollmentStatus(client);
      expect(status.required).toBe(true);
    } finally {
      await setDeadline(admin, DEADLINE);
    }
  });

  it('a student is neither required nor recommended to enroll', async () => {
    // The admin user doubles as the probe: remove nothing, just ask as a
    // fresh unprivileged user.
    const email = `rls-mandate-student-${uid}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    try {
      const client = await signedInClient(email);
      const status = await enrollmentStatus(client);
      expect(status.required).toBe(false);
      expect(status.recommended).toBe(false);
    } finally {
      await admin.auth.admin.deleteUser(data.user.id);
    }
  });

  // ── security_policies is service-role only ──────────────────────────────

  it('authenticated clients can neither read nor move the deadline', async () => {
    const client = await signedInClient(adminEmail);

    const { data: rows, error: readError } = await client
      .from('security_policies')
      .select('key, value');
    expect(readError).toBeNull();
    expect(rows).toEqual([]);

    const { data: updated } = await client
      .from('security_policies')
      .update({ value: '2099-01-01T00:00:00Z' })
      .eq('key', 'admin_mfa_deadline')
      .select('key');
    expect(updated ?? []).toEqual([]);

    // The row is unchanged, from the service role's vantage.
    const { data: row } = await admin
      .from('security_policies')
      .select('value')
      .eq('key', 'admin_mfa_deadline')
      .single();
    expect(row?.value).toBe(DEADLINE);
  });
});
