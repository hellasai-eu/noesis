import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  addUserToInstitution,
  createCourse,
  createClass,
  createOffering,
  enrollInClass,
  assignCourseInstructor,
  addSectionRestriction,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('user_institutions RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;

  let adminClient: SupabaseClient;
  let adminUserId: string;
  let memberClient: SupabaseClient;
  let memberId: string;
  let outsiderClient: SupabaseClient;
  let outsiderId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS UserInst ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS UserInst Other ${uid}`);

    const adm = await createTestUserClient(admin, `rls-ui-adm-${uid}@test.local`);
    adminClient = adm.client; adminUserId = adm.userId; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const mem = await createTestUserClient(admin, `rls-ui-mem-${uid}@test.local`);
    memberClient = mem.client; memberId = mem.userId; userIds.push(mem.userId);
    await addUserToInstitution(admin, mem.userId, institutionId, 'student');

    const out = await createTestUserClient(admin, `rls-ui-out-${uid}@test.local`);
    outsiderClient = out.client; outsiderId = out.userId; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, otherInstitutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  it('user can see their own memberships', async () => {
    const { data, error } = await memberClient
      .from('user_institutions').select('user_id').eq('user_id', memberId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('user cannot see memberships from other institution', async () => {
    const { data, error } = await memberClient
      .from('user_institutions').select('user_id').eq('user_id', outsiderId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin can see all memberships in their institution', async () => {
    const { data, error } = await adminClient
      .from('user_institutions').select('user_id').eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  it('admin cannot see memberships from other institution', async () => {
    const { data, error } = await adminClient
      .from('user_institutions').select('user_id').eq('institution_id', otherInstitutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin can insert membership in their institution', async () => {
    const newUser = await createTestUserClient(admin, `rls-ui-new-${uid}@test.local`);
    userIds.push(newUser.userId);
    const { error } = await adminClient
      .from('user_institutions')
      .insert({ user_id: newUser.userId, institution_id: institutionId, role: 'student' });
    expect(error).toBeNull();
  });

  it('student cannot insert membership', async () => {
    const newUser = await createTestUserClient(admin, `rls-ui-blocked-${uid}@test.local`);
    userIds.push(newUser.userId);
    const { error } = await memberClient
      .from('user_institutions')
      .insert({ user_id: newUser.userId, institution_id: institutionId, role: 'student' });
    expect(error).not.toBeNull();
  });
});


// The student profile page (`/student/:userId/profile`) opens by reading the
// target student's membership row — it needs the institution to scope every
// query after it, plus the grade level and joined-at date for the header. Until
// this policy, nothing returned that row to an instructor: the SELECT policies
// were "your own row" and "admins can view memberships", so RLS filtered the
// result to nothing and the page concluded the student did not exist. Every
// instructor who followed the link from Student 360 got "Student not found".
describe("instructors can read their own students' memberships", () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;
  let courseId: string;
  let otherCourseId: string;
  let classAId: string;
  let classBId: string;

  let unrestricted: SupabaseClient;
  let restrictedToA: SupabaseClient;
  let restrictedToB: SupabaseClient;
  let strangerClient: SupabaseClient;
  let strangerId: string;

  let studentAId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS UIInstr ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS UIInstr Other ${uid}`);
    courseId = await createCourse(admin, institutionId);
    otherCourseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    classBId = await createClass(admin, institutionId);
    await createOffering(admin, classAId, courseId);
    await createOffering(admin, classBId, courseId);

    const u = await createTestUserClient(admin, `rls-ui-teach-u-${uid}@test.local`);
    unrestricted = u.client;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    const ra = await createTestUserClient(admin, `rls-ui-teach-a-${uid}@test.local`);
    restrictedToA = ra.client;
    userIds.push(ra.userId);
    await addUserToInstitution(admin, ra.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, ra.userId);
    await addSectionRestriction(admin, courseId, classAId, ra.userId);

    const rb = await createTestUserClient(admin, `rls-ui-teach-b-${uid}@test.local`);
    restrictedToB = rb.client;
    userIds.push(rb.userId);
    await addUserToInstitution(admin, rb.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, rb.userId);
    await addSectionRestriction(admin, courseId, classBId, rb.userId);

    // Teaches a course nobody in class A takes.
    const st = await createTestUserClient(admin, `rls-ui-teach-x-${uid}@test.local`);
    strangerClient = st.client;
    strangerId = st.userId;
    userIds.push(st.userId);
    await addUserToInstitution(admin, st.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, st.userId);

    const sa = await createTestUserClient(admin, `rls-ui-teach-stu-${uid}@test.local`);
    studentAId = sa.userId;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');
    // The same person also studies somewhere else entirely.
    await addUserToInstitution(admin, sa.userId, otherInstitutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  it('an unrestricted instructor of the course sees the membership', async () => {
    // The case that was broken: no rows in course_instructor_sections means
    // unrestricted, not "no sections".
    const { data, error } = await unrestricted
      .from('user_institutions')
      .select('user_id, institution_id')
      .eq('user_id', studentAId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('an instructor restricted to the student\'s section sees it', async () => {
    const { data, error } = await restrictedToA
      .from('user_institutions')
      .select('user_id')
      .eq('user_id', studentAId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('an instructor restricted to another section does not', async () => {
    const { data, error } = await restrictedToB
      .from('user_institutions')
      .select('user_id')
      .eq('user_id', studentAId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an instructor of an unrelated course does not', async () => {
    const { data, error } = await strangerClient
      .from('user_institutions')
      .select('user_id')
      .eq('user_id', studentAId)
      .eq('institution_id', institutionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('teaching a student does not expose their membership elsewhere', async () => {
    // The institution is pinned to the row being decided, so the student's
    // membership of another institution stays invisible to an instructor who
    // teaches them here.
    const { data, error } = await unrestricted
      .from('user_institutions')
      .select('institution_id')
      .eq('user_id', studentAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].institution_id).toBe(institutionId);
  });

  it('the predicate answers about the caller, not about a supplied id', async () => {
    // The rpc takes no instructor argument, so the only thing it can report on
    // is the person holding the token. Two callers, one pair of ids, two
    // answers — which is what stops it being a boolean oracle about other
    // people's teaching relationships.
    const asTeacher = await unrestricted.rpc('instructor_teaches_student', {
      _student_id: studentAId,
      _institution_id: institutionId,
    });
    expect(asTeacher.error).toBeNull();
    expect(asTeacher.data).toBe(true);

    const asStranger = await strangerClient.rpc('instructor_teaches_student', {
      _student_id: studentAId,
      _institution_id: institutionId,
    });
    expect(asStranger.error).toBeNull();
    expect(asStranger.data).toBe(false);
  });

  it('the policy does not expose colleagues, only students', async () => {
    // `role = 'student'` in the policy: an instructor gains sight of the people
    // they teach, not of which institutions other staff belong to.
    const { data, error } = await unrestricted
      .from('user_institutions')
      .select('user_id')
      .eq('user_id', strangerId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
