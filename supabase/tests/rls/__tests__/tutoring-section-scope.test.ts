// Section scoping on tutoring writes and chapter progress (#1105, part of #1097).
//
// The reads on these tables are a separate problem (#1101, institution-wide).
// This suite is about what a 1Α-restricted instructor could *do* to 1Β:
//
//   * unpause, edit or delete their tutoring progress — the pause/unpause flow
//     in OpenQuestionChatHistory.tsx writes exactly this;
//   * delete their tutoring messages;
//   * post an `instructor`-role message into their thread with the tutor,
//     which the student sees attributed to a named instructor;
//   * read and edit another class's chapter-completion state.
//
// `course_chapter_progress` also carries the #1101 failure in miniature: the
// class-scoped policies from 20260401000000 were added next to the course-wide
// pair from 20251226141136 without dropping them, and permissive policies OR
// together, so the narrow pair has been inert. The cases below are therefore
// only meaningful once those two are gone — which is why this suite asserts
// against the *widest* reader that used to get through.

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
  createCourseMaterial,
  createMaterialChapter,
  createCourseChapterProgress,
  createStudySession,
  createStudyProgress,
  createStudySessionMessage,
  createOpenTypeQuestion,
  createOpenQuestionChat,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

function ids(data: unknown): string[] {
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe('tutoring writes and chapter progress are section-scoped', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;

  let classAId: string;
  let offeringAId: string;
  let classBId: string;
  let offeringBId: string;

  let instrA: SupabaseClient; // restricted to section A
  let instrAId: string;
  let instrB: SupabaseClient; // restricted to section B
  let unrestricted: SupabaseClient;
  let unrestrictedId: string;

  let studentAId: string;
  let studentBId: string;

  let progressAId: string;
  let progressBId: string;
  let messageAId: string;
  let messageBId: string;
  let openQuestionId: string;

  let chapterProgressAId: string;
  let chapterProgressBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Tutor ${uid}`);
    courseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    offeringAId = await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    offeringBId = await createOffering(admin, classBId, courseId);

    const a = await createTestUserClient(admin, `rls-tut-a-${uid}@test.local`);
    instrA = a.client;
    instrAId = a.userId;
    userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, a.userId);
    await addSectionRestriction(admin, courseId, classAId, a.userId);

    const b = await createTestUserClient(admin, `rls-tut-b-${uid}@test.local`);
    instrB = b.client;
    userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, b.userId);
    await addSectionRestriction(admin, courseId, classBId, b.userId);

    const u = await createTestUserClient(admin, `rls-tut-u-${uid}@test.local`);
    unrestricted = u.client;
    unrestrictedId = u.userId;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    const sa = await createTestUserClient(admin, `rls-tut-stu-a-${uid}@test.local`);
    studentAId = sa.userId;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    const sb = await createTestUserClient(admin, `rls-tut-stu-b-${uid}@test.local`);
    studentBId = sb.userId;
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    const studySessionId = await createStudySession(admin, courseId);
    progressAId = await createStudyProgress(
      admin,
      studySessionId,
      studentAId,
      courseId,
      offeringAId
    );
    progressBId = await createStudyProgress(
      admin,
      studySessionId,
      studentBId,
      courseId,
      offeringBId
    );
    messageAId = await createStudySessionMessage(admin, progressAId);
    messageBId = await createStudySessionMessage(admin, progressBId);

    openQuestionId = await createOpenTypeQuestion(admin, courseId);

    const materialId = await createCourseMaterial(admin, courseId);
    const chapterId = await createMaterialChapter(admin, materialId);
    chapterProgressAId = await createCourseChapterProgress(admin, {
      courseId,
      chapterId,
      classId: classAId,
    });
    chapterProgressBId = await createCourseChapterProgress(admin, {
      courseId,
      chapterId,
      classId: classBId,
    });
  });

  afterAll(async () => {
    // CLAUDE.md's "no cleanup" rule is scoped to E2E, where the target is a
    // shared preview branch and the point is to need no privileged credential.
    // The RLS harness is service-role by construction and runs against a local
    // stack that `db reset` recreates.
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---- student_study_progress: the pause/unpause path ---------------------

  it('a restricted instructor cannot unpause another section\'s tutoring progress', async () => {
    const { error } = await instrA
      .from('student_study_progress')
      .update({ status: 'completed' })
      .eq('id', progressBId);
    expect(error).toBeNull(); // narrowed to zero rows
    const { data } = await admin
      .from('student_study_progress')
      .select('status')
      .eq('id', progressBId)
      .single();
    expect(data?.status).toBe('in_progress');
  });

  it('a restricted instructor can unpause their own section\'s progress', async () => {
    const { error } = await instrA
      .from('student_study_progress')
      .update({ status: 'completed' })
      .eq('id', progressAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('student_study_progress')
      .select('status')
      .eq('id', progressAId)
      .single();
    expect(data?.status).toBe('completed');
  });

  it('a restricted instructor cannot delete another section\'s progress', async () => {
    const { error } = await instrA
      .from('student_study_progress')
      .delete()
      .eq('id', progressBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('student_study_progress')
      .select('id')
      .eq('id', progressBId);
    expect(data).toHaveLength(1);
  });

  // ---- study_session_messages --------------------------------------------

  it('a restricted instructor cannot delete another section\'s tutoring messages', async () => {
    const { error } = await instrA
      .from('study_session_messages')
      .delete()
      .eq('id', messageBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('study_session_messages')
      .select('id')
      .eq('id', messageBId);
    expect(data).toHaveLength(1);
  });

  it('a restricted instructor cannot post into another section\'s tutor thread', async () => {
    // The student sees an instructor-role message attributed to a named
    // person, so this is impersonation inside a conversation the instructor
    // has no business being in.
    const { error } = await instrA.from('study_session_messages').insert({
      progress_id: progressBId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'A message the 1Β student should never receive from me',
    });
    expect(error).not.toBeNull();
  });

  it('a restricted instructor can post into their own section\'s tutor thread', async () => {
    // The control: the same insert differing only in whose thread it targets
    // has to succeed, or the refusal above would be about the row's shape.
    const { error } = await instrA.from('study_session_messages').insert({
      progress_id: progressAId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'Have another look at question 3',
    });
    expect(error).toBeNull();
  });

  it('an unrestricted instructor can post into either section\'s thread', async () => {
    // The "no restriction rows means full access" semantic, on the surface
    // where the restriction bites hardest.
    const { error } = await unrestricted.from('study_session_messages').insert({
      progress_id: progressBId,
      role: 'instructor',
      sender_user_id: unrestrictedId,
      content: 'I teach every section of this course',
    });
    expect(error).toBeNull();
  });

  it('an instructor cannot post a message attributed to somebody else', async () => {
    // `sender_user_id = auth.uid()` is a separate conjunct of the same policy
    // and has to survive the rewrite — otherwise a section-correct instructor
    // could still sign a message with a colleague's name.
    const { error } = await instrA.from('study_session_messages').insert({
      progress_id: progressAId,
      role: 'instructor',
      sender_user_id: unrestrictedId,
      content: 'signed by someone who did not write it',
    });
    expect(error).not.toBeNull();
  });

  // ---- open_question_chats: the same injection on the sibling surface -----

  it('a restricted instructor cannot post into another section\'s open-question thread', async () => {
    const { error } = await instrA.from('open_question_chats').insert({
      open_question_id: openQuestionId,
      user_id: studentBId,
      course_id: courseId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'not my student',
    });
    expect(error).not.toBeNull();
  });

  it('a restricted instructor can post into their own section\'s open-question thread', async () => {
    const { error } = await instrA.from('open_question_chats').insert({
      open_question_id: openQuestionId,
      user_id: studentAId,
      course_id: courseId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'try restating the assumption',
    });
    expect(error).toBeNull();
  });

  // ---- course_chapter_progress -------------------------------------------

  it('each restricted instructor reads only their own class\'s chapter progress', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('course_chapter_progress')
      .select('id')
      .in('id', [chapterProgressAId, chapterProgressBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([chapterProgressAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('course_chapter_progress')
      .select('id')
      .in('id', [chapterProgressAId, chapterProgressBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([chapterProgressBId]);
  });

  it('an unrestricted instructor reads both classes\' chapter progress', async () => {
    const { data } = await unrestricted
      .from('course_chapter_progress')
      .select('id')
      .in('id', [chapterProgressAId, chapterProgressBId]);
    expect(ids(data)).toEqual([chapterProgressAId, chapterProgressBId].sort());
  });

  it('a restricted instructor cannot flip another class\'s chapter to incomplete', async () => {
    const { error } = await instrA
      .from('course_chapter_progress')
      .update({ is_complete: false })
      .eq('id', chapterProgressBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('course_chapter_progress')
      .select('is_complete')
      .eq('id', chapterProgressBId)
      .single();
    expect(data?.is_complete).toBe(true);
  });

  it('a restricted instructor can flip their own class\'s chapter', async () => {
    const { error } = await instrA
      .from('course_chapter_progress')
      .update({ is_complete: false })
      .eq('id', chapterProgressAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('course_chapter_progress')
      .select('is_complete')
      .eq('id', chapterProgressAId)
      .single();
    expect(data?.is_complete).toBe(false);
  });
});
