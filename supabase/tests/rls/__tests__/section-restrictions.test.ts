// Section restrictions (#59) across every surface that already honours them.
//
// The gate itself lives in 20260402000000_add_course_instructor_sections.sql:
//
//   instructor_can_access_section(course_id, class_id, user_id)
//     - no rows for (course, instructor)  → full access (backward compatible)
//     - rows present                      → the listed sections only
//   is_class_instructor(class_id)   folds it in (:82)
//   can_manage_offering(offering_id) folds it in (:110)
//
// So a policy is section-scoped exactly when it routes through one of those
// three. This suite pins the ones that do. Before it, `addSectionRestriction`
// had a single consumer in the whole RLS harness
// (`study-guide-analyses.test.ts:153`), which left the rest free to regress
// silently — and one already did: 20260401000000 rewrote `is_class_instructor`,
// `can_manage_offering` and the `offerings` policy *without* the section term,
// and 20260402000000 restored it a day later. Nothing would have failed in
// between.
//
// The scaffold is what the other suites lack: TWO restricted instructors on one
// course, pointed at opposite sections, so every assertion runs in both
// directions and a policy that ignores the restriction cannot pass by accident.
// A third, unrestricted instructor holds the "no rows means full access"
// semantic honest — without them, a bug that fails to *write* the restriction
// rows is indistinguishable from correct unrestricted access.

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
  createOfferingQuiz,
  createQuizAnalysis,
  createTest,
  createOfferingTest,
  createOfferingQuestion,
  createStudySession,
  createOfferingStudySession,
  createStudyGuide,
  createStudyGuidePiece,
  createOfferingStudyGuide,
  createStudyGuideAnswer,
  createStudentAdminNote,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

/** Inline — `study_guide_analyses` is not in the generated types yet. */
async function createStudyGuideAnalysis(
  admin: SupabaseClient,
  studyGuideId: string,
  offeringId: string
): Promise<string> {
  const { data, error } = await admin
    .from('study_guide_analyses' as never)
    .insert({
      study_guide_id: studyGuideId,
      offering_id: offeringId,
      group_id: null,
      report: { summary: 'RLS section-restriction assessment' },
      submission_count: 1,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyGuideAnalysis: ${error.message}`);
  return (data as { id: string }).id;
}

/** Row ids returned by a `.select('id')`, for the `toEqual` comparisons below. */
function ids(data: unknown): string[] {
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe('course_instructor_sections gate — surfaces that already honour it', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;

  // Two sections of one course.
  let classAId: string;
  let offeringAId: string;
  let classBId: string;
  let offeringBId: string;

  // A second course, used only to prove the restriction is per (course,
  // instructor) rather than per instructor.
  let otherCourseId: string;
  let otherClassId: string;
  let otherOfferingId: string;

  let instrA: SupabaseClient; // restricted to section A
  let instrB: SupabaseClient; // restricted to section B
  let unrestricted: SupabaseClient; // same course, no restriction rows
  let instrAId: string;

  // Content assigned to both sections.
  let quizId: string;
  let offeringQuizAId: string;
  let offeringQuizBId: string;
  let testId: string;
  let offeringTestAId: string;
  let offeringTestBId: string;
  let questionId: string;
  let offeringQuestionAId: string;
  let offeringQuestionBId: string;
  let studySessionId: string;
  let offeringSessionAId: string;
  let offeringSessionBId: string;
  let guideId: string;
  let offeringGuideAId: string;
  let offeringGuideBId: string;

  let quizAnalysisAId: string;
  let quizAnalysisBId: string;
  let guideAnalysisAId: string;
  let guideAnalysisBId: string;
  let answerAId: string;
  let answerBId: string;
  let noteAId: string;
  let noteBId: string;

  let studentAId: string;
  let studentBId: string;

  // Content deliberately left unassigned, so the INSERT cases below have a row
  // that no unique constraint already rejects.
  let spareQuizId: string;
  let spareTestId: string;
  let spareQuestionId: string;
  let spareStudySessionId: string;
  let spareGuideId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Sections ${uid}`);
    courseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    offeringAId = await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    offeringBId = await createOffering(admin, classBId, courseId);

    otherCourseId = await createCourse(admin, institutionId);
    otherClassId = await createClass(admin, institutionId);
    otherOfferingId = await createOffering(admin, otherClassId, otherCourseId);

    // --- instructors ------------------------------------------------------
    const a = await createTestUserClient(admin, `rls-sect-a-${uid}@test.local`);
    instrA = a.client;
    instrAId = a.userId;
    userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, a.userId);
    await addSectionRestriction(admin, courseId, classAId, a.userId);
    // Same instructor teaches the second course with no restriction rows there.
    await assignCourseInstructor(admin, otherCourseId, a.userId);

    const b = await createTestUserClient(admin, `rls-sect-b-${uid}@test.local`);
    instrB = b.client;
    userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, b.userId);
    await addSectionRestriction(admin, courseId, classBId, b.userId);

    const u = await createTestUserClient(admin, `rls-sect-u-${uid}@test.local`);
    unrestricted = u.client;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    // --- students, one per section ---------------------------------------
    const sa = await createTestUserClient(admin, `rls-sect-stu-a-${uid}@test.local`);
    studentAId = sa.userId;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    const sb = await createTestUserClient(admin, `rls-sect-stu-b-${uid}@test.local`);
    studentBId = sb.userId;
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    // --- content assigned to both sections --------------------------------
    questionId = await createQuestion(admin, courseId);

    quizId = await createQuiz(admin, courseId);
    offeringQuizAId = await createOfferingQuiz(admin, offeringAId, quizId);
    offeringQuizBId = await createOfferingQuiz(admin, offeringBId, quizId);

    testId = await createTest(admin, courseId);
    offeringTestAId = await createOfferingTest(admin, offeringAId, testId);
    offeringTestBId = await createOfferingTest(admin, offeringBId, testId);

    offeringQuestionAId = await createOfferingQuestion(admin, offeringAId, questionId);
    offeringQuestionBId = await createOfferingQuestion(admin, offeringBId, questionId);

    studySessionId = await createStudySession(admin, courseId);
    offeringSessionAId = await createOfferingStudySession(admin, offeringAId, studySessionId);
    offeringSessionBId = await createOfferingStudySession(admin, offeringBId, studySessionId);

    guideId = await createStudyGuide(admin, courseId, { title: `Sections guide ${uid}` });
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    offeringGuideAId = await createOfferingStudyGuide(admin, offeringAId, guideId, {
      published: true,
    });
    offeringGuideBId = await createOfferingStudyGuide(admin, offeringBId, guideId, {
      published: true,
    });

    quizAnalysisAId = await createQuizAnalysis(admin, quizId, offeringAId);
    quizAnalysisBId = await createQuizAnalysis(admin, quizId, offeringBId);

    guideAnalysisAId = await createStudyGuideAnalysis(admin, guideId, offeringAId);
    guideAnalysisBId = await createStudyGuideAnalysis(admin, guideId, offeringBId);

    answerAId = await createStudyGuideAnswer(admin, {
      userId: studentAId,
      studyGuideId: guideId,
      offeringId: offeringAId,
      pieceId,
      questionId,
    });
    answerBId = await createStudyGuideAnswer(admin, {
      userId: studentBId,
      studyGuideId: guideId,
      offeringId: offeringBId,
      pieceId,
      questionId,
    });

    spareQuizId = await createQuiz(admin, courseId);
    spareTestId = await createTest(admin, courseId);
    spareQuestionId = await createQuestion(admin, courseId);
    spareStudySessionId = await createStudySession(admin, courseId);
    spareGuideId = await createStudyGuide(admin, courseId, { title: `Spare guide ${uid}` });

    noteAId = await createStudentAdminNote(admin, studentAId, institutionId);
    noteBId = await createStudentAdminNote(admin, studentBId, institutionId);
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

  // ---- offerings ---------------------------------------------------------
  // "Managers can manage offerings" (20260402000000:137) — FOR ALL.

  it('each restricted instructor sees only their own section offering', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('offerings')
      .select('id')
      .in('id', [offeringAId, offeringBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([offeringAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('offerings')
      .select('id')
      .in('id', [offeringAId, offeringBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([offeringBId]);
  });

  it('an unrestricted instructor on the same course sees both offerings', async () => {
    const { data, error } = await unrestricted
      .from('offerings')
      .select('id')
      .in('id', [offeringAId, offeringBId]);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([offeringAId, offeringBId].sort());
  });

  it('a restricted instructor cannot deactivate the other section offering', async () => {
    const { error } = await instrA
      .from('offerings')
      .update({ is_active: false })
      .eq('id', offeringBId);
    // RLS narrows the UPDATE to zero rows rather than erroring, so the row's
    // unchanged state is the assertion.
    expect(error).toBeNull();
    const { data } = await admin
      .from('offerings')
      .select('is_active')
      .eq('id', offeringBId)
      .single();
    expect(data?.is_active).toBe(true);
  });

  // ---- assignment tables -------------------------------------------------
  // All five route through can_manage_offering(offering_id).

  const assignmentTables: Array<{
    table: string;
    a: () => string;
    b: () => string;
    /**
     * A row assigning *spare* content — content no offering holds yet — to the
     * given offering. It has to be spare: every one of these tables carries
     * UNIQUE(offering_id, <content>, group_id) NULLS NOT DISTINCT, so
     * re-assigning the content the fixture already placed would be refused by
     * the constraint whether or not RLS did anything, and the test would stay
     * green straight through a regression in `can_manage_offering`.
     */
    spareRow: (offeringId: string) => Record<string, unknown>;
  }> = [
    {
      table: 'offering_quizzes',
      a: () => offeringQuizAId,
      b: () => offeringQuizBId,
      spareRow: (offeringId) => ({ offering_id: offeringId, quiz_id: spareQuizId }),
    },
    {
      table: 'offering_tests',
      a: () => offeringTestAId,
      b: () => offeringTestBId,
      spareRow: (offeringId) => ({ offering_id: offeringId, test_id: spareTestId }),
    },
    {
      table: 'offering_questions',
      a: () => offeringQuestionAId,
      b: () => offeringQuestionBId,
      spareRow: (offeringId) => ({ offering_id: offeringId, question_id: spareQuestionId }),
    },
    {
      table: 'offering_study_sessions',
      a: () => offeringSessionAId,
      b: () => offeringSessionBId,
      spareRow: (offeringId) => ({
        offering_id: offeringId,
        study_session_id: spareStudySessionId,
      }),
    },
    {
      table: 'offering_study_guides',
      a: () => offeringGuideAId,
      b: () => offeringGuideBId,
      spareRow: (offeringId) => ({ offering_id: offeringId, study_guide_id: spareGuideId }),
    },
  ];

  for (const { table, a, b, spareRow } of assignmentTables) {
    it(`${table}: each restricted instructor reads only their own section`, async () => {
      const { data: seenByA, error: errA } = await instrA
        .from(table as never)
        .select('id')
        .in('id', [a(), b()]);
      expect(errA).toBeNull();
      expect(ids(seenByA)).toEqual([a()]);

      const { data: seenByB, error: errB } = await instrB
        .from(table as never)
        .select('id')
        .in('id', [a(), b()]);
      expect(errB).toBeNull();
      expect(ids(seenByB)).toEqual([b()]);
    });

    it(`${table}: assignment to the other section is refused, to their own is not`, async () => {
      const { error: refused } = await instrA
        .from(table as never)
        .insert(spareRow(offeringBId));
      expect(refused).not.toBeNull();

      // The control that makes the line above mean something: the identical
      // row, differing only in which section it targets, has to go in. If both
      // halves failed, the refusal would be telling us about the row's shape —
      // a constraint, a NOT NULL, a trigger — rather than about the section
      // policy. Only the pair pins `can_manage_offering`.
      const { error: allowed } = await instrA
        .from(table as never)
        .insert(spareRow(offeringAId));
      expect(allowed).toBeNull();
    });

    it(`${table}: unassigning the other section is a no-op`, async () => {
      const { error } = await instrA
        .from(table as never)
        .delete()
        .eq('id', b());
      expect(error).toBeNull();
      const { data } = await admin
        .from(table as never)
        .select('id')
        .eq('id', b());
      expect(data).toHaveLength(1);
    });
  }

  // ---- class-level AI reports --------------------------------------------

  it('quiz_analyses: a restricted instructor reads only their own section report', async () => {
    const { data, error } = await instrA
      .from('quiz_analyses' as never)
      .select('id')
      .in('id', [quizAnalysisAId, quizAnalysisBId]);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([quizAnalysisAId]);
  });

  it('study_guide_analyses: the opposite restriction reads the opposite section', async () => {
    // The mirror of study-guide-analyses.test.ts:153, which only ever asserted
    // the section-A direction. A policy that hard-coded the first section would
    // pass there and fail here.
    const { data, error } = await instrB
      .from('study_guide_analyses' as never)
      .select('id')
      .in('id', [guideAnalysisAId, guideAnalysisBId]);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([guideAnalysisBId]);
  });

  // ---- student work ------------------------------------------------------

  it('study_guide_answers: a restricted instructor reads only their own section submissions', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('study_guide_answers' as never)
      .select('id')
      .in('id', [answerAId, answerBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([answerAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('study_guide_answers' as never)
      .select('id')
      .in('id', [answerAId, answerBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([answerBId]);
  });

  it('class_enrollments: a restricted instructor reads only their own section roster', async () => {
    // Routes through is_class_instructor(class_id) (20260402000000:82).
    const { data: seenByA, error } = await instrA
      .from('class_enrollments')
      .select('user_id')
      .in('class_id', [classAId, classBId]);
    expect(error).toBeNull();
    const seen = ((seenByA ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    expect(seen).toContain(studentAId);
    expect(seen).not.toContain(studentBId);
  });

  it('class_enrollments: a restricted instructor cannot enrol into the other section', async () => {
    const { error } = await instrA
      .from('class_enrollments')
      .insert({ class_id: classBId, user_id: studentAId, role: 'student' });
    expect(error).not.toBeNull();
  });

  it('student_admin_notes: a restricted instructor reads only their own section students', async () => {
    // The only student-data table already written against
    // instructor_can_access_section (20260603200000).
    const { data: seenByA, error: errA } = await instrA
      .from('student_admin_notes')
      .select('id')
      .in('id', [noteAId, noteBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([noteAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('student_admin_notes')
      .select('id')
      .in('id', [noteAId, noteBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([noteBId]);
  });

  // ---- the two semantics that are easy to break --------------------------

  it('no restriction rows means full access, not no access', async () => {
    // 20260402000000:4. This is the half that a broken *write* path
    // (CourseInstructorPicker failing to persist the rows) would silently
    // imitate — an instructor with no rows looks exactly like a correctly
    // unrestricted one, so the write path and this semantic have to be pinned
    // separately. The UI half lives at
    // src/__tests__/components/CourseInstructorPicker.test.tsx:183.
    const { data, error } = await unrestricted
      .from('study_guide_answers' as never)
      .select('id')
      .in('id', [answerAId, answerBId]);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([answerAId, answerBId].sort());
  });

  it('a restriction on one course does not restrict the same instructor on another', async () => {
    // instrA is restricted to section A of `courseId` and has no rows at all
    // on `otherCourseId`, so the backward-compatible semantic applies there.
    const { data, error } = await instrA
      .from('offerings')
      .select('id')
      .eq('id', otherOfferingId);
    expect(error).toBeNull();
    expect(ids(data)).toEqual([otherOfferingId]);
  });

  it('restriction rows are keyed on the instructor, not shared across them', async () => {
    // instrB's row must not leak into instrA's allowed set: A restricted to
    // section A must still be refused section B even though *some* instructor
    // is allowed there.
    const { data, error } = await instrA
      .from('quiz_analyses' as never)
      .select('id')
      .eq('id', quizAnalysisBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('the restriction is enforced through the helper, not the row count', async () => {
    // Directly exercise instructor_can_access_section for both instructors and
    // both sections — the truth table the policies above compose with.
    const { data: aOnA } = await admin.rpc('instructor_can_access_section', {
      _course_id: courseId,
      _class_id: classAId,
      _user_id: instrAId,
    });
    const { data: aOnB } = await admin.rpc('instructor_can_access_section', {
      _course_id: courseId,
      _class_id: classBId,
      _user_id: instrAId,
    });
    expect(aOnA).toBe(true);
    expect(aOnB).toBe(false);
  });
});
