// Tables under test:
//   * public.open_question_grades
//   * public.open_question_progress
//   * public.open_question_chats
//
// The highest-harm cluster named in #1095: a student's submitted answers,
// their grades and feedback, and their tutoring conversations.
//
// All three predate the course-instructor RBAC migration
// (20260401000000, #52) and none of them were rewritten by it. Where
// `offerings` asks `is_course_instructor(course_id, auth.uid())`, these ask
// a hand-rolled `EXISTS (courses JOIN user_institutions WHERE ui.role IN
// ('admin','instructor'))` — institution-wide, course-blind, and with no
// `NOT is_suspended` filter. Several tests below are therefore
// characterization tests: they pin what the policies do today and say so.
// See the `#1095 findings` block at the bottom.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createOpenTypeQuestion,
  createOpenQuestionGrade,
  createOpenQuestionProgress,
  createOpenQuestionChat,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('open_question_grades + open_question_progress + open_question_chats RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  // Institution A holds two courses so the course-blindness of these policies
  // can be probed without leaving the tenant.
  let instA: string;
  let courseA: string;
  let courseOther: string;
  let classA: string;
  let offeringA: string;
  let questionA: string;
  let questionOther: string;

  let instB: string;
  let courseB: string;
  let classB: string;
  let questionB: string;

  // Student work belonging to `student` on courseA.
  let gradeId: string;
  let progressId: string;
  let chatId: string;
  // The same, on courseOther — nobody in this suite is assigned to that course.
  let otherCourseGradeId: string;
  let otherCourseChatId: string;
  // And in the other institution.
  let foreignGradeId: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient; // second student, same class
  let peerId: string;

  let instructorClient: SupabaseClient; // assigned to courseA
  let instructorId: string;
  let unassignedInstructorClient: SupabaseClient; // instructor role, no course
  let suspendedInstructorClient: SupabaseClient; // assigned to courseA, suspended
  let adminAClient: SupabaseClient;
  let outsiderInstructorClient: SupabaseClient; // instructor in institution B
  let superAdminClient: SupabaseClient;

  const superAdminEmail = `rls-oq-sa-${uid}@test.local`;
  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS OQ A ${uid}`);
    courseA = await createCourse(admin, instA);
    courseOther = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    offeringA = await createOffering(admin, classA, courseA);
    questionA = await createOpenTypeQuestion(admin, courseA);
    questionOther = await createOpenTypeQuestion(admin, courseOther);

    instB = await createInstitution(admin, `RLS OQ B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);
    questionB = await createOpenTypeQuestion(admin, courseB);

    const stu = await createTestUserClient(admin, `rls-oq-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-oq-peer-${uid}@test.local`);
    peerClient = peer.client; peerId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-oq-instr-${uid}@test.local`);
    instructorClient = instr.client; instructorId = instr.userId; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const unassigned = await createTestUserClient(admin, `rls-oq-unassigned-${uid}@test.local`);
    unassignedInstructorClient = unassigned.client; userIds.push(unassigned.userId);
    await addUserToInstitution(admin, unassigned.userId, instA, 'instructor');

    const susp = await createTestUserClient(admin, `rls-oq-susp-${uid}@test.local`);
    suspendedInstructorClient = susp.client; userIds.push(susp.userId);
    await addUserToInstitution(admin, susp.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, susp.userId);
    const { error: suspendError } = await admin
      .from('user_institutions')
      .update({ is_suspended: true })
      .eq('user_id', susp.userId)
      .eq('institution_id', instA);
    if (suspendError) throw new Error(`suspend instructor: ${suspendError.message}`);

    const adm = await createTestUserClient(admin, `rls-oq-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const outInstr = await createTestUserClient(admin, `rls-oq-out-instr-${uid}@test.local`);
    outsiderInstructorClient = outInstr.client; userIds.push(outInstr.userId);
    await addUserToInstitution(admin, outInstr.userId, instB, 'instructor');
    await assignCourseInstructor(admin, courseB, outInstr.userId);

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    gradeId = await createOpenQuestionGrade(admin, {
      openQuestionId: questionA, userId: studentId, courseId: courseA, offeringId: offeringA,
    });
    progressId = await createOpenQuestionProgress(admin, {
      userId: studentId, openQuestionId: questionA, courseId: courseA, offeringId: offeringA,
    });
    chatId = await createOpenQuestionChat(admin, {
      openQuestionId: questionA, userId: studentId, courseId: courseA,
    });

    otherCourseGradeId = await createOpenQuestionGrade(admin, {
      openQuestionId: questionOther, userId: peerId, courseId: courseOther,
    });
    otherCourseChatId = await createOpenQuestionChat(admin, {
      openQuestionId: questionOther, userId: peerId, courseId: courseOther,
    });

    foreignGradeId = await createOpenQuestionGrade(admin, {
      openQuestionId: questionB, userId: peerId, courseId: courseB,
    });
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // open_question_grades
  // =====================================================================

  it('student reads their own grade', async () => {
    const { data, error } = await studentClient
      .from('open_question_grades').select('id').eq('id', gradeId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot read a classmate’s grade', async () => {
    const { data, error } = await peerClient
      .from('open_question_grades').select('id').eq('id', gradeId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot write their own grade', async () => {
    const { error: insertError } = await studentClient
      .from('open_question_grades')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA, grade: 100,
      });
    expect(insertError).not.toBeNull();

    const { data: updated } = await studentClient
      .from('open_question_grades').update({ grade: 100 }).eq('id', gradeId).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await studentClient
      .from('open_question_grades').delete().eq('id', gradeId).select();
    expect(deleted).toHaveLength(0);
  });

  it('assigned instructor reads and grades student work in their course', async () => {
    const { data: read, error } = await instructorClient
      .from('open_question_grades').select('id').eq('id', gradeId);
    expect(error).toBeNull();
    expect(read).toHaveLength(1);

    const { data: updated, error: updateError } = await instructorClient
      .from('open_question_grades').update({ grade: 91 }).eq('id', gradeId).select('id');
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
  });

  it('institution admin reads grades in their institution', async () => {
    const { data, error } = await adminAClient
      .from('open_question_grades').select('id').eq('id', gradeId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('super admin reads grades across institutions', async () => {
    const { data, error } = await superAdminClient
      .from('open_question_grades').select('id').in('id', [gradeId, foreignGradeId]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('instructor of another institution reads no grade of this one', async () => {
    const { data, error } = await outsiderInstructorClient
      .from('open_question_grades').select('id').in('id', [gradeId, otherCourseGradeId]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('instructor of another institution cannot grade into this one', async () => {
    const { error } = await outsiderInstructorClient
      .from('open_question_grades')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA, grade: 5,
      });
    expect(error).not.toBeNull();
  });

  // =====================================================================
  // open_question_progress
  // =====================================================================

  it('student manages their own progress', async () => {
    const { data: read } = await studentClient
      .from('open_question_progress').select('id').eq('id', progressId);
    expect(read).toHaveLength(1);

    const { data: updated, error } = await studentClient
      .from('open_question_progress')
      .update({ status: 'completed' }).eq('id', progressId).select('id');
    expect(error).toBeNull();
    expect(updated).toHaveLength(1);
  });

  it('student cannot see or touch a classmate’s progress', async () => {
    const { data: read } = await peerClient
      .from('open_question_progress').select('id').eq('id', progressId);
    expect(read).toHaveLength(0);

    const { data: updated } = await peerClient
      .from('open_question_progress').update({ status: 'completed' }).eq('id', progressId).select();
    expect(updated).toHaveLength(0);
  });

  it('student cannot create progress in another user’s name', async () => {
    const { error } = await peerClient
      .from('open_question_progress')
      .insert({ user_id: studentId, open_question_id: questionA, course_id: courseA });
    expect(error).not.toBeNull();
  });

  it('assigned instructor reads student progress in their course', async () => {
    const { data, error } = await instructorClient
      .from('open_question_progress').select('id').eq('id', progressId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('instructor of another institution reads no progress of this one', async () => {
    const { data, error } = await outsiderInstructorClient
      .from('open_question_progress').select('id').eq('id', progressId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // open_question_chats
  // =====================================================================

  it('student reads their own tutoring conversation', async () => {
    const { data, error } = await studentClient
      .from('open_question_chats').select('id').eq('id', chatId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot read a classmate’s tutoring conversation', async () => {
    const { data, error } = await peerClient
      .from('open_question_chats').select('id').eq('id', chatId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student can post a user-role message as themselves', async () => {
    const { data, error } = await studentClient
      .from('open_question_chats')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA,
        role: 'user', content: 'a question from the student',
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot forge an assistant or instructor turn', async () => {
    // The WITH CHECK pins role='user', so a student cannot fabricate tutor
    // output and cannot impersonate an instructor reply in their own thread.
    const { error: asAssistant } = await studentClient
      .from('open_question_chats')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA,
        role: 'assistant', content: 'forged tutor answer',
      });
    expect(asAssistant).not.toBeNull();

    const { error: asInstructor } = await studentClient
      .from('open_question_chats')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA,
        role: 'instructor', content: 'forged instructor reply',
        sender_user_id: studentId,
      });
    expect(asInstructor).not.toBeNull();
  });

  it('student cannot post into a classmate’s thread', async () => {
    const { error } = await peerClient
      .from('open_question_chats')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA,
        role: 'user', content: 'message in someone else’s thread',
      });
    expect(error).not.toBeNull();
  });

  it('assigned instructor can post an instructor turn into a student thread', async () => {
    const { data, error } = await instructorClient
      .from('open_question_chats')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA,
        role: 'instructor', content: 'instructor guidance',
        sender_user_id: instructorId,
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('instructor cannot post an instructor turn under someone else’s name', async () => {
    const { error } = await instructorClient
      .from('open_question_chats')
      .insert({
        open_question_id: questionA, user_id: studentId, course_id: courseA,
        role: 'instructor', content: 'spoofed sender',
        sender_user_id: studentId,
      });
    expect(error).not.toBeNull();
  });

  it('nobody can delete a chat message through the API', async () => {
    // There is no DELETE policy on open_question_chats at all, so the
    // tutoring transcript is append-only for every role including admins.
    const { data: byStudent } = await studentClient
      .from('open_question_chats').delete().eq('id', chatId).select();
    expect(byStudent).toHaveLength(0);

    const { data: byInstructor } = await instructorClient
      .from('open_question_chats').delete().eq('id', chatId).select();
    expect(byInstructor).toHaveLength(0);

    const { data: byAdmin } = await adminAClient
      .from('open_question_chats').delete().eq('id', chatId).select();
    expect(byAdmin).toHaveLength(0);

    const { data: bySuperAdmin } = await superAdminClient
      .from('open_question_chats').delete().eq('id', chatId).select();
    expect(bySuperAdmin).toHaveLength(0);
  });

  it('instructor of another institution reads no conversation of this one', async () => {
    const { data, error } = await outsiderInstructorClient
      .from('open_question_chats').select('id').in('id', [chatId, otherCourseChatId]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // Course scoping — and where it actually comes from.
  //
  // Read on their own, all three tables look institution-wide: every policy
  // is a hand-rolled `EXISTS (courses c JOIN user_institutions ui WHERE
  // c.id = <table>.course_id AND ui.user_id = auth.uid() AND ui.role IN
  // ('admin','instructor'))`, which names no course assignment and no
  // suspension flag. None of them were rewritten by the course-instructor
  // RBAC migration (20260401000000, #52).
  //
  // They are nonetheless correctly scoped, because a policy expression is
  // evaluated as the calling user and so the `FROM courses` inside it is
  // itself subject to `courses` RLS — and "Users can view courses in their
  // institution" requires `user_belongs_to_institution` (which excludes
  // suspended members) AND one of is_institution_admin / is_course_instructor
  // / user_has_class_course_access.
  //
  // That makes the scoping of student answers, grades and tutoring
  // transcripts load-bearing on a *different* table's SELECT policy. Widening
  // `courses` SELECT — say, to let any member list the institution's courses
  // — would silently widen all three of these too. The last test pins that
  // dependency so the coupling is visible at the point where it would break.
  // =====================================================================

  it('instructor assigned to no course reads no grades', async () => {
    const { data, error } = await unassignedInstructorClient
      .from('open_question_grades').select('id').eq('id', gradeId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('instructor reads no grades for a course in their institution they do not teach', async () => {
    const { data, error } = await instructorClient
      .from('open_question_grades').select('id').eq('id', otherCourseGradeId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('instructor reads no tutoring conversation for a course they do not teach', async () => {
    const { data, error } = await instructorClient
      .from('open_question_chats').select('id').eq('id', otherCourseChatId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('suspending the membership cuts off grade read and write', async () => {
    const { data: read, error } = await suspendedInstructorClient
      .from('open_question_grades').select('id').eq('id', gradeId);
    expect(error).toBeNull();
    expect(read).toHaveLength(0);

    const { data: updated } = await suspendedInstructorClient
      .from('open_question_grades').update({ grade: 42 }).eq('id', gradeId).select('id');
    expect(updated).toHaveLength(0);
  });

  it('an unassigned instructor cannot delete a student’s grade', async () => {
    const doomed = await createOpenQuestionGrade(admin, {
      openQuestionId: questionOther, userId: studentId, courseId: courseOther,
    });
    const { data: deleted } = await unassignedInstructorClient
      .from('open_question_grades').delete().eq('id', doomed).select('id');
    expect(deleted).toHaveLength(0);

    // Still there when read with the service role.
    const { data: survives } = await admin
      .from('open_question_grades').select('id').eq('id', doomed);
    expect(survives).toHaveLength(1);
  });

  it('the scoping above is inherited from courses RLS, not stated locally', async () => {
    // If this ever starts returning a row while the grade tests above still
    // pass, the coupling documented in this block has been broken and the
    // three tables need their own course predicate.
    const { data: canSeeCourse } = await instructorClient
      .from('courses').select('id').eq('id', courseOther);
    expect(canSeeCourse).toHaveLength(0);

    const { data: canSeeOwnCourse } = await instructorClient
      .from('courses').select('id').eq('id', courseA);
    expect(canSeeOwnCourse).toHaveLength(1);
  });
});
