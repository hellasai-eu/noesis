import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  enrollInClass,
  addUserToInstitution,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

/**
 * Multi-institution membership — a user who belongs to TWO institutions.
 *
 * `user_institutions` is many-to-many and carries a per-institution `role`, so
 * the data model fully supports this. Several RLS helpers, however, still
 * collapse a user down to a single institution:
 *
 *   get_user_institution_id(_user_id)   -- SELECT institution_id
 *                                       --   FROM user_institutions
 *                                       --  WHERE user_id = _user_id LIMIT 1
 *   is_admin(_user_id)                  -- admin in ANY institution
 *
 * and the live `courses` SELECT policy ("Users can view courses in their
 * institution", 20260401000000) is gated on:
 *
 *   institution_id = get_user_institution_id(auth.uid()) AND (...)
 *
 * so a dual-member only ever sees courses from whichever institution that
 * arbitrary `LIMIT 1` returns. StudentDashboard filters courses with
 * `.eq("institution_id", currentInstitution.id)`, so switching to the "other"
 * institution shows the classes but an empty course list.
 *
 * The tests below encode the intended contract. The ones marked EXPECTED FAIL
 * should go green once the helpers become institution-aware (e.g. policies
 * switch to `user_belongs_to_institution(auth.uid(), institution_id)` and
 * `is_institution_admin(auth.uid(), institution_id)`).
 */
describe('multi-institution membership RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let instB: string;

  // Course the dual student reaches through a class enrolment, per institution.
  let courseA: string;
  let courseB: string;
  // Course in B that nobody is enrolled in — used for the privilege-leak check.
  let unenrolledCourseB: string;

  // Student in BOTH institutions.
  let dualStudentClient: SupabaseClient;
  let dualStudentId: string;

  // Admin in A, plain student in B (no class enrolments in B).
  let crossRoleClient: SupabaseClient;
  let crossRoleId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS MultiInst A ${uid}`);
    instB = await createInstitution(admin, `RLS MultiInst B ${uid}`);

    courseA = await createCourse(admin, instA);
    courseB = await createCourse(admin, instB);
    unenrolledCourseB = await createCourse(admin, instB);

    const classA = await createClass(admin, instA);
    const classB = await createClass(admin, instB);
    await createOffering(admin, classA, courseA);
    await createOffering(admin, classB, courseB);

    const dual = await createTestUserClient(admin, `rls-multi-dual-${uid}@test.local`);
    dualStudentClient = dual.client;
    dualStudentId = dual.userId;
    userIds.push(dual.userId);
    await addUserToInstitution(admin, dual.userId, instA, 'student');
    await addUserToInstitution(admin, dual.userId, instB, 'student');
    await enrollInClass(admin, classA, dual.userId, 'student');
    await enrollInClass(admin, classB, dual.userId, 'student');

    const cross = await createTestUserClient(admin, `rls-multi-cross-${uid}@test.local`);
    crossRoleClient = cross.client;
    crossRoleId = cross.userId;
    userIds.push(cross.userId);
    await addUserToInstitution(admin, cross.userId, instA, 'admin');
    await addUserToInstitution(admin, cross.userId, instB, 'student');
  });

  afterAll(async () => {
    // Institution B first: cleanupScaffold() deletes the auth users, so B's
    // membership rows have to be gone before that happens. Deleting the
    // institution cascades to its classes, courses, offerings and enrolments.
    await admin.from('user_institutions').delete().eq('institution_id', instB);
    await admin.from('institutions').delete().eq('id', instB);
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  describe('membership helpers', () => {
    it('get_user_institution_ids returns both institutions', async () => {
      const { data, error } = await dualStudentClient.rpc('get_user_institution_ids', {
        _user_id: dualStudentId,
      });
      expect(error).toBeNull();
      expect(new Set(data as unknown as string[])).toEqual(new Set([instA, instB]));
    });

    it('user_belongs_to_institution is true for both institutions', async () => {
      for (const institutionId of [instA, instB]) {
        const { data, error } = await dualStudentClient.rpc('user_belongs_to_institution', {
          _user_id: dualStudentId,
          _institution_id: institutionId,
        });
        expect(error).toBeNull();
        expect(data).toBe(true);
      }
    });

    it('get_user_role_in_institution reports the per-institution role', async () => {
      const { data: roleInA } = await crossRoleClient.rpc('get_user_role_in_institution', {
        _user_id: crossRoleId,
        _institution_id: instA,
      });
      const { data: roleInB } = await crossRoleClient.rpc('get_user_role_in_institution', {
        _user_id: crossRoleId,
        _institution_id: instB,
      });
      expect(roleInA).toBe('admin');
      expect(roleInB).toBe('student');
    });

    it('the user sees both of their memberships', async () => {
      const { data, error } = await dualStudentClient
        .from('user_institutions')
        .select('institution_id')
        .eq('user_id', dualStudentId);
      expect(error).toBeNull();
      expect(new Set((data ?? []).map((r) => r.institution_id))).toEqual(
        new Set([instA, instB])
      );
    });

    it('the user sees both institution rows', async () => {
      const { data, error } = await dualStudentClient
        .from('institutions')
        .select('id')
        .in('id', [instA, instB]);
      expect(error).toBeNull();
      expect(data).toHaveLength(2);
    });
  });

  describe('class enrolments across institutions', () => {
    it('the user sees the classes they are enrolled in, in both institutions', async () => {
      const { data, error } = await dualStudentClient
        .from('classes')
        .select('id, institution_id');
      expect(error).toBeNull();
      const institutionIds = (data ?? []).map((c) => c.institution_id);
      expect(institutionIds).toContain(instA);
      expect(institutionIds).toContain(instB);
    });
  });

  describe('course visibility across institutions', () => {
    it('the user sees the course they have class access to in institution A', async () => {
      const { data, error } = await dualStudentClient
        .from('courses')
        .select('id')
        .eq('id', courseA);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('the user sees the course they have class access to in institution B', async () => {
      const { data, error } = await dualStudentClient
        .from('courses')
        .select('id')
        .eq('id', courseB);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    // EXPECTED FAIL until `courses` stops gating on get_user_institution_id():
    // exactly one of the two institutions is reachable, never both.
    it('the user sees their courses from BOTH institutions in one query', async () => {
      const { data, error } = await dualStudentClient
        .from('courses')
        .select('id, institution_id')
        .in('id', [courseA, courseB]);
      expect(error).toBeNull();
      expect(new Set((data ?? []).map((c) => c.institution_id))).toEqual(
        new Set([instA, instB])
      );
    });
  });

  describe('roles do not bleed across institutions', () => {
    // Admin rights held in A must apply in A...
    it('an admin of A sees courses in A they are not enrolled in', async () => {
      const { data, error } = await crossRoleClient
        .from('courses')
        .select('id')
        .eq('id', courseA);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    // ...and must NOT apply in B, where the same user is only a student.
    // `is_admin()` is institution-agnostic, so whichever institution
    // get_user_institution_id() happens to return is the one whose whole course
    // catalogue opens up — meaning one of these two tests always fails today.
    it('an admin of A does not see un-enrolled courses in B, where they are a student', async () => {
      const { data, error } = await crossRoleClient
        .from('courses')
        .select('id')
        .eq('id', unenrolledCourseB);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });
  });
});
