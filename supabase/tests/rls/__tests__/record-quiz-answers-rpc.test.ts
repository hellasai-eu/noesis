// Behaviour under test:
//   public.record_quiz_answers(uuid, uuid, uuid, uuid, uuid, jsonb, boolean)
//
// Migrations:
//   * 20260824120000_server_side_quiz_grading.sql (#1094)
//   * 20260824130000_quiz_answers_match_the_attempt_they_name.sql (review r1)
//
// `quiz_answers` no longer has a student INSERT policy: the browser posts raw
// submissions to the `submit-quiz-answers` edge function, which grades them and
// calls this SECURITY DEFINER function under the service role. That moves five
// checks out of RLS and into the function, and nothing in the frontend or edge
// function tests can observe them — those mock the database out:
//
//   1. The predicates the dropped policy carried (offering attribution, closed
//      assignment) still hold, now against a caller who bypasses RLS.
//   2. The answer's question must belong to the answer's course, which the old
//      policy never checked at all.
//   3. Answers may not be filed into another student's session.
//   4. Nor into the student's own session for a DIFFERENT assignment: the
//      course, quiz and offering arrive as separate parameters, so without this
//      one attempt could be finalized while its answers landed under another.
//   5. The grade must have been computed against the key the question has NOW —
//      the `question_version` check that closes the window
//      `update_question_content` documents as still open (#1094).
//
// Also asserted: `authenticated` cannot EXECUTE the function at all. The
// migration reserves it for `service_role` — the RPC takes `_user_id` as a
// parameter, so a client who could reach it directly could answer as anybody.
// (`scripts/local-db-grants.sh` used to re-grant EXECUTE on every function,
// which made this untestable locally; it no longer touches functions.)

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
  createOfferingQuiz,
  createQuizSession,
  addUserToInstitution,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('record_quiz_answers', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;
  let quizId: string;
  let questionId: string;
  let questionVersion: string;

  let studentId: string;
  let studentClient: SupabaseClient;
  let outsiderId: string;

  // A second course the student is not answering under, for the
  // question-belongs-to-the-course check.
  let otherCourseId: string;
  let otherQuestionId: string;

  const userIds: string[] = [];

  /** The `_answers` element shape the edge function sends. */
  const answer = (
    overrides: Record<string, unknown> = {},
  ) => [{
    question_id: questionId,
    question_version: questionVersion,
    selected_answer: 0,
    submission: { selected_indices: [0] },
    is_correct: true,
    ...overrides,
  }];

  const record = (args: Record<string, unknown>) =>
    admin.rpc('record_quiz_answers', {
      _user_id: studentId,
      _course_id: courseId,
      _quiz_id: quizId,
      _offering_id: offeringId,
      _answers: answer(),
      _finalize: false,
      ...args,
    });

  async function questionUpdatedAt(id: string): Promise<string> {
    const { data, error } = await admin
      .from('questions').select('updated_at').eq('id', id).single();
    if (error) throw new Error(`questionUpdatedAt: ${error.message}`);
    return data.updated_at as string;
  }

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS RecQA ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);
    quizId = await createQuiz(admin, courseId);
    await createOfferingQuiz(admin, offeringId, quizId);
    questionId = await createQuestion(admin, courseId);
    questionVersion = await questionUpdatedAt(questionId);

    otherCourseId = await createCourse(admin, institutionId);
    otherQuestionId = await createQuestion(admin, otherCourseId);

    const s = await createTestUserClient(admin, `rls-rqa-s-${uid}@test.local`);
    studentClient = s.client; studentId = s.userId; userIds.push(s.userId);
    await addUserToInstitution(admin, s.userId, institutionId, 'student');
    await enrollInClass(admin, classId, s.userId, 'student');

    const o = await createTestUserClient(admin, `rls-rqa-o-${uid}@test.local`);
    outsiderId = o.userId; userIds.push(o.userId);
    await addUserToInstitution(admin, o.userId, institutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('records the answer and returns the stored verdict', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);

    const { data, error } = await record({ _session_id: sessionId });
    expect(error).toBeNull();
    expect(data).toEqual([
      { question_id: questionId, is_correct: true, recorded_now: true },
    ]);

    const { data: rows } = await admin
      .from('quiz_answers')
      .select('is_correct, selected_answer, submission, quiz_id, offering_id')
      .eq('session_id', sessionId);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({
      is_correct: true,
      quiz_id: quizId,
      offering_id: offeringId,
    });
  });

  it('is idempotent: a resubmitted answer neither duplicates nor overwrites', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    await record({ _session_id: sessionId });

    // The retry claims the opposite verdict; the first answer stands.
    const { data, error } = await record({
      _session_id: sessionId,
      _answers: answer({ is_correct: false }),
    });
    expect(error).toBeNull();
    expect(data).toEqual([
      { question_id: questionId, is_correct: true, recorded_now: false },
    ]);

    const { data: rows } = await admin
      .from('quiz_answers').select('id').eq('session_id', sessionId);
    expect(rows).toHaveLength(1);
  });

  it('refuses a grade computed against a stale answer key', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);

    // Exactly the race #1094 describes: the key moved between the grading read
    // and the write.
    const { error } = await record({
      _session_id: sessionId,
      _answers: answer({ question_version: '2020-01-01T00:00:00+00:00' }),
    });
    expect(error).not.toBeNull();
    // Signalled by hint, not by SQLSTATE 40001: a "retryable transaction" code
    // gets acted on by what sits between the caller and Postgres, and did.
    expect(error!.hint).toBe('stale_answer_key');
    expect(error!.code).not.toBe('40001');
    expect(error!.message).toContain('answer key changed');

    const { data: rows } = await admin
      .from('quiz_answers').select('id').eq('session_id', sessionId);
    expect(rows).toHaveLength(0);
  });

  it('accepts the same answer once it is re-graded against the new key', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    await admin.from('questions')
      .update({ answer_key: { correct_indices: [1], correct_index: 1 } })
      .eq('id', questionId);
    const newVersion = await questionUpdatedAt(questionId);
    expect(newVersion).not.toBe(questionVersion);

    const stale = await record({
      _session_id: sessionId,
      _answers: answer({ question_version: questionVersion }),
    });
    expect(stale.error!.hint).toBe('stale_answer_key');

    const fresh = await record({
      _session_id: sessionId,
      _answers: answer({ question_version: newVersion }),
    });
    expect(fresh.error).toBeNull();

    // Leave the fixture as the other cases expect to find it.
    questionVersion = newVersion;
  });

  it('refuses a question that belongs to another course', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    const { error } = await record({
      _session_id: sessionId,
      _answers: [{
        question_id: otherQuestionId,
        question_version: await questionUpdatedAt(otherQuestionId),
        selected_answer: 0,
        submission: { selected_indices: [0] },
        is_correct: true,
      }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('does not belong to course');
  });

  it('refuses an offering the student does not sit in', async () => {
    const otherClassId = await createClass(admin, institutionId);
    const otherOfferingId = await createOffering(admin, otherClassId, courseId);
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);

    const { error } = await record({
      _session_id: sessionId,
      _offering_id: otherOfferingId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('may not file work under offering');
  });

  it('refuses answers filed into another student\'s session', async () => {
    const theirSession = await createQuizSession(admin, quizId, outsiderId, courseId, null);
    const { error } = await record({ _session_id: theirSession });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('belongs to another student');
  });

  it('refuses answers for a different quiz than the session is an attempt at', async () => {
    // The student owns the session and is authorised for both quizzes. Without
    // this check the answers would land under `otherQuiz` while the session for
    // `quizId` was finalized — one assignment showing a completed attempt with
    // no answers, the other collecting work from questions the student chose.
    const otherQuiz = await createQuiz(admin, courseId);
    await createOfferingQuiz(admin, offeringId, otherQuiz);
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);

    const { error } = await record({ _session_id: sessionId, _quiz_id: otherQuiz });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('do not belong to attempt');

    const { data: rows } = await admin
      .from('quiz_answers').select('id').eq('session_id', sessionId);
    expect(rows).toHaveLength(0);
  });

  it('refuses answers that drop or move the offering the session names', async () => {
    const secondClassId = await createClass(admin, institutionId);
    const secondOfferingId = await createOffering(admin, secondClassId, courseId);
    await enrollInClass(admin, secondClassId, studentId, 'student');
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);

    // Moving them to another offering the student does sit in...
    const moved = await record({ _session_id: sessionId, _offering_id: secondOfferingId });
    expect(moved.error!.message).toContain('do not belong to attempt');

    // ...and dropping the offering entirely, which would hide the answers from
    // every instructor rather than showing them to the wrong one.
    const dropped = await record({ _session_id: sessionId, _offering_id: null });
    expect(dropped.error!.message).toContain('do not belong to attempt');
  });

  it('refuses quiz answers that name a session which does not exist', async () => {
    // `quiz_answers.session_id` has no foreign key, so without this the whole
    // attribution branch is skipped and the answers land anyway — an attempt
    // nothing counted. A quiz's one-shot-ness lives in `quiz_sessions`, so a
    // student who can write answers without one can re-run the quiz under fresh
    // random ids until the numbers suit them.
    const { error } = await record({ _session_id: crypto.randomUUID() });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('must name an attempt');
  });

  it('accepts practice answers with no session row, because practice has no attempt', async () => {
    // The mirror: `quiz_id` NULL is practice, whose session id is a client-side
    // grouping key that was never a row. Requiring one there would break the
    // surfaces whose answers are not an attempt at anything.
    const { error } = await record({
      _session_id: crypto.randomUUID(),
      _quiz_id: null,
      _offering_id: null,
    });
    expect(error).toBeNull();
  });

  it('lets a session that names no offering have one filled in', async () => {
    // The mirror of the case above: attribution may be set once (that is what
    // `student_work_attribution_is_immutable` allows for these rows), so an
    // unattributed attempt is not stuck.
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, null);

    const { error } = await record({ _session_id: sessionId, _offering_id: offeringId });
    expect(error).toBeNull();
  });

  it('refuses a closed assignment', async () => {
    const closedClassId = await createClass(admin, institutionId);
    const closedOfferingId = await createOffering(admin, closedClassId, courseId);
    await enrollInClass(admin, closedClassId, studentId, 'student');
    await createOfferingQuiz(admin, closedOfferingId, quizId);
    await admin.from('offering_quizzes')
      .update({ closed_at: new Date().toISOString() })
      .eq('offering_id', closedOfferingId)
      .eq('quiz_id', quizId);

    const sessionId = await createQuizSession(
      admin, quizId, studentId, courseId, closedOfferingId,
    );
    const { error } = await record({
      _session_id: sessionId,
      _offering_id: closedOfferingId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain('assignment is closed');
  });

  it('completes the session and clears the draft when asked to finalize', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    await admin.from('quiz_sessions')
      .update({ draft_answers: { v: 1, mcq: { [questionId]: [0] }, nonMcq: {} } })
      .eq('id', sessionId);

    const { error } = await record({ _session_id: sessionId, _finalize: true });
    expect(error).toBeNull();

    const { data: session } = await admin
      .from('quiz_sessions')
      .select('status, completed_at, draft_answers')
      .eq('id', sessionId)
      .single();
    expect(session!.status).toBe('completed');
    expect(session!.completed_at).not.toBeNull();
    expect(session!.draft_answers).toBeNull();
  });

  it('leaves the session open when not asked to finalize', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    await record({ _session_id: sessionId });

    const { data: session } = await admin
      .from('quiz_sessions').select('status').eq('id', sessionId).single();
    expect(session!.status).not.toBe('completed');
  });

  it('a student cannot EXECUTE the RPC directly (service_role only)', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    const { error } = await studentClient.rpc('record_quiz_answers' as never, {
      _user_id: studentId,
      _course_id: courseId,
      _quiz_id: quizId,
      _offering_id: offeringId,
      _session_id: sessionId,
      _answers: [],
      _finalize: false,
    } as never);
    expect(error).not.toBeNull();
    // The ACL denial specifically, not an in-function refusal that happens to
    // share the 42501 code.
    expect(error!.code).toBe('42501');
    expect(error!.message).toContain('permission denied for function record_quiz_answers');
  });

  it('a student cannot write a quiz_answers row directly any more', async () => {
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId, offeringId);
    const { error } = await studentClient
      .from('quiz_answers')
      .insert({
        session_id: sessionId,
        question_id: questionId,
        user_id: studentId,
        course_id: courseId,
        offering_id: offeringId,
        selected_answer: 0,
        submission: { selected_indices: [0] },
        is_correct: true,
      });
    expect(error).not.toBeNull();
  });
});
