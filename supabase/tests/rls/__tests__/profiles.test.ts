import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  addUserToInstitution,
  createCourse,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('profiles RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;

  let userAClient: SupabaseClient;
  let userAId: string;
  let userBClient: SupabaseClient;
  let userBId: string;
  let adminClient: SupabaseClient;
  let adminUserId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Profiles ${uid}`);

    const a = await createTestUserClient(admin, `rls-prof-a-${uid}@test.local`);
    userAClient = a.client; userAId = a.userId; userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'student');

    const b = await createTestUserClient(admin, `rls-prof-b-${uid}@test.local`);
    userBClient = b.client; userBId = b.userId; userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'student');

    const adm = await createTestUserClient(admin, `rls-prof-adm-${uid}@test.local`);
    adminClient = adm.client; adminUserId = adm.userId; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('user can see their own profile', async () => {
    const { data, error } = await userAClient
      .from('profiles').select('user_id').eq('user_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('user cannot see another user profile', async () => {
    const { data, error } = await userAClient
      .from('profiles').select('user_id').eq('user_id', userBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin can see profiles in their institution', async () => {
    const { data, error } = await adminClient
      .from('profiles').select('user_id').in('user_id', [userAId, userBId]);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  it('user can update their own profile', async () => {
    const { error } = await userAClient
      .from('profiles').update({ full_name: 'Updated Name' }).eq('user_id', userAId);
    expect(error).toBeNull();
  });

  it('user cannot update another profile', async () => {
    const { data } = await userAClient
      .from('profiles').update({ full_name: 'Hacked' }).eq('user_id', userBId).select();
    expect(data).toHaveLength(0);
  });
});

/**
 * Course managers can resolve each other's names
 * (20260906090000_course_managers_can_resolve_each_other.sql).
 *
 * Before this policy, `profiles` was readable only for yourself, for admins of
 * your institution, and for students you teach — so an instructor could not
 * read a co-instructor's profile and every Author column said "Unknown" for a
 * colleague's work.
 */
describe('profiles RLS — course managers resolve each other', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;
  let sharedCourseId: string;
  let otherCourseId: string;

  // Two instructors on the SAME course.
  let teachA: SupabaseClient;
  let teachAId: string;
  let teachBId: string;
  // An instructor of a different course in the same institution.
  let strangerId: string;
  // A student of the institution, and an instructor of another institution.
  let studentId: string;
  let foreignInstructorId: string;
  // An admin of the institution that owns the shared course.
  let instAdminId: string;
  // Suspended counterparts: suspension keeps the role and the course
  // assignment, and removes the power (20260323000000).
  let suspendedAdminId: string;
  let suspendedTeacherId: string;
  let suspendedCaller: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS CoMgr ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS CoMgr Other ${uid}`);
    sharedCourseId = await createCourse(admin, institutionId);
    otherCourseId = await createCourse(admin, institutionId);

    const a = await createTestUserClient(admin, `rls-comgr-a-${uid}@test.local`);
    teachA = a.client; teachAId = a.userId; userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, sharedCourseId, a.userId);

    const b = await createTestUserClient(admin, `rls-comgr-b-${uid}@test.local`);
    teachBId = b.userId; userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, sharedCourseId, b.userId);

    const stranger = await createTestUserClient(admin, `rls-comgr-s-${uid}@test.local`);
    strangerId = stranger.userId; userIds.push(stranger.userId);
    await addUserToInstitution(admin, stranger.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, stranger.userId);

    const student = await createTestUserClient(admin, `rls-comgr-stu-${uid}@test.local`);
    studentId = student.userId; userIds.push(student.userId);
    await addUserToInstitution(admin, student.userId, institutionId, 'student');

    const foreign = await createTestUserClient(admin, `rls-comgr-f-${uid}@test.local`);
    foreignInstructorId = foreign.userId; userIds.push(foreign.userId);
    await addUserToInstitution(admin, foreign.userId, otherInstitutionId, 'instructor');

    const instAdmin = await createTestUserClient(admin, `rls-comgr-adm-${uid}@test.local`);
    instAdminId = instAdmin.userId; userIds.push(instAdmin.userId);
    await addUserToInstitution(admin, instAdmin.userId, institutionId, 'admin');

    // A suspended admin of the same institution.
    const suspAdmin = await createTestUserClient(admin, `rls-comgr-sadm-${uid}@test.local`);
    suspendedAdminId = suspAdmin.userId; userIds.push(suspAdmin.userId);
    await addUserToInstitution(admin, suspAdmin.userId, institutionId, 'admin');
    await suspend(suspAdmin.userId);

    // A suspended instructor who still holds the shared course assignment.
    const suspTeacher = await createTestUserClient(admin, `rls-comgr-stea-${uid}@test.local`);
    suspendedTeacherId = suspTeacher.userId; userIds.push(suspTeacher.userId);
    await addUserToInstitution(admin, suspTeacher.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, sharedCourseId, suspTeacher.userId);
    await suspend(suspTeacher.userId);

    // …and one used as the CALLER, to prove suspension cuts both ways.
    const suspCaller = await createTestUserClient(admin, `rls-comgr-scal-${uid}@test.local`);
    suspendedCaller = suspCaller.client; userIds.push(suspCaller.userId);
    await addUserToInstitution(admin, suspCaller.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, sharedCourseId, suspCaller.userId);
    await suspend(suspCaller.userId);
  });

  async function suspend(userId: string): Promise<void> {
    const { error } = await admin
      .from('user_institutions')
      .update({ is_suspended: true })
      .eq('user_id', userId)
      .eq('institution_id', institutionId);
    if (error) throw new Error(`suspend: ${error.message}`);
  }

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    await cleanupScaffold(admin, { institutionId: otherInstitutionId, userIds: [] });
  });

  it('an instructor can read a co-instructor of the same course', async () => {
    const { data, error } = await teachA
      .from('profiles').select('user_id, full_name, email').eq('user_id', teachBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('an instructor can read an admin of the institution that owns their course', async () => {
    // Admins author content in every course of their institution, so they turn
    // up in the Author column of a course they never teach.
    const { data, error } = await teachA
      .from('profiles').select('user_id').eq('user_id', instAdminId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('an instructor cannot read an instructor of a course they do not share', async () => {
    const { data, error } = await teachA
      .from('profiles').select('user_id').eq('user_id', strangerId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('the policy grants no access to students — that is the section policy\'s job', async () => {
    // This student sits in no class of the shared course, so nothing should
    // resolve them for this instructor.
    const { data, error } = await teachA
      .from('profiles').select('user_id').eq('user_id', studentId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an instructor cannot read anyone from another institution', async () => {
    const { data, error } = await teachA
      .from('profiles').select('user_id').eq('user_id', foreignInstructorId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('is SELECT only — a co-instructor profile still cannot be updated', async () => {
    const { data } = await teachA
      .from('profiles').update({ full_name: 'Hacked' }).eq('user_id', teachBId).select();
    expect(data).toHaveLength(0);
  });

  it('a SUSPENDED admin is not resolvable, though the row keeps role=admin', async () => {
    // Suspension preserves the role and marks the membership inactive, which
    // is why every canonical predicate (is_institution_admin and friends)
    // excludes those rows. Matching them here keeps a suspended admin's name
    // and email from leaking to instructors.
    const { data, error } = await teachA
      .from('profiles').select('user_id').eq('user_id', suspendedAdminId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('a SUSPENDED co-instructor is not resolvable either', async () => {
    // Their `course_instructors` row survives suspension, so the course
    // assignment alone must not be enough.
    const { data, error } = await teachA
      .from('profiles').select('user_id').eq('user_id', suspendedTeacherId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('a SUSPENDED caller resolves nobody, despite still holding the assignment', async () => {
    const { data: co } = await suspendedCaller
      .from('profiles').select('user_id').eq('user_id', teachBId);
    expect(co).toHaveLength(0);

    const { data: adminRow } = await suspendedCaller
      .from('profiles').select('user_id').eq('user_id', instAdminId);
    expect(adminRow).toHaveLength(0);
  });

  it('the rpc reports on the CALLER, so it cannot be asked about other people', async () => {
    // shares_course_management takes only the target: called by an outsider it
    // answers for the outsider, never for the pair (stranger, teachB).
    const { data, error } = await teachA.rpc('shares_course_management', {
      _target: strangerId,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);

    const { data: shared } = await teachA.rpc('shares_course_management', {
      _target: teachBId,
    });
    expect(shared).toBe(true);
  });
});
