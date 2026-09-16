// DB-level tests for evaluator access being tied to a live membership
// (migration 20260726130000).
//
// `is_course_evaluator()` used to authorise purely on a `course_evaluators` row
// existing. That made the row itself the grant, so anything failing to delete
// it left the access standing — and no transaction around the delete can fix
// the race, because an admin assigning a course writes `course_evaluators`
// without touching the membership row the revoke locks.
//
// The last test here is that race, run for real against two connections.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient } from '../helpers/auth';
import { execSql, queryScalar, DB_URL } from '../helpers/sql';

const INST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const COURSE = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

let admin: SupabaseClient;
let subject = '';
let institutionAdmin = '';

function grants(): boolean {
  return (
    queryScalar(`SELECT public.is_course_evaluator('${COURSE}', '${subject}');`) === 't'
  );
}

function assignmentCount(): number {
  return Number(
    queryScalar(
      `SELECT count(*) FROM public.course_evaluators
        WHERE user_id = '${subject}' AND course_id = '${COURSE}';`
    )
  );
}

/** Evaluator membership + assignment, the shape every legitimate writer creates. */
function seed(role = 'evaluator', assign = true): void {
  execSql(`
    DELETE FROM public.course_evaluators WHERE user_id = '${subject}';
    DELETE FROM public.user_institutions WHERE user_id = '${subject}';
    INSERT INTO public.user_institutions (user_id, institution_id, role)
      VALUES ('${subject}', '${INST}', '${role}');
    ${assign ? `INSERT INTO public.course_evaluators (user_id, course_id) VALUES ('${subject}', '${COURSE}');` : ''}
  `);
}

beforeAll(async () => {
  admin = getAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: `evaluator-access-${Date.now()}@test.local`,
    password: 'testpass123',
    email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  subject = data.user.id;

  // `set_institution_membership_role()` authorizes against auth.uid(), so the
  // concurrency test below needs a real institution admin to act as.
  const { data: adminUser, error: adminError } = await admin.auth.admin.createUser({
    email: `evaluator-access-admin-${Date.now()}@test.local`,
    password: 'testpass123',
    email_confirm: true,
  });
  if (adminError) throw new Error(`createUser (admin): ${adminError.message}`);
  institutionAdmin = adminUser.user.id;

  execSql(`
    INSERT INTO public.institutions (id, name, slug)
      VALUES ('${INST}', 'Evaluator Access Fixture', 'evaluator-access-fixture')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.courses (id, title, institution_id)
      VALUES ('${COURSE}', 'Evaluator access fixture course', '${INST}')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.user_institutions (user_id, institution_id, role)
      VALUES ('${institutionAdmin}', '${INST}', 'admin')
      ON CONFLICT (user_id, institution_id) DO UPDATE SET role = 'admin';
  `);
});

afterAll(async () => {
  execSql(`
    DELETE FROM public.course_evaluators WHERE user_id = '${subject}';
    DELETE FROM public.user_institutions WHERE user_id IN ('${subject}', '${institutionAdmin}');
    DELETE FROM public.courses WHERE id = '${COURSE}';
    DELETE FROM public.institutions WHERE id = '${INST}';
  `);
  if (subject) await admin.auth.admin.deleteUser(subject).catch(() => undefined);
  if (institutionAdmin) {
    await admin.auth.admin.deleteUser(institutionAdmin).catch(() => undefined);
  }
});

describe('is_course_evaluator', () => {
  it('still grants access to an actual evaluator', () => {
    // The point of the change is to narrow the grant, so the first thing to
    // prove is that it did not lock evaluators out.
    seed('evaluator');
    expect(grants()).toBe(true);
  });

  it('grants nothing once the role changes, even with the assignment intact', () => {
    seed('evaluator');
    execSql(
      `UPDATE public.user_institutions SET role = 'student'
        WHERE user_id = '${subject}' AND institution_id = '${INST}';`
    );

    expect(assignmentCount()).toBe(1); // the row is deliberately left behind
    expect(grants()).toBe(false);
  });

  it('grants nothing without a membership at all', () => {
    seed('evaluator');
    execSql(`DELETE FROM public.user_institutions WHERE user_id = '${subject}';`);

    expect(grants()).toBe(false);
  });

  it('grants nothing while the membership is suspended', () => {
    // Suspension exists to cut access off; evaluator was the one role where it
    // did not, since the grant never looked at the membership.
    seed('evaluator');
    execSql(
      `UPDATE public.user_institutions SET is_suspended = true
        WHERE user_id = '${subject}' AND institution_id = '${INST}';`
    );

    expect(grants()).toBe(false);
  });
});

describe('course_evaluators membership trigger', () => {
  it('accepts an assignment for a current evaluator', () => {
    seed('evaluator', false);
    expect(() =>
      execSql(
        `INSERT INTO public.course_evaluators (user_id, course_id)
           VALUES ('${subject}', '${COURSE}');`
      )
    ).not.toThrow();
  });

  it('refuses an assignment for someone who is not an evaluator', () => {
    seed('student', false);
    expect(() =>
      execSql(
        `INSERT INTO public.course_evaluators (user_id, course_id)
           VALUES ('${subject}', '${COURSE}');`
      )
    ).toThrow(/not an active evaluator/);
  });

  it('refuses an assignment for a non-member of the institution', () => {
    execSql(`
      DELETE FROM public.course_evaluators WHERE user_id = '${subject}';
      DELETE FROM public.user_institutions WHERE user_id = '${subject}';
    `);
    expect(() =>
      execSql(
        `INSERT INTO public.course_evaluators (user_id, course_id)
           VALUES ('${subject}', '${COURSE}');`
      )
    ).toThrow(/not a member/);
  });
});

describe('concurrent assignment during a membership change', () => {
  it('cannot slip an assignment past the revoke', async () => {
    seed('evaluator', false);

    // Connection A: run the revoke and hold its transaction open, so its
    // `FOR UPDATE` on the membership row is still held when B arrives. This is
    // the window the finding described — with the old schema, B's insert sailed
    // past A's DELETE and the assignment outlived the role change.
    //
    // The `request.jwt.claims` line is load-bearing. psql connects as the
    // `postgres` superuser, where auth.uid() is NULL, and
    // `set_institution_membership_role()` authorizes against auth.uid() — so
    // without an identity it raises 42501 before taking any lock, A never
    // revokes anything, and B's insert then legitimately succeeds against a
    // still-`evaluator` membership. The race would silently never be exercised.
    const holder = execFile('psql', [
      DB_URL,
      '-v',
      'ON_ERROR_STOP=1',
      '-tAX',
      '-c',
      `BEGIN;
       SELECT set_config(
         'request.jwt.claims',
         json_build_object('sub', '${institutionAdmin}')::text,
         true
       );
       SELECT public.set_institution_membership_role(
         '${subject}', '${INST}', 'student'
       );
       SELECT pg_sleep(3);
       COMMIT;`,
    ]);

    // Let A get its lock before B tries to insert.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // B blocks on `FOR SHARE` until A commits, then re-reads the row, finds
    // `student`, and is rejected. Synchronous on purpose: the block is the
    // behaviour under test.
    expect(() =>
      execSql(
        `INSERT INTO public.course_evaluators (user_id, course_id)
           VALUES ('${subject}', '${COURSE}');`
      )
    ).toThrow(/not an active evaluator/);

    await new Promise((resolve) => holder.on('close', resolve));

    expect(assignmentCount()).toBe(0);
    expect(grants()).toBe(false);
  }, 30_000);
});
