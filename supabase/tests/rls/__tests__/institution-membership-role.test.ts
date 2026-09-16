// DB-level tests for public.set_institution_membership_role()
// (migration 20260726120000).
//
// Evaluator read access is granted through `course_evaluators` alone —
// `is_course_evaluator()` never consults `user_institutions` — so a role change
// that leaves those rows behind keeps a former evaluator reading every course
// they reviewed. The function exists to make the membership write and the
// revoke one transaction; doing it from the client left a window where either
// the access or the assignments survived a half-applied change.
//
// The fixtures reach RLS-protected tables and the function is SECURITY DEFINER,
// so the calls go through raw SQL as the local `postgres` superuser like
// data-retention.test.ts. The two accounts are created through the admin API,
// because both `user_institutions.user_id` and `course_evaluators.user_id` now
// carry a foreign key to `auth.users`.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from '../helpers/auth';
import { execSql, queryScalar } from '../helpers/sql';

const INST_A = '11111111-1111-4111-8111-111111111111';
const INST_B = '22222222-2222-4222-8222-222222222222';
const COURSE_A = '44444444-4444-4444-8444-444444444444';
const COURSE_B = '55555555-5555-4555-8555-555555555555';

// Real auth users: `user_institutions.user_id` and `course_evaluators.user_id`
// both carry an ON DELETE CASCADE foreign key to `auth.users` since #932.
let admin: SupabaseClient;
let SUBJECT = '';
let CALLER = '';

/** Institutions, courses and an evaluator holding assignments in both. */
function seed(): void {
  cleanup();
  execSql(`
    INSERT INTO public.institutions (id, name, slug)
      VALUES ('${INST_A}', 'Erasure Fixture A', 'erasure-fixture-a'),
             ('${INST_B}', 'Erasure Fixture B', 'erasure-fixture-b');
    INSERT INTO public.courses (id, title, institution_id)
      VALUES ('${COURSE_A}', 'Fixture course A', '${INST_A}'),
             ('${COURSE_B}', 'Fixture course B', '${INST_B}');
    INSERT INTO public.user_institutions (user_id, institution_id, role)
      VALUES ('${SUBJECT}', '${INST_A}', 'evaluator'),
             ('${SUBJECT}', '${INST_B}', 'evaluator'),
             -- the caller: an admin of A only, so the cross-institution guard
             -- is what the tests actually run against
             ('${CALLER}', '${INST_A}', 'admin');
    INSERT INTO public.course_evaluators (user_id, course_id)
      VALUES ('${SUBJECT}', '${COURSE_A}'), ('${SUBJECT}', '${COURSE_B}');
  `);
}

function cleanup(): void {
  execSql(`
    DELETE FROM public.course_evaluators WHERE user_id = '${SUBJECT}';
    DELETE FROM public.user_institutions WHERE user_id IN ('${SUBJECT}', '${CALLER}');
    DELETE FROM public.courses WHERE id IN ('${COURSE_A}', '${COURSE_B}');
    DELETE FROM public.institutions WHERE id IN ('${INST_A}', '${INST_B}');
  `);
}

function countAssignments(courseId: string): number {
  return Number(
    queryScalar(
      `SELECT count(*) FROM public.course_evaluators
        WHERE user_id = '${SUBJECT}' AND course_id = '${courseId}';`
    )
  );
}

function roleAt(institutionId: string): string {
  return queryScalar(
    `SELECT coalesce(max(role), '') FROM public.user_institutions
      WHERE user_id = '${SUBJECT}' AND institution_id = '${institutionId}';`
  );
}

/**
 * Invokes the function with `auth.uid()` resolving to `callerId`.
 *
 * `postgres` has no JWT, so `auth.uid()` would be NULL and the privilege check
 * would reject every call. Setting `request.jwt.claims` is how `auth.uid()` is
 * fed; it must happen in the same transaction as the call, hence the DO block.
 */
function callAs(role: string | null, callerId = CALLER, institutionId = INST_A): void {
  const roleArg = role === null ? 'NULL' : `'${role}'`;
  execSql(`
    DO $$
    BEGIN
      PERFORM set_config(
        'request.jwt.claims',
        json_build_object('sub', '${callerId}')::text,
        true
      );
      PERFORM public.set_institution_membership_role(
        '${SUBJECT}', '${institutionId}', ${roleArg}
      );
    END $$;
  `);
}

describe('set_institution_membership_role', () => {
  beforeAll(async () => {
    admin = getAdminClient();
    const make = async (label: string) => {
      const { data, error } = await admin.auth.admin.createUser({
        email: `membership-${label}-${Date.now()}@test.local`,
        password: 'testpass123',
        email_confirm: true,
      });
      if (error) throw new Error(`createUser(${label}): ${error.message}`);
      return data.user.id;
    };
    SUBJECT = await make('subject');
    CALLER = await make('caller');
  });

  beforeEach(() => {
    seed();
  });

  afterAll(async () => {
    cleanup();
    for (const id of [SUBJECT, CALLER]) {
      if (id) await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
  });

  it('revokes the evaluator assignments of the institution it changes', () => {
    callAs('student');

    expect(roleAt(INST_A)).toBe('student');
    expect(countAssignments(COURSE_A)).toBe(0);
    // The subject evaluates elsewhere; that must be untouched.
    expect(countAssignments(COURSE_B)).toBe(1);
    expect(roleAt(INST_B)).toBe('evaluator');
  });

  it('revokes them when the membership is removed outright', () => {
    callAs(null);

    expect(roleAt(INST_A)).toBe('');
    // Without this, a user with no membership at all keeps reading the
    // institution's courses.
    expect(countAssignments(COURSE_A)).toBe(0);
    expect(countAssignments(COURSE_B)).toBe(1);
  });

  it('keeps the course scope when the role is re-set to evaluator', () => {
    // A no-op "change" must not wipe the scope. Revoking on the previous role
    // alone would leave a scopeless evaluator — still an evaluator, now seeing
    // nothing — while reporting that nothing had changed.
    callAs('evaluator');

    expect(roleAt(INST_A)).toBe('evaluator');
    expect(countAssignments(COURSE_A)).toBe(1);
  });

  it('leaves assignments alone when the previous role was not evaluator', () => {
    execSql(
      `UPDATE public.user_institutions SET role = 'instructor'
        WHERE user_id = '${SUBJECT}' AND institution_id = '${INST_A}';`
    );

    callAs('admin');

    expect(roleAt(INST_A)).toBe('admin');
    expect(countAssignments(COURSE_A)).toBe(1);
  });

  it('rolls back both writes when the role is rejected', () => {
    // The point of moving this into SQL: a half-applied change must be
    // impossible, in either direction.
    expect(() => callAs('wizard')).toThrow();

    expect(roleAt(INST_A)).toBe('evaluator');
    expect(countAssignments(COURSE_A)).toBe(1);
  });

  it('rejects a caller who administers a different institution', () => {
    // The caller is an admin of A only. Reaching into B is the escalation the
    // guard exists to stop, and SECURITY DEFINER means RLS will not stop it.
    expect(() => callAs('student', CALLER, INST_B)).toThrow();

    expect(roleAt(INST_B)).toBe('evaluator');
    expect(countAssignments(COURSE_B)).toBe(1);
  });

  it('rejects a change to a membership that does not exist', () => {
    execSql(
      `DELETE FROM public.user_institutions
        WHERE user_id = '${SUBJECT}' AND institution_id = '${INST_A}';`
    );

    expect(() => callAs('student')).toThrow();
    // The failed call must not have revoked anything on its way out.
    expect(countAssignments(COURSE_A)).toBe(1);
  });
});
