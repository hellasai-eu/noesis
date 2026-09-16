import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuestion,
  createOpenTypeQuestion,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('questions RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  // MCQ sibling — written in the unified shape (`type='mcq'`, `payload`,
  // `answer_key`). The legacy `options` / `correct_answer` columns were
  // dropped by 20260614000000_contract_question_schema.sql (#582).
  let mcqQuestionId: string;
  // Open sibling — absorbed into `questions` by migration
  // 20260613000002_absorb_open_questions.sql (#577).
  let openQuestionId: string;

  let adminClient: SupabaseClient;
  let instructorClient: SupabaseClient;
  let instructorId: string;
  let studentClient: SupabaseClient;
  let studentId: string;
  let unenrolledClient: SupabaseClient;
  let unenrolledId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Questions ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    await createOffering(admin, classId, courseId);
    mcqQuestionId = await createQuestion(admin, courseId);
    openQuestionId = await createOpenTypeQuestion(admin, courseId);

    const adm = await createTestUserClient(admin, `rls-q-adm-${uid}@test.local`);
    adminClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const inst = await createTestUserClient(admin, `rls-q-inst-${uid}@test.local`);
    instructorClient = inst.client; instructorId = inst.userId; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const stu = await createTestUserClient(admin, `rls-q-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const unenr = await createTestUserClient(admin, `rls-q-unenr-${uid}@test.local`);
    unenrolledClient = unenr.client; unenrolledId = unenr.userId; userIds.push(unenr.userId);
    await addUserToInstitution(admin, unenr.userId, institutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ── MCQ rows (type='mcq') ────────────────────────────────────────────

  it('admin can see mcq questions', async () => {
    const { data, error } = await adminClient
      .from('questions').select('id, type, payload, answer_key').eq('id', mcqQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].type).toBe('mcq');
    expect(data![0].payload).toEqual({ options: ['A', 'B', 'C', 'D'] });
    // Multi-correct shape (#592): `correct_indices` is authoritative and the
    // scalar `correct_index` is still dual-written for pre-#592 readers.
    expect(data![0].answer_key).toMatchObject({ correct_indices: [0] });
  });

  it('assigned instructor can see mcq questions', async () => {
    const { data, error } = await instructorClient
      .from('questions').select('id').eq('id', mcqQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('enrolled student can see mcq questions', async () => {
    const { data, error } = await studentClient
      .from('questions').select('id').eq('id', mcqQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('unenrolled student cannot see mcq questions', async () => {
    const { data, error } = await unenrolledClient
      .from('questions').select('id').eq('id', mcqQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  /**
   * #1011 — an enrolled student can read `answer_key` for a question they have
   * not answered.
   *
   * Every other assertion in this suite is about which question ROWS a caller
   * may see. This is the first about which COLUMNS, and it is the gap that let
   * the defect through: the SELECT policy ("Users can view questions for
   * accessible courses", 20251206104325:185) authorizes the whole row via
   * `user_has_course_tag_access`, RLS is row-level, and no migration applies
   * column privileges — so `select=answer_key` succeeds.
   *
   * `it.fails` on purpose, rather than a skip. It asserts the hole is STILL
   * OPEN, so it runs on every CI pass and turns red the moment the database
   * half of #1011 lands — at which point delete the `.fails` and this becomes
   * the regression test. A skip would rot silently and prove nothing.
   *
   * The client half is fixed separately: `StudyGuidePlayer` no longer requests
   * the key for a piece the student has not submitted. That narrows the app's
   * own traffic; it does not and cannot close this, which needs column
   * privileges plus a student read path that excludes the column.
   */
  it.fails('student cannot read answer_key for an unanswered question', async () => {
    const { data, error } = await studentClient
      .from('questions')
      .select('id, answer_key')
      .eq('id', mcqQuestionId)
      .maybeSingle();

    // The row itself stays visible — the student needs it to answer. What must
    // not come back is the key.
    expect(error).toBeNull();
    expect(data?.answer_key ?? null).toBeNull();
  });

  it('instructor can insert mcq question in unified shape', async () => {
    // `payload` / `answer_key` are the sole source of truth since the contract
    // migration dropped `options` / `correct_answer` (#582).
    const options = ['A', 'B', 'C', 'D'];
    const { data, error } = await instructorClient
      .from('questions')
      .insert({
        course_id: courseId,
        question: 'RLS insert test (unified)',
        type: 'mcq',
        payload: { options },
        answer_key: { correct_indices: [0], correct_index: 0 },
        difficulty: 'easy',
        created_by: instructorId,
      })
      .select('id, type, answer_key').single();
    expect(error).toBeNull();
    expect(data?.type).toBe('mcq');
    expect(data?.answer_key).toMatchObject({ correct_indices: [0] });
  });

  it('student cannot insert mcq question', async () => {
    const options = ['A', 'B', 'C', 'D'];
    const { error } = await studentClient
      .from('questions')
      .insert({
        course_id: courseId,
        question: 'Blocked',
        type: 'mcq',
        payload: { options },
        answer_key: { correct_indices: [0], correct_index: 0 },
        difficulty: 'easy',
      });
    expect(error).not.toBeNull();
  });

  it('student cannot delete mcq question', async () => {
    const { data } = await studentClient
      .from('questions').delete().eq('id', mcqQuestionId).select();
    expect(data).toHaveLength(0);
  });

  // ── Open rows (type='open') — absorbed by migration 20260613000002 (#577) ──
  // RLS on `public.questions` is `course_id`-scoped, so the absorbed siblings
  // inherit the same row-level access as MCQ — these cases verify that.

  it('admin can see absorbed open questions', async () => {
    const { data, error } = await adminClient
      .from('questions').select('id, type, answer_key').eq('id', openQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].type).toBe('open');
    expect((data![0].answer_key as { model_answer?: string })?.model_answer).toBe('Test model answer');
  });

  it('assigned instructor can see absorbed open questions', async () => {
    const { data, error } = await instructorClient
      .from('questions').select('id').eq('id', openQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('enrolled student can see absorbed open questions', async () => {
    const { data, error } = await studentClient
      .from('questions').select('id').eq('id', openQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('unenrolled student cannot see absorbed open questions', async () => {
    const { data, error } = await unenrolledClient
      .from('questions').select('id').eq('id', openQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('instructor can insert open question in unified shape', async () => {
    const { data, error } = await instructorClient
      .from('questions')
      .insert({
        course_id: courseId,
        question: 'RLS open insert test',
        type: 'open',
        payload: {},
        answer_key: {
          model_answer: 'Newton\'s second law: F = ma',
          rubric: null,
          explanation: null,
        },
        difficulty: 'easy',
        created_by: instructorId,
      })
      .select('id, type').single();
    expect(error).toBeNull();
    expect(data?.type).toBe('open');
  });

  it('student cannot insert open question', async () => {
    const { error } = await studentClient
      .from('questions')
      .insert({
        course_id: courseId,
        question: 'Blocked open',
        type: 'open',
        payload: {},
        answer_key: {
          model_answer: 'Blocked',
          rubric: null,
          explanation: null,
        },
        difficulty: 'easy',
      });
    expect(error).not.toBeNull();
  });

  it('student cannot delete absorbed open question', async () => {
    const { data } = await studentClient
      .from('questions').delete().eq('id', openQuestionId).select();
    expect(data).toHaveLength(0);
  });

  // ── Votes are scoped to the question's course (20260727010000) ───────

  it('enrolled student can vote on a question in their course', async () => {
    const { error } = await studentClient
      .from('question_votes')
      .insert({ question_id: mcqQuestionId, user_id: studentId, vote_type: 'up' });
    expect(error).toBeNull();
  });

  it('user without access to the course cannot vote on its questions', async () => {
    // Knowing the question uuid used to be enough — INSERT only checked
    // `user_id = auth.uid()`, so any authenticated user could write a vote
    // into any course, in any institution.
    const { error } = await unenrolledClient
      .from('question_votes')
      .insert({ question_id: mcqQuestionId, user_id: unenrolledId, vote_type: 'up' });
    expect(error).not.toBeNull();
  });

  it('can_vote_on_question answers only for the calling user', async () => {
    // The helper backing the policy is SECURITY DEFINER and therefore also
    // reachable as a PostgREST RPC. It takes no user parameter and resolves
    // the actor from auth.uid(), so the same question id gives each caller
    // only their own answer and discloses nothing about the question itself.
    const { data: enrolled, error: enrolledError } = await studentClient.rpc(
      'can_vote_on_question', { _question_id: mcqQuestionId }
    );
    expect(enrolledError).toBeNull();
    expect(enrolled).toBe(true);

    const { data: outsider, error: outsiderError } = await unenrolledClient.rpc(
      'can_vote_on_question', { _question_id: mcqQuestionId }
    );
    expect(outsiderError).toBeNull();
    expect(outsider).toBe(false);
  });
});
