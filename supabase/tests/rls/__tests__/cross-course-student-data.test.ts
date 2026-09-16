// The course boundary on student data (#1101, part of #1097).
//
// Eleven policies across six tables authorised on institution membership plus
// a role string — `ui.role IN ('admin', 'instructor')` — with no
// `course_instructors` lookup anywhere. Any instructor in the institution
// therefore satisfied them for *every* course in it, including courses they
// have never been assigned to.
//
// The reader this suite builds is the one no existing suite has: an instructor
// of a **different course in the same institution**. Every other suite gives
// its fixture a single course, so a cross-course reader is never constructed
// and the hole is invisible — which is how it survived
// 20260401000000_migrate_instructor_rbac_to_course_instructors, the migration
// that replaced exactly this shape everywhere else.
//
// One correction to the issue as filed, established by running it rather than
// reading it: the exposure does NOT reach every institution instructor. The
// predicate's own `EXISTS (SELECT 1 FROM courses c ...)` is itself subject to
// RLS on `courses`, whose SELECT policy already demands
// `is_institution_admin OR is_course_instructor OR user_has_class_course_access`.
// An institution instructor with no relationship at all to the course cannot
// see the `courses` row, so the EXISTS is false and they are denied — by
// accident, through a second table's policy rather than this one's.
//
// The boundary is therefore load-bearing where nobody put it: two tables away,
// in a policy written for a different purpose. It opens the moment the course
// becomes visible by any route, and `user_has_class_course_access` is such a
// route — enrolment in ANY class carrying an active offering of the course
// grants it, with no role or section condition of its own.
//
// `visibleOutsiderClient` below is that reader: an institution instructor who
// teaches one course and is enrolled in a class that another course is offered
// to. (Enrolled as a student, because `chk_student_enrollments_only` from
// 20260403000000 forbids instructor rows in `class_enrollments` — a user who
// is an instructor of one course and a learner elsewhere.) Once the course row
// is visible, these policies hand them every student's transcripts, tutoring
// progress and grades for it — including students in classes they have no
// connection to — while `course_instructors` never names them.
//
// That reader is what fails before this migration and passes after.
// `outsiderClient` — no relationship whatsoever — is kept alongside it to pin
// the accidental boundary as well, so a future widening of the `courses`
// policy cannot quietly re-open this.
//
// The roles under test, per table:
//   teachingClient         — assigned to the course. Must keep working.
//   visibleOutsiderClient  — institution instructor who can see the course but
//                            does not teach it. Must see and write nothing.
//   outsiderClient         — institution instructor, unrelated course only.
//   adminClient            — institution admin. Came in through the same
//                            `ui.role` term the fix removes, so its access has
//                            to survive.

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
  createCourseMaterial,
  createOpenTypeQuestion,
  createOpenQuestionGrade,
  createOpenQuestionProgress,
  createOpenQuestionChat,
  createStudySession,
  createStudyProgress,
  createStudySessionMessage,
  createTextbookChatMessage,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('student data is scoped to the course, not the institution', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;

  // The course whose student data is under test. It is offered to two classes;
  // the student under test is in `studentClassId`.
  let courseId: string;
  let neighbourClassId: string;
  let studentClassId: string;

  // A second, unrelated course in the same institution. The outsiders teach
  // this one and nothing else.
  let otherCourseId: string;

  let teachingClient: SupabaseClient;
  let visibleOutsiderClient: SupabaseClient;
  let outsiderClient: SupabaseClient;
  let adminClient: SupabaseClient;
  let studentClient: SupabaseClient;
  let classmateClient: SupabaseClient;
  let studentId: string;

  // Rows belonging to the student, all on `courseId`.
  let gradeId: string;
  let progressId: string;
  let chatId: string;
  let studyProgressId: string;
  let studyMessageId: string;
  let textbookMessageId: string;
  let openQuestionId: string;
  let ungradedQuestionId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS XCourse ${uid}`);
    courseId = await createCourse(admin, institutionId);
    otherCourseId = await createCourse(admin, institutionId);

    // Two sections of the course under test. The student is in one; the
    // visible outsider is enrolled in the other.
    studentClassId = await createClass(admin, institutionId);
    await createOffering(admin, studentClassId, courseId);
    neighbourClassId = await createClass(admin, institutionId);
    await createOffering(admin, neighbourClassId, courseId);

    const teaching = await createTestUserClient(admin, `rls-xc-teach-${uid}@test.local`);
    teachingClient = teaching.client;
    userIds.push(teaching.userId);
    await addUserToInstitution(admin, teaching.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, teaching.userId);

    const visibleOutsider = await createTestUserClient(admin, `rls-xc-vis-${uid}@test.local`);
    visibleOutsiderClient = visibleOutsider.client;
    userIds.push(visibleOutsider.userId);
    await addUserToInstitution(admin, visibleOutsider.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, visibleOutsider.userId);
    // Enrolled in a class that the course under test is offered to, which
    // makes the `courses` row visible to them via
    // `user_has_class_course_access` — the whole precondition the
    // institution-wide policies needed. Role 'student' because
    // `chk_student_enrollments_only` forbids instructor rows here.
    await enrollInClass(admin, neighbourClassId, visibleOutsider.userId, 'student');

    const outsider = await createTestUserClient(admin, `rls-xc-out-${uid}@test.local`);
    outsiderClient = outsider.client;
    userIds.push(outsider.userId);
    await addUserToInstitution(admin, outsider.userId, institutionId, 'instructor');
    // Assigned to a real course — just not this one, and enrolled in no class.
    await assignCourseInstructor(admin, otherCourseId, outsider.userId);

    const instAdmin = await createTestUserClient(admin, `rls-xc-admin-${uid}@test.local`);
    adminClient = instAdmin.client;
    userIds.push(instAdmin.userId);
    await addUserToInstitution(admin, instAdmin.userId, institutionId, 'admin');

    const student = await createTestUserClient(admin, `rls-xc-stu-${uid}@test.local`);
    studentClient = student.client;
    studentId = student.userId;
    userIds.push(student.userId);
    await addUserToInstitution(admin, student.userId, institutionId, 'student');
    await enrollInClass(admin, studentClassId, student.userId, 'student');

    // Same class, so the only thing separating them is row ownership.
    const classmate = await createTestUserClient(admin, `rls-xc-stu2-${uid}@test.local`);
    classmateClient = classmate.client;
    userIds.push(classmate.userId);
    await addUserToInstitution(admin, classmate.userId, institutionId, 'student');
    await enrollInClass(admin, studentClassId, classmate.userId, 'student');

    openQuestionId = await createOpenTypeQuestion(admin, courseId);
    ungradedQuestionId = await createOpenTypeQuestion(admin, courseId);

    gradeId = await createOpenQuestionGrade(admin, {
      openQuestionId,
      userId: studentId,
      courseId,
    });
    progressId = await createOpenQuestionProgress(admin, {
      userId: studentId,
      openQuestionId,
      courseId,
    });
    chatId = await createOpenQuestionChat(admin, {
      openQuestionId,
      userId: studentId,
      courseId,
      content: 'I still do not understand why the derivative is zero here',
    });

    const studySessionId = await createStudySession(admin, courseId);
    studyProgressId = await createStudyProgress(admin, studySessionId, studentId, courseId);
    studyMessageId = await createStudySessionMessage(admin, studyProgressId);

    const materialId = await createCourseMaterial(admin, courseId);
    textbookMessageId = await createTextbookChatMessage(admin, {
      userId: studentId,
      courseId,
      materialId,
    });
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

  // ---- reads --------------------------------------------------------------

  const readCases: Array<{ table: string; row: () => string; what: string }> = [
    { table: 'open_question_grades', row: () => gradeId, what: 'per-question grades and feedback' },
    { table: 'open_question_progress', row: () => progressId, what: 'tutoring progress' },
    { table: 'open_question_chats', row: () => chatId, what: 'the tutoring transcript' },
    { table: 'student_study_progress', row: () => studyProgressId, what: 'study progress' },
    { table: 'study_session_messages', row: () => studyMessageId, what: 'study session transcript' },
    { table: 'textbook_chat_messages', row: () => textbookMessageId, what: 'the textbook copilot transcript' },
  ];

  for (const { table, row, what } of readCases) {
    it(`${table}: an instructor who can see the course but does not teach it reads nothing (${what})`, async () => {
      // The case that reproduces #1101. Before the migration this returns the
      // row: the old predicate asked only for institution membership with
      // role 'instructor', and the `courses` row it joins through is visible
      // to this reader via their unrelated class enrolment.
      const { data, error } = await visibleOutsiderClient
        .from(table as never)
        .select('id')
        .eq('id', row());
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it(`${table}: an instructor of another course reads nothing (${what})`, async () => {
      const { data, error } = await outsiderClient
        .from(table as never)
        .select('id')
        .eq('id', row());
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it(`${table}: the course's own instructor still reads it`, async () => {
      const { data, error } = await teachingClient
        .from(table as never)
        .select('id')
        .eq('id', row());
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it(`${table}: the institution admin still reads it`, async () => {
      // Admins were authorised by the same `ui.role` term the fix removes, so
      // this is the regression the fix most easily causes.
      const { data, error } = await adminClient
        .from(table as never)
        .select('id')
        .eq('id', row());
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });
  }

  // ---- writes -------------------------------------------------------------

  it('open_question_grades: an instructor who can see the course but does not teach it cannot grade the student', async () => {
    // A *second* question, deliberately: `open_question_grades` is
    // UNIQUE(open_question_id, user_id), so inserting against the already
    // graded question would be refused by the constraint whether or not RLS
    // did its job — a green test that proves nothing.
    const { error } = await visibleOutsiderClient.from('open_question_grades').insert({
      open_question_id: ungradedQuestionId,
      user_id: studentId,
      course_id: courseId,
      grade: 10,
      feedback: 'forged',
    });
    expect(error).not.toBeNull();
  });

  it('open_question_grades: an instructor who can see the course but does not teach it cannot rewrite the grade', async () => {
    // Compared against whatever the row holds now rather than the seeded
    // literal, so this stays true regardless of the order the cases below run
    // in (one of them edits the row as the teaching instructor).
    const { data: before } = await admin
      .from('open_question_grades')
      .select('feedback')
      .eq('id', gradeId)
      .single();
    const { error } = await visibleOutsiderClient
      .from('open_question_grades')
      .update({ grade: 5, feedback: 'tampered' })
      .eq('id', gradeId);
    expect(error).toBeNull(); // RLS narrows to zero rows rather than erroring
    const { data: after } = await admin
      .from('open_question_grades')
      .select('feedback')
      .eq('id', gradeId)
      .single();
    expect(after?.feedback).toBe(before?.feedback);
  });

  it('open_question_grades: an instructor who can see the course but does not teach it cannot delete the grade', async () => {
    const { error } = await visibleOutsiderClient
      .from('open_question_grades')
      .delete()
      .eq('id', gradeId);
    expect(error).toBeNull();
    const { data } = await admin.from('open_question_grades').select('id').eq('id', gradeId);
    expect(data).toHaveLength(1);
  });

  it('open_question_progress: an instructor who can see the course but does not teach it cannot unflag the student', async () => {
    const { data: before } = await admin
      .from('open_question_progress')
      .select('status')
      .eq('id', progressId)
      .single();
    const { error } = await visibleOutsiderClient
      .from('open_question_progress')
      .update({ status: 'abandoned' })
      .eq('id', progressId);
    expect(error).toBeNull();
    const { data: after } = await admin
      .from('open_question_progress')
      .select('status')
      .eq('id', progressId)
      .single();
    expect(after?.status).toBe(before?.status);
  });

  it('open_question_chats: an instructor who can see the course but does not teach it cannot edit the transcript', async () => {
    const { error } = await visibleOutsiderClient
      .from('open_question_chats')
      .update({ flagged_offensive: true })
      .eq('id', chatId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('open_question_chats')
      .select('flagged_offensive')
      .eq('id', chatId)
      .single();
    expect(data?.flagged_offensive).toBe(false);
  });

  // ---- the paths the fix must not break -----------------------------------

  it('the course instructor can still grade and unflag their own students', async () => {
    const { error: updateError } = await teachingClient
      .from('open_question_grades')
      .update({ feedback: 'edited by the teaching instructor' })
      .eq('id', gradeId);
    expect(updateError).toBeNull();
    const { data } = await admin
      .from('open_question_grades')
      .select('feedback')
      .eq('id', gradeId)
      .single();
    expect(data?.feedback).toBe('edited by the teaching instructor');

    const { error: progressError } = await teachingClient
      .from('open_question_progress')
      .update({ status: 'completed' })
      .eq('id', progressId);
    expect(progressError).toBeNull();
    // Put it back so the write-denial cases above stay order-independent.
    await admin
      .from('open_question_progress')
      .update({ status: 'in_progress' })
      .eq('id', progressId);
  });

  it('the student still reads their own transcript, and no classmate can', async () => {
    // The `user_id = auth.uid()` policies are untouched by the fix; asserting
    // both halves keeps a future rewrite of this table honest about which
    // student-facing read it is preserving.
    const { data: own, error: ownError } = await studentClient
      .from('open_question_chats')
      .select('id')
      .eq('id', chatId);
    expect(ownError).toBeNull();
    expect(own).toHaveLength(1);

    const { data: classmateSees, error: classmateError } = await classmateClient
      .from('open_question_chats')
      .select('id')
      .eq('id', chatId);
    expect(classmateError).toBeNull();
    expect(classmateSees).toHaveLength(0);
  });
});
