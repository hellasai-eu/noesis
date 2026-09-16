// Tables under test:
//   * public.study_sessions
//   * public.student_study_progress
//   * public.study_session_messages
//   * public.study_session_competencies
//   * public.course_chapter_progress
//
// The AI study-session pathway: an instructor authors a session, a student
// works through it, and the conversation is stored per progress row.
//
// `study_session_messages` is the sensitive one — it is a tutoring transcript,
// reachable only through its `progress_id`, and its policies mirror the
// open-question chat table: students see their own thread, staff in the course
// can read it, only an instructor may author an `instructor` turn, and only the
// owner may author a `user` turn.
//
// `course_chapter_progress` is worth reading twice: it carries four permissive
// policies, two of which are both called "…can manage chapter progress" and
// were added by different migrations. Permissive policies OR together, so the
// effective grant is the union — a fact the suite pins from both directions.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseMaterial,
  createMaterialChapter,
  createCourseCompetency,
  createStudySession,
  createStudyProgress,
  createStudySessionMessage,
  createCourseChapterProgress,
  addStudySessionCompetency,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('study sessions, progress, messages and chapter progress RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA: string;
  let offeringA: string;
  let chapterA: string;

  let instB: string;
  let courseB: string;
  let classB: string;

  let readySession: string;
  let draftSession: string;
  let foreignSession: string;

  let ownProgress: string;
  let peerProgress: string;
  let ownMessage: string;
  let peerMessage: string;
  let competencyLink: string;
  let chapterProgress: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient;
  let peerId: string;
  let instructorClient: SupabaseClient;
  let instructorId: string;
  let adminAClient: SupabaseClient;
  let outsiderClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS SS A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    offeringA = await createOffering(admin, classA, courseA);
    chapterA = await createMaterialChapter(admin, await createCourseMaterial(admin, courseA));

    instB = await createInstitution(admin, `RLS SS B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);

    const stu = await createTestUserClient(admin, `rls-ss-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-ss-peer-${uid}@test.local`);
    peerClient = peer.client; peerId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-ss-instr-${uid}@test.local`);
    instructorClient = instr.client; instructorId = instr.userId; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const adm = await createTestUserClient(admin, `rls-ss-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const out = await createTestUserClient(admin, `rls-ss-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'student');
    await enrollInClass(admin, classB, out.userId, 'student');

    readySession = await createStudySession(admin, courseA);
    foreignSession = await createStudySession(admin, courseB);

    const { data: draft, error: draftError } = await admin
      .from('study_sessions')
      .insert({ course_id: courseA, title: `RLS draft ${uid}`, status: 'draft' })
      .select('id').single();
    if (draftError) throw new Error(`draft study session: ${draftError.message}`);
    draftSession = draft.id;

    ownProgress = await createStudyProgress(admin, readySession, studentId, courseA, offeringA);
    peerProgress = await createStudyProgress(admin, readySession, peerId, courseA, offeringA);
    ownMessage = await createStudySessionMessage(admin, ownProgress);
    peerMessage = await createStudySessionMessage(admin, peerProgress);

    competencyLink = await addStudySessionCompetency(
      admin, readySession, await createCourseCompetency(admin, courseA)
    );
    chapterProgress = await createCourseChapterProgress(admin, {
      courseId: courseA, chapterId: chapterA, classId: classA,
    });
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // study_sessions
  // =====================================================================

  it('student sees a ready session and not a draft one', async () => {
    const { data: ready, error } = await studentClient
      .from('study_sessions').select('id').eq('id', readySession);
    expect(error).toBeNull();
    expect(ready).toHaveLength(1);

    const { data: draft } = await studentClient
      .from('study_sessions').select('id').eq('id', draftSession);
    expect(draft).toHaveLength(0);
  });

  it('assigned instructor sees both, and can author one', async () => {
    const { data: both, error } = await instructorClient
      .from('study_sessions').select('id').in('id', [readySession, draftSession]);
    expect(error).toBeNull();
    expect(both).toHaveLength(2);

    const { data: created, error: createError } = await instructorClient
      .from('study_sessions')
      .insert({ course_id: courseA, title: `instructor session ${uid}`, status: 'draft' })
      .select('id').single();
    expect(createError).toBeNull();
    expect(created).not.toBeNull();
  });

  it('student cannot author or edit a study session', async () => {
    const { error } = await studentClient
      .from('study_sessions')
      .insert({ course_id: courseA, title: 'student session', status: 'ready' });
    expect(error).not.toBeNull();

    const { data: updated } = await studentClient
      .from('study_sessions').update({ title: 'renamed' }).eq('id', readySession).select();
    expect(updated).toHaveLength(0);
  });

  it('nobody sees the other institution’s study session', async () => {
    const { data: byStudent, error } = await studentClient
      .from('study_sessions').select('id').eq('id', foreignSession);
    expect(error).toBeNull();
    expect(byStudent).toHaveLength(0);

    const { data: byAdmin } = await adminAClient
      .from('study_sessions').select('id').eq('id', foreignSession);
    expect(byAdmin).toHaveLength(0);
  });

  // =====================================================================
  // student_study_progress
  // =====================================================================

  it('student manages their own progress and cannot see a classmate’s', async () => {
    const { data: own, error } = await studentClient
      .from('student_study_progress').select('id').eq('id', ownProgress);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: theirs } = await studentClient
      .from('student_study_progress').select('id').eq('id', peerProgress);
    expect(theirs).toHaveLength(0);

    const { data: updated, error: updateError } = await studentClient
      .from('student_study_progress')
      .update({ status: 'completed' }).eq('id', ownProgress).select('id');
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(1);
  });

  it('assigned instructor reads every progress row in their course', async () => {
    const { data, error } = await instructorClient
      .from('student_study_progress').select('id').in('id', [ownProgress, peerProgress]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('student of another institution reads no progress here', async () => {
    const { data, error } = await outsiderClient
      .from('student_study_progress').select('id').in('id', [ownProgress, peerProgress]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // study_session_messages — the tutoring transcript
  // =====================================================================

  it('student reads their own transcript and not a classmate’s', async () => {
    const { data: own, error } = await studentClient
      .from('study_session_messages').select('id').eq('id', ownMessage);
    expect(error).toBeNull();
    expect(own).toHaveLength(1);

    const { data: theirs } = await studentClient
      .from('study_session_messages').select('id').eq('id', peerMessage);
    expect(theirs).toHaveLength(0);
  });

  it('student can post a user turn into their own thread only', async () => {
    const { data, error } = await studentClient
      .from('study_session_messages')
      .insert({ progress_id: ownProgress, role: 'user', content: 'my question' })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const { error: intoPeer } = await studentClient
      .from('study_session_messages')
      .insert({ progress_id: peerProgress, role: 'user', content: 'not my thread' });
    expect(intoPeer).not.toBeNull();
  });

  it('student cannot forge an assistant or instructor turn', async () => {
    const { error: asAssistant } = await studentClient
      .from('study_session_messages')
      .insert({ progress_id: ownProgress, role: 'assistant', content: 'forged tutor reply' });
    expect(asAssistant).not.toBeNull();

    const { error: asInstructor } = await studentClient
      .from('study_session_messages')
      .insert({
        progress_id: ownProgress, role: 'instructor',
        content: 'forged instructor reply', sender_user_id: studentId,
      });
    expect(asInstructor).not.toBeNull();
  });

  it('assigned instructor can post an instructor turn under their own name only', async () => {
    const { data, error } = await instructorClient
      .from('study_session_messages')
      .insert({
        progress_id: ownProgress, role: 'instructor',
        content: 'instructor guidance', sender_user_id: instructorId,
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const { error: spoofed } = await instructorClient
      .from('study_session_messages')
      .insert({
        progress_id: ownProgress, role: 'instructor',
        content: 'spoofed sender', sender_user_id: studentId,
      });
    expect(spoofed).not.toBeNull();
  });

  it('staff in the course can read a student transcript', async () => {
    const { data: byInstructor, error } = await instructorClient
      .from('study_session_messages').select('id').in('id', [ownMessage, peerMessage]);
    expect(error).toBeNull();
    expect(byInstructor).toHaveLength(2);

    const { data: byAdmin } = await adminAClient
      .from('study_session_messages').select('id').in('id', [ownMessage, peerMessage]);
    expect(byAdmin).toHaveLength(2);
  });

  it('a student cannot delete their own transcript, but course staff can', async () => {
    // There is no student DELETE policy — only "Admins and instructors can
    // delete study messages in their courses". A student cannot redact their
    // own conversation.
    const { data: byStudent } = await studentClient
      .from('study_session_messages').delete().eq('id', ownMessage).select();
    expect(byStudent).toHaveLength(0);

    const disposable = await createStudySessionMessage(admin, ownProgress);
    const { data: byInstructor } = await instructorClient
      .from('study_session_messages').delete().eq('id', disposable).select('id');
    expect(byInstructor).toHaveLength(1);
  });

  it('student of another institution reads no transcript here', async () => {
    const { data, error } = await outsiderClient
      .from('study_session_messages').select('id').in('id', [ownMessage, peerMessage]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // =====================================================================
  // study_session_competencies
  // =====================================================================

  it('any member of the owning institution reads a session’s competency tags', async () => {
    const { data, error } = await studentClient
      .from('study_session_competencies').select('id').eq('id', competencyLink);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('a member of another institution reads none of them', async () => {
    const { data, error } = await outsiderClient
      .from('study_session_competencies').select('id').eq('id', competencyLink);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot tag or untag a study session', async () => {
    const competency = await createCourseCompetency(admin, courseA);
    const { error } = await studentClient
      .from('study_session_competencies')
      .insert({ study_session_id: readySession, competency_id: competency });
    expect(error).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('study_session_competencies').delete().eq('id', competencyLink).select();
    expect(deleted).toHaveLength(0);
  });

  it('assigned instructor can tag a study session', async () => {
    const competency = await createCourseCompetency(admin, courseA);
    const { data, error } = await instructorClient
      .from('study_session_competencies')
      .insert({ study_session_id: readySession, competency_id: competency })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  // =====================================================================
  // course_chapter_progress — four permissive policies, unioned
  // =====================================================================

  it('enrolled student reads chapter progress for their class', async () => {
    const { data, error } = await studentClient
      .from('course_chapter_progress').select('id').eq('id', chapterProgress);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot mark a chapter complete', async () => {
    const { data: updated } = await studentClient
      .from('course_chapter_progress')
      .update({ is_complete: false }).eq('id', chapterProgress).select();
    expect(updated).toHaveLength(0);

    const freshChapter = await createMaterialChapter(
      admin, await createCourseMaterial(admin, courseA)
    );
    const { error } = await studentClient
      .from('course_chapter_progress')
      .insert({ course_id: courseA, chapter_id: freshChapter, class_id: classA });
    expect(error).not.toBeNull();
  });

  it('assigned instructor can mark a chapter complete', async () => {
    const freshChapter = await createMaterialChapter(
      admin, await createCourseMaterial(admin, courseA)
    );
    const { data, error } = await instructorClient
      .from('course_chapter_progress')
      .insert({
        course_id: courseA, chapter_id: freshChapter, class_id: classA,
        is_complete: true, completed_by: instructorId,
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student of another institution reads no chapter progress here', async () => {
    const { data, error } = await outsiderClient
      .from('course_chapter_progress').select('id').eq('id', chapterProgress);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});
