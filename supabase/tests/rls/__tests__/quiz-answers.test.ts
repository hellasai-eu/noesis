import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuestion,
  createQuiz,
  createQuizSession,
  createQuizAnswer,
  addUserToInstitution,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('quiz_answers RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let quizId: string;
  let questionId: string;

  let adminClient: SupabaseClient;
  let userAClient: SupabaseClient;
  let userAId: string;
  let userBClient: SupabaseClient;
  let userBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS QAnsw ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    quizId = await createQuiz(admin, courseId);
    questionId = await createQuestion(admin, courseId);

    const adm = await createTestUserClient(admin, `rls-qa-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const a = await createTestUserClient(admin, `rls-qa-a-${uid}@test.local`);
    userAClient = a.client; userAId = a.userId; userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'student');
    await enrollInClass(admin, classId, a.userId, 'student');

    const b = await createTestUserClient(admin, `rls-qa-b-${uid}@test.local`);
    userBClient = b.client; userBId = b.userId; userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'student');
    await enrollInClass(admin, classId, b.userId, 'student');

    const sessionA = await createQuizSession(admin, quizId, userAId, courseId);
    const sessionB = await createQuizSession(admin, quizId, userBId, courseId);
    await createQuizAnswer(admin, sessionA, questionId, userAId, courseId);
    await createQuizAnswer(admin, sessionB, questionId, userBId, courseId);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('user can see their own answers', async () => {
    const { data, error } = await userAClient
      .from('quiz_answers').select('id').eq('user_id', userAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('user cannot see other user answers', async () => {
    const { data, error } = await userAClient
      .from('quiz_answers').select('id').eq('user_id', userBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin can see all answers in their course', async () => {
    const { data, error } = await adminClient
      .from('quiz_answers').select('id').eq('course_id', courseId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  // #1094 — students no longer write their own answers. The INSERT policy is
  // gone, because it could authorise WHO the row was about but never whether
  // the `is_correct` on it was true. `record_quiz_answers` (service role, from
  // the `submit-quiz-answers` edge function) is the only writer; its own suite
  // is record-quiz-answers-rpc.test.ts.
  it('user cannot insert their own answer', async () => {
    const session = await createQuizSession(admin, quizId, userAId, courseId);
    const { error } = await userAClient
      .from('quiz_answers')
      .insert({
        session_id: session,
        question_id: questionId,
        user_id: userAId,
        course_id: courseId,
        selected_answer: 1,
        is_correct: false,
      });
    expect(error).not.toBeNull();
  });

  it('user cannot insert answer for another user', async () => {
    const session = await createQuizSession(admin, quizId, userBId, courseId);
    const { error } = await userAClient
      .from('quiz_answers')
      .insert({
        session_id: session,
        question_id: questionId,
        user_id: userBId,
        course_id: courseId,
        selected_answer: 1,
        is_correct: false,
      });
    expect(error).not.toBeNull();
  });

  it('student cannot delete other user answers', async () => {
    const { data } = await userAClient
      .from('quiz_answers').delete().eq('user_id', userBId).select();
    expect(data).toHaveLength(0);
  });
});
