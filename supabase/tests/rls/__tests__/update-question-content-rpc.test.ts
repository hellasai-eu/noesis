// Behaviour under test:
//   public.update_question_content(uuid, text, jsonb, jsonb, text, text)
//
// Migration:
//   * 20260805120000_update_question_content_rpc.sql (#1001, PR #1093)
//
// This is a SECURITY DEFINER function GRANTed to `authenticated`, so it runs
// with the owner's rights and RLS on `public.questions` never applies to its
// UPDATE. Two things therefore have to hold at the DB level, and neither is
// observable from the frontend test that covers the editor dialog — that test
// mocks the RPC out entirely and only asserts the client sends the right args:
//
//   1. The in-function authorization predicate is the ONLY thing standing
//      between an arbitrary logged-in user and an arbitrary question's content.
//      A student who calls `supabase.rpc('update_question_content', ...)` from
//      the browser console reaches exactly this code path.
//
//   2. The refuse-if-answered guard must count answers the *caller* cannot see.
//      Counting them under the caller's RLS is the bug the definer exists to
//      prevent: a section-restricted instructor would see zero answers in the
//      sections they don't teach and be allowed to rewrite an answer_key that
//      submitted answers were already graded against. Study-guide and quiz
//      answers are immutable — one row per (student, question), no retake — so
//      that silently invalidates a real submission.
//
// Also asserted: `anon` cannot EXECUTE the function — the migration revokes
// it (only `authenticated` and `service_role` may call it; the function then
// authorizes the caller itself). (`scripts/local-db-grants.sh` used to
// re-grant EXECUTE on every function, which made this untestable locally; it
// no longer touches functions.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, getAnonClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuestion,
  createQuiz,
  createQuizSession,
  createQuizAnswer,
  createStudyGuide,
  createStudyGuidePiece,
  createStudyGuideAnswer,
  createOfferingStudyGuide,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSectionRestriction,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('update_question_content', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;
  let courseId: string;
  // Two sections of the same course. `restrictedClassId` is the one the
  // section-restricted instructor teaches; the answered-elsewhere test puts a
  // submission in the offering for `hiddenClassId`, which they cannot see.
  let restrictedClassId: string;
  let hiddenClassId: string;
  let restrictedOfferingId: string;
  let hiddenOfferingId: string;

  let superAdminClient: SupabaseClient;
  let instAdminClient: SupabaseClient;
  let instructorClient: SupabaseClient;
  let restrictedInstructorClient: SupabaseClient;
  let otherCourseInstructorClient: SupabaseClient;
  let studentClient: SupabaseClient;
  let studentId: string;
  // Enrolled in `hiddenClassId`, so their submissions land in an offering the
  // section-restricted instructor genuinely cannot see.
  let hiddenStudentId: string;
  let otherInstAdminClient: SupabaseClient;

  const userIds: string[] = [];
  const superAdminEmail = `rls-uqc-sa-${uid}@test.local`;

  /** Call the RPC as `client` with a full, valid MCQ content payload. */
  function edit(
    client: SupabaseClient,
    questionId: string,
    stem = `edited ${crypto.randomUUID().slice(0, 8)}`
  ) {
    return client.rpc('update_question_content' as never, {
      _question_id: questionId,
      _question: stem,
      _payload: { options: ['W', 'X', 'Y', 'Z'] },
      _answer_key: { correct_indices: [2], correct_index: 2 },
      _explanation: 'edited explanation',
      _difficulty: 'hard',
    } as never);
  }

  /** Read a question back with the service role, bypassing RLS. */
  async function readQuestion(questionId: string) {
    const { data, error } = await admin
      .from('questions')
      .select('question, payload, answer_key, explanation, difficulty, type, updated_at')
      .eq('id', questionId)
      .single();
    if (error) throw new Error(`readQuestion: ${error.message}`);
    return data as {
      question: string;
      payload: { options?: string[] };
      answer_key: { correct_indices?: number[] };
      explanation: string | null;
      difficulty: string;
      type: string;
      updated_at: string;
    };
  }

  /**
   * A question nobody has answered — one per test, so the tests stay
   * independent and the file is re-runnable against a dirty database.
   */
  function freshQuestion() {
    return createQuestion(admin, courseId);
  }

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS UQC ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS UQC Other ${uid}`);

    courseId = await createCourse(admin, institutionId);
    restrictedClassId = await createClass(admin, institutionId);
    hiddenClassId = await createClass(admin, institutionId);
    restrictedOfferingId = await createOffering(admin, restrictedClassId, courseId);
    hiddenOfferingId = await createOffering(admin, hiddenClassId, courseId);

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    const instAdm = await createTestUserClient(admin, `rls-uqc-adm-${uid}@test.local`);
    instAdminClient = instAdm.client; userIds.push(instAdm.userId);
    await addUserToInstitution(admin, instAdm.userId, institutionId, 'admin');

    const inst = await createTestUserClient(admin, `rls-uqc-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    // Same course, but restricted to one section — so `study_guide_answers` in
    // the other section's offering are invisible to them under RLS.
    const restricted = await createTestUserClient(admin, `rls-uqc-rinst-${uid}@test.local`);
    restrictedInstructorClient = restricted.client; userIds.push(restricted.userId);
    await addUserToInstitution(admin, restricted.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, restricted.userId);
    await addSectionRestriction(admin, courseId, restrictedClassId, restricted.userId);

    // An instructor in the same institution who teaches a different course.
    const otherCourseId = await createCourse(admin, institutionId);
    const otherInst = await createTestUserClient(admin, `rls-uqc-oinst-${uid}@test.local`);
    otherCourseInstructorClient = otherInst.client; userIds.push(otherInst.userId);
    await addUserToInstitution(admin, otherInst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, otherInst.userId);

    const stu = await createTestUserClient(admin, `rls-uqc-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, restrictedClassId, stu.userId, 'student');

    const hiddenStu = await createTestUserClient(admin, `rls-uqc-hstu-${uid}@test.local`);
    hiddenStudentId = hiddenStu.userId; userIds.push(hiddenStu.userId);
    await addUserToInstitution(admin, hiddenStu.userId, institutionId, 'student');
    await enrollInClass(admin, hiddenClassId, hiddenStu.userId, 'student');

    const otherAdm = await createTestUserClient(admin, `rls-uqc-otheradm-${uid}@test.local`);
    otherInstAdminClient = otherAdm.client; userIds.push(otherAdm.userId);
    await addUserToInstitution(admin, otherAdm.userId, otherInstitutionId, 'admin');
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await admin.from('user_institutions').delete().eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ── Who may edit ──────────────────────────────────────────────────────

  it('lets a super-admin edit and writes every content column', async () => {
    const questionId = await freshQuestion();
    const before = await readQuestion(questionId);

    const { error } = await edit(superAdminClient, questionId, `sa stem ${uid}`);
    expect(error).toBeNull();

    const after = await readQuestion(questionId);
    expect(after.question).toBe(`sa stem ${uid}`);
    expect(after.payload.options).toEqual(['W', 'X', 'Y', 'Z']);
    expect(after.answer_key.correct_indices).toEqual([2]);
    expect(after.explanation).toBe('edited explanation');
    expect(after.difficulty).toBe('hard');
    // The RPC takes no `_type` — changing a question's type is a
    // delete-and-recreate, deliberately out of scope for the editor (#1001).
    expect(after.type).toBe(before.type);
    expect(new Date(after.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updated_at).getTime()
    );
  });

  it("lets the course institution's admin edit", async () => {
    const questionId = await freshQuestion();

    const { error } = await edit(instAdminClient, questionId, `admin stem ${uid}`);
    expect(error).toBeNull();
    expect((await readQuestion(questionId)).question).toBe(`admin stem ${uid}`);
  });

  it('lets an instructor assigned to the course edit', async () => {
    const questionId = await freshQuestion();

    const { error } = await edit(instructorClient, questionId, `instructor stem ${uid}`);
    expect(error).toBeNull();
    expect((await readQuestion(questionId)).question).toBe(`instructor stem ${uid}`);
  });

  // ── Who may not ───────────────────────────────────────────────────────

  it('anon cannot EXECUTE the RPC at all', async () => {
    const questionId = await freshQuestion();
    const before = await readQuestion(questionId);

    const { error } = await edit(getAnonClient(), questionId);

    expect(error).not.toBeNull();
    // The ACL denial specifically — the function's own unauthorized-caller
    // branch also raises 42501 (insufficient_privilege), but with its own
    // message, so the code alone would not catch a regressed grant.
    expect(error!.code).toBe('42501');
    expect(error!.message).toContain('permission denied for function update_question_content');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('refuses an enrolled student and leaves the question untouched', async () => {
    const questionId = await freshQuestion();
    const before = await readQuestion(questionId);

    const { error } = await edit(studentClient, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('not authorized to edit question');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('refuses an instructor who teaches a different course in the same institution', async () => {
    const questionId = await freshQuestion();
    const before = await readQuestion(questionId);

    const { error } = await edit(otherCourseInstructorClient, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('not authorized to edit question');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('refuses an admin of a different institution', async () => {
    const questionId = await freshQuestion();
    const before = await readQuestion(questionId);

    const { error } = await edit(otherInstAdminClient, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('not authorized to edit question');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('refuses a caller with no auth.uid() — the definer is not a service backdoor', async () => {
    // The service-role client presents no user JWT, so `auth.uid()` is NULL and
    // every branch of the predicate is false. Worth pinning: SECURITY DEFINER
    // functions are easy to mistake for "the backend can always call this".
    const questionId = await freshQuestion();
    const before = await readQuestion(questionId);

    const { error } = await edit(admin, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('not authorized to edit question');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('reports a missing question rather than silently doing nothing', async () => {
    const { error } = await edit(superAdminClient, crypto.randomUUID());

    expect(error).not.toBeNull();
    expect(error!.message).toContain('not found');
  });

  // ── The refuse-if-answered guard ──────────────────────────────────────

  async function answerViaStudyGuide(
    questionId: string,
    offeringId: string,
    userId: string
  ) {
    const studyGuideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, studyGuideId, 0);
    await createOfferingStudyGuide(admin, offeringId, studyGuideId);
    await createStudyGuideAnswer(admin, {
      userId,
      studyGuideId,
      offeringId,
      pieceId,
      questionId,
    });
  }

  async function answerViaQuiz(questionId: string) {
    const quizId = await createQuiz(admin, courseId);
    const sessionId = await createQuizSession(admin, quizId, studentId, courseId);
    await createQuizAnswer(admin, sessionId, questionId, studentId, courseId);
  }

  it('refuses an edit once a study-guide answer exists', async () => {
    const questionId = await freshQuestion();
    await answerViaStudyGuide(questionId, restrictedOfferingId, studentId);
    const before = await readQuestion(questionId);

    const { error } = await edit(superAdminClient, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('cannot be edited');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('refuses an edit once a quiz answer exists', async () => {
    // The distinguishing case against `delete_study_guide_question`, whose guard
    // counts study-guide answers only: a Question Bank row is reachable from
    // quizzes too, so `quiz_answers` has to be counted as well.
    const questionId = await freshQuestion();
    await answerViaQuiz(questionId);
    const before = await readQuestion(questionId);

    const { error } = await edit(superAdminClient, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('cannot be edited');
    expect(await readQuestion(questionId)).toEqual(before);
  });

  it('counts answers in an offering the calling instructor cannot see', async () => {
    // The reason this function is a definer. The answer lives in the section
    // this instructor is restricted away from, so an RLS-scoped count would
    // return zero and let the edit through.
    const questionId = await freshQuestion();
    await answerViaStudyGuide(questionId, hiddenOfferingId, hiddenStudentId);
    const before = await readQuestion(questionId);

    // Precondition: the answer really is invisible to them. Without this the
    // test would still pass if the restriction silently stopped working, and it
    // would no longer be testing what it claims to.
    // The query itself must succeed: a failed request also returns no rows, and
    // swallowing that would make this precondition pass vacuously.
    const { count, error: visibilityError } = await restrictedInstructorClient
      .from('study_guide_answers' as never)
      .select('id', { count: 'exact', head: true })
      .eq('question_id', questionId);
    expect(visibilityError).toBeNull();
    expect(count).toBe(0);

    const { error } = await edit(restrictedInstructorClient, questionId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('cannot be edited');
    expect(await readQuestion(questionId)).toEqual(before);
  });
});
