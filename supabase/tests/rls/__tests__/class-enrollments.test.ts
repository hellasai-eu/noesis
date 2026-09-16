import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createClass,
  createCourse,
  createOffering,
  assignCourseInstructor,
  addUserToInstitution,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('class_enrollments RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let classId: string;

  let adminClient: SupabaseClient;
  let adminUserId: string;
  let instructorClient: SupabaseClient;
  let instructorId: string;
  let studentClient: SupabaseClient;
  let studentId: string;
  let outsiderClient: SupabaseClient;
  let outsiderId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Enroll ${uid}`);
    classId = await createClass(admin, institutionId);

    const adm = await createTestUserClient(admin, `rls-enr-adm-${uid}@test.local`);
    adminClient = adm.client; adminUserId = adm.userId; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    // Instructors are no longer class *enrolments* — 20260403000000 added
    // chk_student_enrollments_only and moved the assignment to
    // course_instructors, which `is_class_instructor(class_id)` resolves
    // through the class's offering.
    const inst = await createTestUserClient(admin, `rls-enr-inst-${uid}@test.local`);
    instructorClient = inst.client; instructorId = inst.userId; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    const courseId = await createCourse(admin, institutionId);
    await createOffering(admin, classId, courseId);
    await assignCourseInstructor(admin, courseId, inst.userId);

    const stu = await createTestUserClient(admin, `rls-enr-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const stu2 = await createTestUserClient(admin, `rls-enr-stu2-${uid}@test.local`);
    userIds.push(stu2.userId);
    await addUserToInstitution(admin, stu2.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu2.userId, 'student');

    const out = await createTestUserClient(admin, `rls-enr-out-${uid}@test.local`);
    outsiderClient = out.client; outsiderId = out.userId; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, institutionId, 'student');
    // outsider not enrolled in class
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('class member can see roster', async () => {
    const { data, error } = await studentClient
      .from('class_enrollments').select('user_id').eq('class_id', classId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2); // two enrolled students
  });

  it('assigned instructor can see the roster without being enrolled', async () => {
    const { data, error } = await instructorClient
      .from('class_enrollments').select('user_id').eq('class_id', classId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  it('non-member cannot see roster', async () => {
    const { data, error } = await outsiderClient
      .from('class_enrollments').select('user_id').eq('class_id', classId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin can insert enrollment', async () => {
    const { error } = await adminClient
      .from('class_enrollments')
      .insert({ class_id: classId, user_id: outsiderId, role: 'student' });
    expect(error).toBeNull();
    // Cleanup
    await admin.from('class_enrollments').delete().eq('class_id', classId).eq('user_id', outsiderId);
  });

  it('student cannot insert enrollment', async () => {
    const newUser = await createTestUserClient(admin, `rls-enr-blocked-${uid}@test.local`);
    userIds.push(newUser.userId);
    await addUserToInstitution(admin, newUser.userId, institutionId, 'student');
    const { error } = await studentClient
      .from('class_enrollments')
      .insert({ class_id: classId, user_id: newUser.userId, role: 'student' });
    expect(error).not.toBeNull();
  });

  it('student cannot delete enrollments', async () => {
    const { data } = await studentClient
      .from('class_enrollments').delete().eq('class_id', classId).eq('user_id', studentId).select();
    expect(data).toHaveLength(0);
  });
});
