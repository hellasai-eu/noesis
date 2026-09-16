import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuiz,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('quizzes RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let publishedQuizId: string;
  let unpublishedQuizId: string;

  let adminClient: SupabaseClient;
  let instructorClient: SupabaseClient;
  let studentClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Quizzes ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    publishedQuizId = await createQuiz(admin, courseId, true);
    unpublishedQuizId = await createQuiz(admin, courseId, false);

    const adm = await createTestUserClient(admin, `rls-qz-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const inst = await createTestUserClient(admin, `rls-qz-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const stu = await createTestUserClient(admin, `rls-qz-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('admin can see all quizzes (published + unpublished)', async () => {
    const { data, error } = await adminClient
      .from('quizzes').select('id').eq('course_id', courseId);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('instructor can see all quizzes for their course', async () => {
    const { data, error } = await instructorClient
      .from('quizzes').select('id').eq('course_id', courseId);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('student can see published quizzes', async () => {
    const { data, error } = await studentClient
      .from('quizzes').select('id').eq('id', publishedQuizId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot see unpublished quizzes', async () => {
    const { data, error } = await studentClient
      .from('quizzes').select('id').eq('id', unpublishedQuizId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot insert quiz', async () => {
    const { error } = await studentClient
      .from('quizzes')
      .insert({ course_id: courseId, title: 'Blocked', is_published: false });
    expect(error).not.toBeNull();
  });

  it('student cannot delete quiz', async () => {
    const { data } = await studentClient
      .from('quizzes').delete().eq('id', publishedQuizId).select();
    expect(data).toHaveLength(0);
  });
});
