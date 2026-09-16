// Section scoping on quiz results (#1102, part of #1097).
//
// `offering_quizzes` is guarded by `can_manage_offering`, which folds in
// `course_instructor_sections` — so the *assignment* has always been
// section-scoped. `quiz_sessions` and `quiz_answers` were guarded by
// `is_course_instructor`, which is course-level by design. The 1Α instructor
// could not publish a quiz to 1Β but could read every 1Β student's score,
// timing and per-question choices, and delete those answers.
//
// Both tables carry a nullable `offering_id`, which is why the fix resolves the
// section through the student's enrolment
// (`instructor_can_access_student`) rather than through the row. This suite
// therefore tests both kinds of row deliberately:
//
//   * an offering-attributed session, the ordinary assigned-quiz case;
//   * a practice-mode session with `offering_id IS NULL`, which
//     `can_manage_offering(offering_id)` would have made invisible to every
//     instructor, and which `offering_id IS NULL AND is_course_instructor(...)`
//     would have left readable across sections.
//
// `quiz-sessions.test.ts` and `quiz-answers.test.ts` each use a single
// unrestricted instructor and keep passing through all of this, so these cases
// are additions rather than adaptations.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSectionRestriction,
  createQuestion,
  createQuiz,
  createQuizSession,
  createQuizAnswer,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

function ids(data: unknown): string[] {
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe('quiz_sessions / quiz_answers are scoped to the instructor\'s sections', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let quizId: string;
  let questionId: string;

  let classAId: string;
  let offeringAId: string;
  let classBId: string;
  let offeringBId: string;

  let instrA: SupabaseClient; // restricted to section A
  let instrAId: string;
  let instrB: SupabaseClient; // restricted to section B
  let instrBId: string;
  let unrestricted: SupabaseClient; // same course, no restriction rows
  let adminClient: SupabaseClient;

  let studentAId: string;
  let studentBId: string;
  let studentAClient: SupabaseClient;
  let studentBClient: SupabaseClient;

  let sessionAId: string;
  let sessionBId: string;
  let answerAId: string;
  let answerBId: string;

  // Practice mode: no offering, so the row cannot say which section it is for.
  let practiceSessionBId: string;
  let practiceAnswerBId: string;

  // A student sitting in BOTH sections, with work attributed to section B.
  let dualStudentId: string;
  let dualSessionBId: string;
  let dualAnswerBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS QuizSect ${uid}`);
    courseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    offeringAId = await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    offeringBId = await createOffering(admin, classBId, courseId);

    quizId = await createQuiz(admin, courseId);
    questionId = await createQuestion(admin, courseId);

    const a = await createTestUserClient(admin, `rls-qs-a-${uid}@test.local`);
    instrA = a.client;
    instrAId = a.userId;
    userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, a.userId);
    await addSectionRestriction(admin, courseId, classAId, a.userId);

    const b = await createTestUserClient(admin, `rls-qs-b-${uid}@test.local`);
    instrB = b.client;
    instrBId = b.userId;
    userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, b.userId);
    await addSectionRestriction(admin, courseId, classBId, b.userId);

    const u = await createTestUserClient(admin, `rls-qs-u-${uid}@test.local`);
    unrestricted = u.client;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    const ia = await createTestUserClient(admin, `rls-qs-adm-${uid}@test.local`);
    adminClient = ia.client;
    userIds.push(ia.userId);
    await addUserToInstitution(admin, ia.userId, institutionId, 'admin');

    const sa = await createTestUserClient(admin, `rls-qs-stu-a-${uid}@test.local`);
    studentAId = sa.userId;
    studentAClient = sa.client;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    const sb = await createTestUserClient(admin, `rls-qs-stu-b-${uid}@test.local`);
    studentBId = sb.userId;
    studentBClient = sb.client;
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    // Enrolled in both classes. Rare but permitted, and it is the case where
    // "which section is this student in" stops having a single answer.
    const dual = await createTestUserClient(admin, `rls-qs-stu-dual-${uid}@test.local`);
    dualStudentId = dual.userId;
    userIds.push(dual.userId);
    await addUserToInstitution(admin, dual.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, dual.userId, 'student');
    await enrollInClass(admin, classBId, dual.userId, 'student');

    sessionAId = await createQuizSession(admin, quizId, studentAId, courseId, offeringAId);
    sessionBId = await createQuizSession(admin, quizId, studentBId, courseId, offeringBId);

    answerAId = await createQuizAnswer(
      admin, sessionAId, questionId, studentAId, courseId, offeringAId
    );
    answerBId = await createQuizAnswer(
      admin, sessionBId, questionId, studentBId, courseId, offeringBId
    );

    dualSessionBId = await createQuizSession(
      admin, quizId, dualStudentId, courseId, offeringBId
    );
    dualAnswerBId = await createQuizAnswer(
      admin, dualSessionBId, questionId, dualStudentId, courseId, offeringBId
    );

    // Left with offering_id NULL on purpose.
    practiceSessionBId = await createQuizSession(admin, quizId, studentBId, courseId);
    practiceAnswerBId = await createQuizAnswer(
      admin,
      practiceSessionBId,
      questionId,
      studentBId,
      courseId
    );
  });

  afterAll(async () => {
    // CLAUDE.md's "no cleanup" rule is scoped to E2E, where the target is a
    // shared preview branch and the point is to need no privileged credential.
    // The RLS harness is service-role by construction — `getAdminClient()`
    // seeds every fixture row precisely so it can be read back as a role that
    // does not bypass RLS — and runs against a local stack that `db reset`
    // recreates. `cleanupScaffold` is what all the other suites here use.
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---- quiz_sessions: reads ----------------------------------------------

  it('each restricted instructor reads only their own section\'s sessions', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('quiz_sessions')
      .select('id')
      .in('id', [sessionAId, sessionBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([sessionAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('quiz_sessions')
      .select('id')
      .in('id', [sessionAId, sessionBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([sessionBId]);
  });

  it('an unrestricted instructor on the same course reads both sections', async () => {
    const { data, error } = await unrestricted
      .from('quiz_sessions')
      .select('id')
      .in('id', [sessionAId, sessionBId]);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([sessionAId, sessionBId].sort());
  });

  it('the institution admin reads both sections', async () => {
    const { data, error } = await adminClient
      .from('quiz_sessions')
      .select('id')
      .in('id', [sessionAId, sessionBId]);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([sessionAId, sessionBId].sort());
  });

  // ---- quiz_sessions: the practice-mode row -------------------------------

  it('a practice session with no offering reaches no restricted instructor', async () => {
    // Not even section B's instructor, whose student this is. The row does not
    // say which section the work belongs to, and this rule declines to infer
    // one — that refusal is what leaves it with no delete-the-evidence path.
    // The cost is exactly this: a restricted instructor loses sight of their
    // own students' practice-mode work.
    const { data: seenByA, error: errA } = await instrA
      .from('quiz_sessions')
      .select('id')
      .eq('id', practiceSessionBId);
    expect(errA).toBeNull();
    expect(seenByA).toHaveLength(0);

    const { data: seenByB, error: errB } = await instrB
      .from('quiz_sessions')
      .select('id')
      .eq('id', practiceSessionBId);
    expect(errB).toBeNull();
    expect(seenByB).toHaveLength(0);
  });

  it('an unrestricted instructor still reads practice sessions', async () => {
    const { data, error } = await unrestricted
      .from('quiz_sessions')
      .select('id')
      .eq('id', practiceSessionBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // ---- quiz_sessions: the force-complete UPDATE ---------------------------

  it('a restricted instructor cannot force-complete another section\'s session', async () => {
    const { error } = await instrA
      .from('quiz_sessions')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', sessionBId);
    expect(error).toBeNull(); // narrowed to zero rows, not an error
    const { data } = await admin
      .from('quiz_sessions')
      .select('completed_at')
      .eq('id', sessionBId)
      .single();
    expect(data?.completed_at).toBeNull();
  });

  it('a restricted instructor can force-complete their own section\'s session', async () => {
    // The control: without it, the case above would also pass if the UPDATE
    // policy had been broken outright.
    const { error } = await instrA
      .from('quiz_sessions')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', sessionAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('quiz_sessions')
      .select('completed_at')
      .eq('id', sessionAId)
      .single();
    expect(data?.completed_at).not.toBeNull();
  });

  // ---- quiz_answers -------------------------------------------------------

  it('each restricted instructor reads only their own section\'s answers', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('quiz_answers')
      .select('id')
      .in('id', [answerAId, answerBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([answerAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('quiz_answers')
      .select('id')
      .in('id', [answerAId, answerBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([answerBId]);
  });

  it('a student still reads their own answers, and a classmate cannot', async () => {
    // `user_id = auth.uid()` is a separate disjunct and has to survive the
    // rewrite — students read their own results with no instructor
    // relationship in play.
    const { data: own, error: ownError } = await studentBClient
      .from('quiz_answers')
      .select('id')
      .eq('id', answerBId);
    expect(ownError).toBeNull();
    expect(own).toHaveLength(1);

    const { data: classmateSees } = await studentAClient
      .from('quiz_answers')
      .select('id')
      .eq('id', answerBId);
    expect(classmateSees).toHaveLength(0);
  });

  it('a restricted instructor cannot delete another section\'s answer', async () => {
    const { error } = await instrA.from('quiz_answers').delete().eq('id', answerBId);
    expect(error).toBeNull();
    const { data } = await admin.from('quiz_answers').select('id').eq('id', answerBId);
    expect(data).toHaveLength(1);
  });

  it('a restricted instructor can delete their own section\'s answer', async () => {
    const { error } = await instrA.from('quiz_answers').delete().eq('id', answerAId);
    expect(error).toBeNull();
    const { data } = await admin.from('quiz_answers').select('id').eq('id', answerAId);
    expect(data).toHaveLength(0);
  });

  // ---- the multi-enrolment case ------------------------------------------

  it('a student in both sections does not make their section-B work readable from A', async () => {
    // Deciding an offering-attributed row on the student's enrolments alone
    // would authorise this: the student *is* in section A, so an A-restricted
    // instructor would reach work that was done in B. The row names its
    // offering, so the offering decides and the enrolment fallback never runs.
    const { data: sessionSeenByA, error: sessionError } = await instrA
      .from('quiz_sessions')
      .select('id')
      .eq('id', dualSessionBId);
    expect(sessionError).toBeNull();
    expect(sessionSeenByA).toHaveLength(0);

    const { data: answerSeenByA } = await instrA
      .from('quiz_answers')
      .select('id')
      .eq('id', dualAnswerBId);
    expect(answerSeenByA).toHaveLength(0);

    // Section B's instructor, who does own that offering, still sees both.
    const { data: sessionSeenByB } = await instrB
      .from('quiz_sessions')
      .select('id')
      .eq('id', dualSessionBId);
    expect(sessionSeenByB).toHaveLength(1);

    const { data: answerSeenByB } = await instrB
      .from('quiz_answers')
      .select('id')
      .eq('id', dualAnswerBId);
    expect(answerSeenByB).toHaveLength(1);
  });

  it('a dual-enrolled student\'s section-B session cannot be force-completed from A', async () => {
    const { error } = await instrA
      .from('quiz_sessions')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', dualSessionBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('quiz_sessions')
      .select('completed_at')
      .eq('id', dualSessionBId)
      .single();
    expect(data?.completed_at).toBeNull();
  });

  it('deleting the offering does not hand a dual-enrolled student\'s work to the other section', async () => {
    // `quiz_sessions.offering_id` is ON DELETE SET NULL, so removing an
    // offering strips the row's section attribution and drops it into the
    // enrolment fallback. For a student enrolled in both sections there is then
    // no fact left saying which section the work was done in, and a fallback
    // that accepted *any* accessible enrolment would resolve that in favour of
    // access — handing 1Α's instructor a result that was 1Β's.
    const throwawayClassId = await createClass(admin, institutionId);
    const throwawayOfferingId = await createOffering(admin, throwawayClassId, courseId);
    await enrollInClass(admin, throwawayClassId, dualStudentId, 'student');

    const orphanedId = await createQuizSession(admin, quizId, dualStudentId, courseId, throwawayOfferingId);

    await admin.from('offerings').delete().eq('id', throwawayOfferingId);
    const { data: orphaned } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', orphanedId)
      .single();
    // Precondition: the FK really did null it out, or this proves nothing.
    expect(orphaned?.offering_id).toBeNull();

    const { data: seenByA } = await instrA
      .from('quiz_sessions')
      .select('id')
      .eq('id', orphanedId);
    expect(seenByA).toHaveLength(0);

    const { data: seenByB } = await instrB
      .from('quiz_sessions')
      .select('id')
      .eq('id', orphanedId);
    expect(seenByB).toHaveLength(0);

    // An instructor entitled to every section the student sits in still sees
    // it — the rule is "no section you cannot reach", not "no ambiguity".
    const { data: seenByUnrestricted } = await unrestricted
      .from('quiz_sessions')
      .select('id')
      .eq('id', orphanedId);
    expect(seenByUnrestricted).toHaveLength(1);
  });

  it('a student leaving the class does not take their quiz history with them', async () => {
    // Enrolment is a fact about now; the row is a fact about then. An
    // offering-attributed session stays readable after the student unenrols —
    // to the instructor of the section the work was done in, and to the
    // unrestricted one. Gating reads on current enrolment would erase a
    // course's history every time a class list is tidied up.
    const leaver = await createTestUserClient(admin, `rls-qs-stu-leaver-${uid}@test.local`);
    userIds.push(leaver.userId);
    await addUserToInstitution(admin, leaver.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, leaver.userId, 'student');

    const historicId = await createQuizSession(admin, quizId, leaver.userId, courseId, offeringAId);

    await admin
      .from('class_enrollments')
      .delete()
      .eq('class_id', classAId)
      .eq('user_id', leaver.userId);

    const { data: seenByA, error } = await instrA
      .from('quiz_sessions')
      .select('id')
      .eq('id', historicId);
    expect(error).toBeNull();
    expect(seenByA).toHaveLength(1);

    const { data: seenByUnrestricted } = await unrestricted
      .from('quiz_sessions')
      .select('id')
      .eq('id', historicId);
    expect(seenByUnrestricted).toHaveLength(1);

    // Section B's instructor still cannot: the row names section A's offering.
    const { data: seenByB } = await instrB
      .from('quiz_sessions')
      .select('id')
      .eq('id', historicId);
    expect(seenByB).toHaveLength(0);
  });

  it('an instructor can force-complete a session belonging to a student who left', async () => {
    // The rows most likely to be left open are the ones belonging to students
    // who have gone. Gating the lifecycle edit on current enrolment would make
    // exactly those uncloseable.
    const leaver = await createTestUserClient(admin, `rls-qs-stu-close-${uid}@test.local`);
    userIds.push(leaver.userId);
    await addUserToInstitution(admin, leaver.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, leaver.userId, 'student');

    const strandedId = await createQuizSession(admin, quizId, leaver.userId, courseId, offeringAId);
    await admin
      .from('class_enrollments')
      .delete()
      .eq('class_id', classAId)
      .eq('user_id', leaver.userId);

    const { error } = await instrA
      .from('quiz_sessions')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', strandedId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('quiz_sessions')
      .select('completed_at')
      .eq('id', strandedId)
      .single();
    expect(data?.completed_at).not.toBeNull();
  });

  it('an instructor cannot re-file a session under a different student', async () => {
    // A WITH CHECK sees only the finished row, so it cannot tell "still about
    // the same student" from "about a different one". The instructor may edit
    // this session legitimately, and the resulting row would still name their
    // own offering and course — the check would pass on the way out. The
    // trigger is what refuses it.
    const { error } = await instrA
      .from('quiz_sessions')
      .update({ user_id: studentBId })
      .eq('id', sessionAId);
    expect(error).not.toBeNull();

    const { data } = await admin
      .from('quiz_sessions')
      .select('user_id')
      .eq('id', sessionAId)
      .single();
    expect(data?.user_id).toBe(studentAId);
  });

  it('a student cannot re-file someone else\'s work under their own name', async () => {
    // The same invariant from the other side: not an authorisation question,
    // so it does not depend on who is asking.
    await studentBClient
      .from('quiz_sessions')
      .update({ user_id: studentBId })
      .eq('id', sessionAId);
    // RLS narrows this to zero rows before the trigger is even reached, so the
    // call may or may not report an error. The row being untouched is the
    // assertion that matters, and it holds either way.
    const { data } = await admin
      .from('quiz_sessions')
      .select('user_id')
      .eq('id', sessionAId)
      .single();
    expect(data?.user_id).toBe(studentAId);
  });

  // ---- the student cannot choose who sees their work ---------------------

  it('a student cannot re-file their own session under another section', async () => {
    // Everything above decides on `offering_id`, so the subject must not be
    // able to choose it freely. Before this, "Users can update their own quiz
    // sessions" had no WITH CHECK at all — PostgreSQL reused `user_id =
    // auth.uid()`, which says who the row belongs to and nothing about which
    // offering it may name. Student B could point their session at section A's
    // offering and hand A's instructor access to it.
    const { error } = await studentBClient
      .from('quiz_sessions')
      .update({ offering_id: offeringAId })
      .eq('id', sessionBId);
    expect(error).not.toBeNull();

    const { data } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', sessionBId)
      .single();
    expect(data?.offering_id).toBe(offeringBId);
  });

  it('a dual-enrolled student cannot move finished work between their sections', async () => {
    // Both offerings are genuinely theirs, so the destination check passes
    // either way — "may I file work here" is the wrong question once the row
    // exists. What must not happen is a transfer of visibility: work done in
    // section B becoming work section A's instructor can read, at the
    // subject's discretion. A WITH CHECK cannot see that the offering changed,
    // so the trigger enforces it.
    const dualClient = (await createTestUserClient(admin, `rls-qs-dual2-${uid}@test.local`));
    userIds.push(dualClient.userId);
    await addUserToInstitution(admin, dualClient.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, dualClient.userId, 'student');
    await enrollInClass(admin, classBId, dualClient.userId, 'student');

    const movableId = await createQuizSession(admin, quizId, dualClient.userId, courseId, offeringBId);

    const { error } = await dualClient.client
      .from('quiz_sessions')
      .update({ offering_id: offeringAId })
      .eq('id', movableId);
    expect(error).not.toBeNull();

    const { data } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', movableId)
      .single();
    expect(data?.offering_id).toBe(offeringBId);

    // And section A's instructor still cannot see it.
    const { data: seenByA } = await instrA
      .from('quiz_sessions')
      .select('id')
      .eq('id', movableId);
    expect(seenByA).toHaveLength(0);
  });

  it('attribution cannot be re-set after an offering delete clears it', async () => {
    // The two-step version of the transfer. Making attribution immutable
    // "once set" left a gap where the two exceptions meet: the FK cascade
    // clears the column when an offering is deleted, and NULL was an allowed
    // starting point, so a dual-enrolled student could then file the row under
    // their other section and move visibility after all.
    const mover = await createTestUserClient(admin, `rls-qs-mover-${uid}@test.local`);
    userIds.push(mover.userId);
    await addUserToInstitution(admin, mover.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, mover.userId, 'student');

    const doomedClassId = await createClass(admin, institutionId);
    const doomedOfferingId = await createOffering(admin, doomedClassId, courseId);
    await enrollInClass(admin, doomedClassId, mover.userId, 'student');

    const rowId = await createQuizSession(admin, quizId, mover.userId, courseId, doomedOfferingId);

    // The cascade clears attribution — and must still be allowed, or offerings
    // could not be deleted at all.
    const { error: deleteError } = await admin
      .from('offerings')
      .delete()
      .eq('id', doomedOfferingId);
    expect(deleteError).toBeNull();
    const { data: cleared } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', rowId)
      .single();
    expect(cleared?.offering_id).toBeNull();

    // What must not follow is re-filing it under the student's other section.
    const { error } = await mover.client
      .from('quiz_sessions')
      .update({ offering_id: offeringAId })
      .eq('id', rowId);
    expect(error).not.toBeNull();

    const { data: after } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', rowId)
      .single();
    expect(after?.offering_id).toBeNull();

    // And section A's instructor still cannot see it: an unattributed row
    // reaches no section-restricted instructor.
    const { data: seenByA } = await instrA.from('quiz_sessions').select('id').eq('id', rowId);
    expect(seenByA).toHaveLength(0);
  });

  it('a student can still write their own session, attribution aside', async () => {
    // The control for the refusals above: they are about `offering_id`
    // specifically, not the row being read-only to its owner. Writing the same
    // offering back is a no-op the trigger permits, and an ordinary field the
    // student owns still updates.
    const { error } = await studentBClient
      .from('quiz_sessions')
      .update({ offering_id: offeringBId, status: 'in_progress' })
      .eq('id', sessionBId);
    expect(error).toBeNull();
  });

  it('a student cannot submit an answer against another section\'s offering', async () => {
    const { error } = await studentBClient.from('quiz_answers').insert({
      session_id: sessionBId,
      question_id: questionId,
      user_id: studentBId,
      course_id: courseId,
      offering_id: offeringAId,
      selected_answer: 0,
      submission: { selected_indices: [0] },
      is_correct: false,
    });
    expect(error).not.toBeNull();
  });

  it('deleting the other section\'s offering does not shrink the student\'s section set', async () => {
    // The sharper version of the case above. Here the student sits in exactly
    // two sections, A and B, and only B's *offering* is deleted — the class and
    // the enrolment both survive. If the "every section" test derived the
    // student's sections from current offerings, B would vanish from the
    // comparison, the student would look like a 1Α-only student, and A's
    // restricted instructor would inherit their unattributed B work. Reading
    // the classes from `class_enrollments` instead is what stops it.
    const twoSectionStudent = await createTestUserClient(
      admin,
      `rls-qs-stu-two-${uid}@test.local`
    );
    userIds.push(twoSectionStudent.userId);
    await addUserToInstitution(admin, twoSectionStudent.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, twoSectionStudent.userId, 'student');

    const doomedClassId = await createClass(admin, institutionId);
    const doomedOfferingId = await createOffering(admin, doomedClassId, courseId);
    await enrollInClass(admin, doomedClassId, twoSectionStudent.userId, 'student');
    await addSectionRestriction(admin, courseId, doomedClassId, instrBId);

    const strandedId = await createQuizSession(admin, quizId, twoSectionStudent.userId, courseId, doomedOfferingId);

    // Only the offering goes; the class and the enrolment stay.
    await admin.from('offerings').delete().eq('id', doomedOfferingId);
    const { data: stranded } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', strandedId)
      .single();
    expect(stranded?.offering_id).toBeNull();
    const { data: enrolmentsIntact } = await admin
      .from('class_enrollments')
      .select('user_id')
      .eq('class_id', doomedClassId)
      .eq('user_id', twoSectionStudent.userId);
    expect(enrolmentsIntact).toHaveLength(1);

    const { data: seenByA } = await instrA
      .from('quiz_sessions')
      .select('id')
      .eq('id', strandedId);
    expect(seenByA).toHaveLength(0);
  });

  // ---- the helpers this migration adds for the rest of the epic ----------
  //
  // `instructor_can_access_student` is introduced here as the base of the
  // stack: the sibling migrations in #1097 govern per-(course, student) tables
  // with no section dimension of their own — `evaluation_timeline_cache`,
  // `graded_tests`, `open_question_chats` — which ask "does this instructor
  // teach this student", not "which section is this row in". No policy in
  // *this* migration uses it, so it is exercised directly.

  it('instructor_can_access_student is not blinded by an unrelated enrolment', async () => {
    // The other way the "no section you cannot reach" test can go wrong. If it
    // considered every class in the institution, a student who also sits in a
    // class that has nothing to do with this course — a club, a second
    // homeroom — would go invisible to their own section's instructor, denying
    // access that is plainly legitimate.
    const clubClassId = await createClass(admin, institutionId);
    await enrollInClass(admin, clubClassId, studentAId, 'student');

    const { data } = await admin.rpc('instructor_can_access_student', {
      _course_id: courseId,
      _student_id: studentAId,
      _user_id: instrAId,
    });
    expect(data).toBe(true);
  });

  it('instructor_can_access_student denies a student in a section it cannot reach', async () => {
    const { data } = await admin.rpc('instructor_can_access_student', {
      _course_id: courseId,
      _student_id: studentBId,
      _user_id: instrAId,
    });
    expect(data).toBe(false);

    const { data: forOwnStudent } = await admin.rpc('instructor_can_access_student', {
      _course_id: courseId,
      _student_id: studentAId,
      _user_id: instrAId,
    });
    expect(forOwnStudent).toBe(true);
  });

  it('instructor_can_access_student admits a student they share a section with', async () => {
    // The dual-enrolled student sits in section A as well, so A's instructor
    // does teach them. This is a question about the teaching relationship, not
    // about attributing a row to a section — the per-(course, student) tables
    // that use this helper have no section dimension to attribute to.
    const { data } = await admin.rpc('instructor_can_access_student', {
      _course_id: courseId,
      _student_id: dualStudentId,
      _user_id: instrAId,
    });
    expect(data).toBe(true);
  });

  it('a class carrying answers cannot be deleted, so attribution cannot be erased under it', async () => {
    // Deleting a class cascades to its offerings, and an offering delete nulls
    // `quiz_sessions.offering_id` — which would erase the only record of which
    // section the work was done in. `quiz_answers.offering_id` is ON DELETE
    // RESTRICT (unlike the session's), so wherever the per-question data
    // exists the whole delete is refused and nothing is erased. That is the
    // guard, and it belongs in a test rather than in a comment.
    const guardedClassId = await createClass(admin, institutionId);
    const guardedOfferingId = await createOffering(admin, guardedClassId, courseId);
    await enrollInClass(admin, guardedClassId, dualStudentId, 'student');

    const guardedSessionId = await createQuizSession(admin, quizId, dualStudentId, courseId, guardedOfferingId);
    await createQuizAnswer(
      admin, guardedSessionId, questionId, dualStudentId, courseId, guardedOfferingId
    );

    // Service role, so RLS is not what refuses this — the FK is.
    const { error } = await admin.from('classes').delete().eq('id', guardedClassId);
    expect(error).not.toBeNull();

    const { data: stillThere } = await admin
      .from('quiz_sessions')
      .select('offering_id')
      .eq('id', guardedSessionId)
      .single();
    expect(stillThere?.offering_id).toBe(guardedOfferingId);
  });

  it('a practice-mode answer follows the same rule', async () => {
    const { data: seenByA } = await instrA
      .from('quiz_answers')
      .select('id')
      .eq('id', practiceAnswerBId);
    expect(seenByA).toHaveLength(0);

    const { data: seenByB } = await instrB
      .from('quiz_answers')
      .select('id')
      .eq('id', practiceAnswerBId);
    expect(seenByB).toHaveLength(0);

    // The unrestricted instructor is the control: the row exists and is
    // readable by someone, so the two denials above are the restriction and
    // not a policy that shut the table.
    const { data: seenByUnrestricted } = await unrestricted
      .from('quiz_answers')
      .select('id')
      .eq('id', practiceAnswerBId);
    expect(seenByUnrestricted).toHaveLength(1);
  });
});
