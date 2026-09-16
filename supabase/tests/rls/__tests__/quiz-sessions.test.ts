import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuiz,
  createQuizSession,
  addUserToInstitution,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('quiz_sessions RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let quizId: string;
  let userASessionId: string;

  let userAClient: SupabaseClient;
  let userAId: string;
  let userBClient: SupabaseClient;
  let userBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS QSess ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    quizId = await createQuiz(admin, courseId);

    const a = await createTestUserClient(admin, `rls-qs-a-${uid}@test.local`);
    userAClient = a.client; userAId = a.userId; userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'student');
    await enrollInClass(admin, classId, a.userId, 'student');

    const b = await createTestUserClient(admin, `rls-qs-b-${uid}@test.local`);
    userBClient = b.client; userBId = b.userId; userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'student');
    await enrollInClass(admin, classId, b.userId, 'student');

    userASessionId = await createQuizSession(admin, quizId, userAId, courseId);
    await createQuizSession(admin, quizId, userBId, courseId);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('user can see their own quiz sessions', async () => {
    const { data, error } = await userAClient
      .from('quiz_sessions').select('id').eq('user_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('user cannot see other user quiz sessions', async () => {
    const { data, error } = await userAClient
      .from('quiz_sessions').select('id').eq('user_id', userBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('user can insert their own quiz session', async () => {
    const { data, error } = await userAClient
      .from('quiz_sessions')
      .insert({ quiz_id: quizId, user_id: userAId, course_id: courseId })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('user cannot insert quiz session for another user', async () => {
    const { error } = await userAClient
      .from('quiz_sessions')
      .insert({ quiz_id: quizId, user_id: userBId, course_id: courseId });
    expect(error).not.toBeNull();
  });
});
