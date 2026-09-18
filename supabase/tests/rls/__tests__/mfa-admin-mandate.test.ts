// Admin MFA mandate, as expressed by the per-role policy
// (migrations 20260914180000_admin_mfa_mandate.sql and
// 20260918090000_per_role_mfa_policy.sql).
//
// The default policy reproduces the original mandate: MFA REQUIRED for
// super-admins immediately, RECOMMENDED for institution admins until
// 2026-11-01, REQUIRED after it. What changed is where that lives — the
// single `admin_mfa_deadline` row became `mfa_policy`, a role -> enforcement
// start map the deployment overlay generates. This suite drives the new row
// and asserts the old behaviour is intact.
//
// Properties under test:
//   1. An UNENROLLED super-admin at aal1 has no super-admin authority —
//      is_super_admin demands aal2 outright for the calling session. After
//      enrolling (aal2), authority returns.
//   2. An unenrolled institution admin keeps admin authority before its
//      enforcement date and loses it after (flipped via the mfa_policy row —
//      safe to mutate here because vitest.config.rls.ts sets
//      fileParallelism: false, and it is restored in a finally).
//   3. mfa_enrollment_status() tells the frontend which of the two gates to
//      show, and only ever speaks about the caller.
//   4. security_policies is service-role only: no reads, no writes for
//      authenticated (and the policy cannot be moved by a client).
//
// Idempotent: per-run users and institution, cleaned up per RLS-suite
// convention (cleanupScaffold — this is the local-DB harness, not the E2E
// no-cleanup policy).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution, addSuperAdmin } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';
import { sessionClient, enrollTotp, passChallenge } from '../helpers/mfa';

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

/** The policy as the database stores it: role -> enforcement start. */
type MfaPolicy = Record<string, string | null>;

const DEFAULT_POLICY: MfaPolicy = { super_admin: null, admin: DEADLINE };

/**
 * Upsert rather than update: one test below deletes the row to exercise the
 * fail-closed fallback, and `update` on a missing row is a silent no-op.
 */
async function setPolicy(admin: SupabaseClient, value: MfaPolicy): Promise<void> {
  const { error } = await admin
    .from('security_policies')
    .upsert({ key: 'mfa_policy', value }, { onConflict: 'key' });
  if (error) throw new Error(`setPolicy: ${error.message}`);
}

/** Move only the admin role's enforcement date, leaving the rest as seeded. */
async function setAdminEnforcedFrom(
  admin: SupabaseClient,
  value: string | null,
): Promise<void> {
  await setPolicy(admin, { ...DEFAULT_POLICY, admin: value });
}

describe('admin MFA mandate', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);
  const superEmail = `rls-mandate-super-${uid}@test.local`;
  const adminEmail = `rls-mandate-admin-${uid}@test.local`;
  const studentEmail = `rls-mandate-pupil-${uid}@test.local`;

  let institutionId: string;
  let superUserId: string;
  let adminUserId: string;
  let studentUserId: string;
  // Captured when the super-admin enrols, so a later test can sign in fresh
  // and climb back to aal2 rather than enrolling a second factor.
  let superSecret: string;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `Mandate Test ${uid}`);

    for (const email of [superEmail, adminEmail, studentEmail]) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      if (email === superEmail) superUserId = data.user.id;
      else if (email === adminEmail) adminUserId = data.user.id;
      else studentUserId = data.user.id;
    }

    await addSuperAdmin(admin, superEmail);
    await addUserToInstitution(admin, adminUserId, institutionId, 'admin');
    await addUserToInstitution(admin, studentUserId, institutionId, 'student');
    // The super-admin also holds an ordinary admin membership — the seam
    // case: their institution-level authority must be on the super-admin
    // timeline too.
    await addUserToInstitution(admin, superUserId, institutionId, 'admin');
  }, 60_000);

  afterAll(async () => {
    // The policy row is global. Restoring it here as well as in each test's
    // finally means a test that fails mid-flight cannot leave a stricter
    // policy behind for the suites that run after this file.
    const { error } = await admin
      .from('security_policies')
      .upsert({ key: 'mfa_policy', value: DEFAULT_POLICY }, { onConflict: 'key' });
    if (error) console.error(`restore mfa_policy failed: ${error.message}`);

    await admin.from('super_admins').delete().eq('email', superEmail);
    await cleanupScaffold(admin, {
      institutionId,
      userIds: [superUserId, adminUserId, studentUserId],
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
    superSecret = await enrollTotp(client);

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
    await setAdminEnforcedFrom(admin, '2020-01-01T00:00:00Z');
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
      await setPolicy(admin, DEFAULT_POLICY);
    }
  });

  it('an unparseable deadline fails closed (mandate active), not with an error', async () => {
    const client = await signedInClient(adminEmail);
    await setAdminEnforcedFrom(admin, 'not-a-date');
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
      await setPolicy(admin, DEFAULT_POLICY);
    }
  });

  it('a deleted policy row fails closed for privileged roles, not for pupils', async () => {
    // The fail-closed reading of a broken policy is "privileged roles are
    // enforced" — NOT "everybody is", which would lock out every pupil over
    // somebody's mistyped UPDATE, and not "nobody is".
    const { error: deleteError } = await admin
      .from('security_policies')
      .delete()
      .eq('key', 'mfa_policy');
    expect(deleteError).toBeNull();
    try {
      const adminClient = await signedInClient(adminEmail);
      const { data: isAdmin } = await adminClient.rpc('is_institution_admin', {
        _user_id: adminUserId,
        _institution_id: institutionId,
      });
      expect(isAdmin).toBe(false);
      expect((await enrollmentStatus(adminClient)).required).toBe(true);

      const studentClient = await signedInClient(studentEmail);
      const studentStatus = await enrollmentStatus(studentClient);
      expect(studentStatus.required).toBe(false);
      expect(studentStatus.recommended).toBe(false);
      // And a pupil can still read their own profile: the blanket
      // restrictive policy did not close over them.
      const { error: readError } = await studentClient
        .from('profiles')
        .select('user_id')
        .eq('user_id', studentUserId);
      expect(readError).toBeNull();
    } finally {
      // Re-insert rather than update: this test deleted the row. Reported
      // rather than thrown — a throw from `finally` would replace a genuine
      // assertion failure above with this one, and afterAll restores the
      // policy as a backstop either way.
      const { error } = await admin
        .from('security_policies')
        .insert({ key: 'mfa_policy', value: DEFAULT_POLICY });
      if (error) console.error(`restore mfa_policy failed: ${error.message}`);
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

  it('authenticated clients can neither read nor move the policy', async () => {
    const client = await signedInClient(adminEmail);

    const { data: rows, error: readError } = await client
      .from('security_policies')
      .select('key, value');
    expect(readError).toBeNull();
    expect(rows).toEqual([]);

    const { data: updated } = await client
      .from('security_policies')
      .update({ value: { super_admin: null } })
      .eq('key', 'mfa_policy')
      .select('key');
    expect(updated ?? []).toEqual([]);

    // The row is unchanged, from the service role's vantage.
    const { data: row } = await admin
      .from('security_policies')
      .select('value')
      .eq('key', 'mfa_policy')
      .single();
    expect(row?.value).toEqual(DEFAULT_POLICY);
  });

  it('mfa_policy_effective is readable by a super-admin and nobody else', async () => {
    // The operator's drift panel reads this. "Which roles are gated" is mild
    // reconnaissance rather than a secret, but no ordinary user has a reason
    // to have it.
    const adminClient = await signedInClient(adminEmail);
    const { data: forAdmin, error: adminError } =
      await adminClient.rpc('mfa_policy_effective');
    expect(adminError).toBeNull();
    expect(forAdmin).toBeNull();

    // The super-admin enrolled earlier in this file, so their session is aal2
    // and is_super_admin passes.
    const superClient = sessionClient();
    const { error: signInError } = await superClient.auth.signInWithPassword({
      email: superEmail,
      password: PASSWORD,
    });
    expect(signInError).toBeNull();
    await passChallenge(superClient, superSecret);

    const { data: forSuper, error: superError } =
      await superClient.rpc('mfa_policy_effective');
    expect(superError).toBeNull();
    expect(forSuper).toEqual(DEFAULT_POLICY);
  }, 60_000);
});
