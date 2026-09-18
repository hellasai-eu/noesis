// Per-role MFA policy (migration 20260918090000_per_role_mfa_policy.sql).
//
// The deployment overlay declares which roles must enrol in TOTP
// (`deployment/settings.json`), `npm run settings:sql` turns that into the
// `security_policies.mfa_policy` row, and this suite is the reason to believe
// the row does anything.
//
// That belief is the whole point. Super-admins and institution admins have
// privileged-role helpers (is_super_admin, is_institution_admin) that can
// demand aal2. Instructors, evaluators and pupils have no such function —
// their enforcement comes from `mfa_satisfied()`, which backs the blanket
// restrictive RLS policy on every table (20260914150000). So for these roles
// "enforced" has to mean *reads stop working*, not "the SPA shows a dialog":
// a client-side gate is bypassed by not using the client.
//
// Properties under test:
//   1. Enforcing a role an unenrolled user holds costs them all table access,
//      and enrolling restores it. This is the claim that separates a real
//      control from a decorative one.
//   2. A role absent from the policy is untouched — enforcing instructors
//      must not brick every pupil.
//   3. A future date means "recommended": the nudge names the date and access
//      is retained. The date passing flips the same user to required.
//   4. Most-strict-wins across a user's roles, so a second membership cannot
//      be used to dodge the mandate.
//   5. Removing a role from the policy restores access immediately, without
//      anyone having to unenrol.
//
// The policy row is global, so every test restores it in a finally. Safe
// because vitest.config.rls.ts sets fileParallelism: false.
//
// Idempotent: per-run users and institutions, cleaned up per RLS-suite
// convention (cleanupScaffold).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from '../helpers/auth';
import { createInstitution, addUserToInstitution } from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';
import { sessionClient, enrollTotp, currentAal } from '../helpers/mfa';

const PASSWORD = 'testpass123';

/** Role -> enforcement start; null means immediately. */
type MfaPolicy = Record<string, string | null>;

/** What the shipped migration seeds, and what each test restores. */
const DEFAULT_POLICY: MfaPolicy = {
  super_admin: null,
  admin: '2026-11-01T00:00:00Z',
};

const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

interface EnrollmentStatus {
  required: boolean;
  recommended: boolean;
  deadline: string | null;
}

describe('per-role MFA policy', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  const instructorEmail = `rls-role-instructor-${uid}@test.local`;
  const pupilEmail = `rls-role-pupil-${uid}@test.local`;
  const dualEmail = `rls-role-dual-${uid}@test.local`;

  let institutionId: string;
  let otherInstitutionId: string;
  let instructorUserId: string;
  let pupilUserId: string;
  let dualUserId: string;

  async function signedIn(email: string): Promise<SupabaseClient> {
    const client = sessionClient();
    const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw new Error(`signIn ${email}: ${error.message}`);
    return client;
  }

  /**
   * Upsert rather than update: a sibling suite tests the deleted-row
   * fallback, and `update` on a missing row is a silent no-op that would
   * leave this file asserting against the fallback policy instead of the one
   * it just set.
   */
  async function setPolicy(value: MfaPolicy): Promise<void> {
    const { error } = await admin
      .from('security_policies')
      .upsert({ key: 'mfa_policy', value }, { onConflict: 'key' });
    if (error) throw new Error(`setPolicy: ${error.message}`);
  }

  async function status(client: SupabaseClient): Promise<EnrollmentStatus> {
    const { data, error } = await client.rpc('mfa_enrollment_status');
    if (error) throw new Error(`mfa_enrollment_status: ${error.message}`);
    return data as unknown as EnrollmentStatus;
  }

  /**
   * Can this session read its own profile row?
   *
   * The probe for enforcement. RLS denial is not an error in PostgREST — the
   * rows simply are not there — so a test that only checked `error` would
   * pass whether or not the policy did anything.
   */
  async function canReadOwnProfile(
    client: SupabaseClient,
    userId: string,
  ): Promise<boolean> {
    const { data, error } = await client
      .from('profiles')
      .select('user_id')
      .eq('user_id', userId);
    if (error) throw new Error(`profiles select: ${error.message}`);
    return (data ?? []).length > 0;
  }

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `Role Policy ${uid}`);
    otherInstitutionId = await createInstitution(admin, `Role Policy Other ${uid}`);

    const emails = [instructorEmail, pupilEmail, dualEmail];
    for (const email of emails) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
      });
      if (error) throw new Error(`createUser ${email}: ${error.message}`);
      if (email === instructorEmail) instructorUserId = data.user.id;
      else if (email === pupilEmail) pupilUserId = data.user.id;
      else dualUserId = data.user.id;
    }

    await addUserToInstitution(admin, instructorUserId, institutionId, 'instructor');
    await addUserToInstitution(admin, pupilUserId, institutionId, 'student');
    // The dodge case: a pupil here, an instructor there.
    await addUserToInstitution(admin, dualUserId, institutionId, 'student');
    await addUserToInstitution(admin, dualUserId, otherInstitutionId, 'instructor');
  }, 60_000);

  afterAll(async () => {
    await setPolicy(DEFAULT_POLICY);
    await cleanupScaffold(admin, {
      institutionId,
      userIds: [instructorUserId, pupilUserId, dualUserId],
    });
    await cleanupScaffold(admin, { institutionId: otherInstitutionId, userIds: [] });
  });

  it('leaves every non-privileged role alone under the shipped default', async () => {
    // The migration must be adoptable without also changing anyone's policy.
    await setPolicy(DEFAULT_POLICY);

    const client = await signedIn(instructorEmail);
    expect(await canReadOwnProfile(client, instructorUserId)).toBe(true);

    const s = await status(client);
    expect(s.required).toBe(false);
    expect(s.recommended).toBe(false);
  });

  it('enforcing instructors costs an unenrolled instructor all table access', async () => {
    await setPolicy({ ...DEFAULT_POLICY, instructor: null });
    try {
      const client = await signedIn(instructorEmail);
      expect(await currentAal(client)).toBe('aal1');

      // The claim that matters: not a dialog, an actual loss of read access.
      expect(await canReadOwnProfile(client, instructorUserId)).toBe(false);

      const s = await status(client);
      expect(s.required).toBe(true);
      expect(s.recommended).toBe(false);
      // Nothing to count down to — enforcement already started.
      expect(s.deadline).toBeNull();
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  });

  it('and a pupil is untouched while only instructors are enforced', async () => {
    await setPolicy({ ...DEFAULT_POLICY, instructor: null });
    try {
      const client = await signedIn(pupilEmail);
      expect(await canReadOwnProfile(client, pupilUserId)).toBe(true);
      expect((await status(client)).required).toBe(false);
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  });

  it('enrolling restores the enforced instructor immediately', async () => {
    await setPolicy({ ...DEFAULT_POLICY, instructor: null });
    try {
      const client = await signedIn(instructorEmail);
      expect(await canReadOwnProfile(client, instructorUserId)).toBe(false);

      await enrollTotp(client);
      expect(await currentAal(client)).toBe('aal2');

      expect(await canReadOwnProfile(client, instructorUserId)).toBe(true);
      const s = await status(client);
      expect(s.required).toBe(false);
      expect(s.recommended).toBe(false);
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  }, 60_000);

  it('a future date recommends rather than requires, and names the date', async () => {
    await setPolicy({ ...DEFAULT_POLICY, student: FUTURE });
    try {
      const client = await signedIn(pupilEmail);

      // Access is retained: this is a warning, not a wall.
      expect(await canReadOwnProfile(client, pupilUserId)).toBe(true);

      const s = await status(client);
      expect(s.required).toBe(false);
      expect(s.recommended).toBe(true);
      expect(s.deadline).toBe(FUTURE);
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  });

  it('the same pupil is required once that date has passed', async () => {
    await setPolicy({ ...DEFAULT_POLICY, student: PAST });
    try {
      const client = await signedIn(pupilEmail);
      expect(await canReadOwnProfile(client, pupilUserId)).toBe(false);

      const s = await status(client);
      expect(s.required).toBe(true);
      expect(s.recommended).toBe(false);
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  });

  it('most-strict-wins: a second membership is not a way around the mandate', async () => {
    // dualUser is a pupil in one institution and an instructor in another.
    // Enforcing instructors must catch them despite the softer membership.
    await setPolicy({ ...DEFAULT_POLICY, instructor: null, student: FUTURE });
    try {
      const client = await signedIn(dualEmail);

      const s = await status(client);
      expect(s.required).toBe(true);
      // 'required' and 'recommended' stay mutually exclusive, or the frontend
      // would nudge someone it has already locked out.
      expect(s.recommended).toBe(false);
      expect(await canReadOwnProfile(client, dualUserId)).toBe(false);
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  });

  it('names the earliest upcoming date when two of a user’s roles are scheduled', async () => {
    const SOONER = '2098-01-01T00:00:00Z';
    await setPolicy({ ...DEFAULT_POLICY, student: FUTURE, instructor: SOONER });
    try {
      const client = await signedIn(dualEmail);
      const s = await status(client);
      expect(s.required).toBe(false);
      expect(s.recommended).toBe(true);
      expect(s.deadline).toBe(SOONER);
    } finally {
      await setPolicy(DEFAULT_POLICY);
    }
  });

  it('removing a role from the policy restores access without unenrolling', async () => {
    // The operator's undo. Someone who enrolled stays enrolled — and stays
    // bound by the aal2 rule for enrolled users — but nobody is locked out.
    await setPolicy({ ...DEFAULT_POLICY, student: PAST });
    const client = await signedIn(pupilEmail);
    expect(await canReadOwnProfile(client, pupilUserId)).toBe(false);

    await setPolicy(DEFAULT_POLICY);
    expect(await canReadOwnProfile(client, pupilUserId)).toBe(true);
    expect((await status(client)).required).toBe(false);
  });

  it('keeps the policy helpers out of reach of a signed-in client', async () => {
    // The helpers are reached only from inside other SECURITY DEFINER
    // functions, which run as their owner — so a client needs no EXECUTE on
    // them, and granting it would undo the restriction on
    // mfa_policy_effective: mfa_role_enforced_now('student') answers "which
    // roles does this deployment gate?", and mfa_role_state(<uuid>) probes
    // another account's role class.
    const client = await signedIn(pupilEmail);

    for (const [fn, args] of [
      ['mfa_policy', {}],
      ['mfa_role_enforced_now', { _role: 'student' }],
      ['mfa_role_in_policy', { _role: 'student' }],
      ['mfa_role_state', { _user_id: instructorUserId }],
      ['mfa_user_roles', { _user_id: instructorUserId }],
      ['mfa_user_deadline', { _user_id: instructorUserId }],
    ] as const) {
      const { error } = await client.rpc(fn as never, args as never);
      expect(error, `${fn} should not be callable by authenticated`).not.toBeNull();
    }

    // And the one a client is meant to call still works — otherwise this
    // test would pass just as well with the whole feature broken.
    const { error: allowed } = await client.rpc('mfa_enrollment_status');
    expect(allowed).toBeNull();
  });

  it('a suspended membership confers no role, so it is not enforced on', async () => {
    // Suspension already removes authority everywhere else; enforcing MFA on
    // the strength of a membership that grants nothing would lock someone out
    // over a role they cannot use.
    const email = `rls-role-suspended-${uid}@test.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);
    const userId = data.user.id;

    try {
      await addUserToInstitution(admin, userId, institutionId, 'instructor');
      const { error: suspendError } = await admin
        .from('user_institutions')
        .update({ is_suspended: true })
        .eq('user_id', userId)
        .eq('institution_id', institutionId);
      expect(suspendError).toBeNull();

      await setPolicy({ ...DEFAULT_POLICY, instructor: null });
      const client = await signedIn(email);
      expect((await status(client)).required).toBe(false);
    } finally {
      await setPolicy(DEFAULT_POLICY);
      await admin.from('user_institutions').delete().eq('user_id', userId);
      await admin.auth.admin.deleteUser(userId);
    }
  }, 60_000);
});
