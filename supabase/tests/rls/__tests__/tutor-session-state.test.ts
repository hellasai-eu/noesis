// Tables under test:
//   * public.socratic_session_state      + public.socratic_state_history
//   * public.study_tutor_session_state   + public.study_tutor_state_history
//   * public.copilot_sessions
//   * public.textbook_chat_messages
//
// Everything the tutors remember about a student between turns: the socratic
// open-question state machine, the study-guide tutor's equivalent, the course
// copilot's saved threads, and textbook chat.
//
// All six are owner-scoped with a staff read grant layered on top: instructors
// via is_course_instructor, institution and super admins via
// is_institution_admin. Four of those admin policies called the helper with
// its arguments reversed and so never granted anything (#1128, fixed in
// 20260820110000); the block at the bottom of this file covers the restored
// behaviour and the tenant boundary it stops at.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseMaterial,
  createOpenTypeQuestion,
  createStudySession,
  createStudyProgress,
  createSocraticSessionState,
  createSocraticStateHistory,
  createStudyTutorSessionState,
  createStudyTutorStateHistory,
  createCopilotSession,
  createTextbookChatMessage,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('tutor session state RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA: string;
  let offeringA: string;
  let materialA: string;

  let instB: string;
  let courseB: string;
  let classB: string;

  let ownSocratic: string;
  let peerSocratic: string;
  let ownSocraticHistory: string;
  let peerSocraticHistory: string;
  let ownTutorState: string;
  let peerTutorState: string;
  let ownTutorHistory: string;
  let ownCopilot: string;
  let peerCopilot: string;
  let ownTextbookChat: string;
  let peerTextbookChat: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient;
  let peerId: string;
  let instructorClient: SupabaseClient;
  let adminAClient: SupabaseClient;
  let outsiderClient: SupabaseClient;
  let superAdminClient: SupabaseClient;

  const superAdminEmail = `rls-tutor-sa-${uid}@test.local`;
  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Tutor A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    offeringA = await createOffering(admin, classA, courseA);
    materialA = await createCourseMaterial(admin, courseA);

    instB = await createInstitution(admin, `RLS Tutor B ${uid}`);
    courseB = await createCourse(admin, instB);
    classB = await createClass(admin, instB);

    const stu = await createTestUserClient(admin, `rls-tutor-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-tutor-peer-${uid}@test.local`);
    peerClient = peer.client; peerId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-tutor-instr-${uid}@test.local`);
    instructorClient = instr.client; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    const adm = await createTestUserClient(admin, `rls-tutor-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const out = await createTestUserClient(admin, `rls-tutor-out-${uid}@test.local`);
    outsiderClient = out.client; userIds.push(out.userId);
    await addUserToInstitution(admin, out.userId, instB, 'instructor');
    await assignCourseInstructor(admin, courseB, out.userId);

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    const questionA = await createOpenTypeQuestion(admin, courseA);
    ownSocratic = await createSocraticSessionState(admin, {
      userId: studentId, openQuestionId: questionA, courseId: courseA,
    });
    peerSocratic = await createSocraticSessionState(admin, {
      userId: peerId, openQuestionId: questionA, courseId: courseA,
    });
    ownSocraticHistory = await createSocraticStateHistory(admin, ownSocratic);
    peerSocraticHistory = await createSocraticStateHistory(admin, peerSocratic);

    const session = await createStudySession(admin, courseA);
    const ownProgress = await createStudyProgress(admin, session, studentId, courseA, offeringA);
    const peerProgress = await createStudyProgress(admin, session, peerId, courseA, offeringA);
    ownTutorState = await createStudyTutorSessionState(admin, {
      userId: studentId, progressId: ownProgress, courseId: courseA,
    });
    peerTutorState = await createStudyTutorSessionState(admin, {
      userId: peerId, progressId: peerProgress, courseId: courseA,
    });
    ownTutorHistory = await createStudyTutorStateHistory(admin, ownTutorState);

    ownCopilot = await createCopilotSession(admin, { userId: studentId, courseId: courseA });
    peerCopilot = await createCopilotSession(admin, { userId: peerId, courseId: courseA });

    ownTextbookChat = await createTextbookChatMessage(admin, {
      userId: studentId, courseId: courseA, materialId: materialA,
    });
    peerTextbookChat = await createTextbookChatMessage(admin, {
      userId: peerId, courseId: courseA, materialId: materialA,
    });
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // Owner scoping — the property every table in this file shares
  // =====================================================================

  it('a student reads their own tutor state and none of a classmate’s', async () => {
    const cases: Array<[string, string, string]> = [
      ['socratic_session_state', ownSocratic, peerSocratic],
      ['study_tutor_session_state', ownTutorState, peerTutorState],
      ['copilot_sessions', ownCopilot, peerCopilot],
      ['textbook_chat_messages', ownTextbookChat, peerTextbookChat],
    ];
    for (const [table, own, peers] of cases) {
      const { data: mine, error } = await studentClient
        .from(table).select('id').eq('id', own);
      expect(error, table).toBeNull();
      expect(mine, table).toHaveLength(1);

      const { data: theirs } = await studentClient
        .from(table).select('id').eq('id', peers);
      expect(theirs, table).toHaveLength(0);
    }
  });

  it('a student reads their own state history and none of a classmate’s', async () => {
    const { data: mine, error } = await studentClient
      .from('socratic_state_history').select('id').eq('id', ownSocraticHistory);
    expect(error).toBeNull();
    expect(mine).toHaveLength(1);

    const { data: theirs } = await studentClient
      .from('socratic_state_history').select('id').eq('id', peerSocraticHistory);
    expect(theirs).toHaveLength(0);

    const { data: tutorHistory } = await studentClient
      .from('study_tutor_state_history').select('id').eq('id', ownTutorHistory);
    expect(tutorHistory).toHaveLength(1);
  });

  it('a student cannot create tutor state in another user’s name', async () => {
    const question = await createOpenTypeQuestion(admin, courseA);
    const { error: socratic } = await studentClient
      .from('socratic_session_state')
      .insert({ user_id: peerId, open_question_id: question, course_id: courseA });
    expect(socratic).not.toBeNull();

    const { error: copilot } = await studentClient
      .from('copilot_sessions')
      .insert({ user_id: peerId, course_id: courseA, name: 'not mine' });
    expect(copilot).not.toBeNull();

    const { error: textbook } = await studentClient
      .from('textbook_chat_messages')
      .insert({
        user_id: peerId, course_id: courseA, material_id: materialA,
        role: 'user', content: 'not mine',
      });
    expect(textbook).not.toBeNull();
  });

  it('a student cannot rewrite a classmate’s tutor state', async () => {
    const { data: socratic } = await studentClient
      .from('socratic_session_state')
      .update({ current_state: { tampered: true } }).eq('id', peerSocratic).select();
    expect(socratic).toHaveLength(0);

    const { data: copilot } = await studentClient
      .from('copilot_sessions')
      .update({ name: 'tampered' }).eq('id', peerCopilot).select();
    expect(copilot).toHaveLength(0);
  });

  it('state history is append-only to end users — no update or delete path', async () => {
    // socratic_state_history and study_tutor_state_history grant SELECT to the
    // owner and to course staff, and nothing else. Only the service role can
    // write, which is what the tutor edge functions use.
    const { error: inserted } = await studentClient
      .from('socratic_state_history')
      .insert({
        session_state_id: ownSocratic, state_after: { forged: true },
        transition_type: 'forged',
      });
    expect(inserted).not.toBeNull();

    const { data: deleted } = await studentClient
      .from('socratic_state_history').delete().eq('id', ownSocraticHistory).select();
    expect(deleted).toHaveLength(0);
  });

  // =====================================================================
  // Staff reads
  // =====================================================================

  it('assigned instructor reads tutor state for their course', async () => {
    const { data: socratic, error } = await instructorClient
      .from('socratic_session_state').select('id').in('id', [ownSocratic, peerSocratic]);
    expect(error).toBeNull();
    expect(socratic).toHaveLength(2);

    const { data: tutor } = await instructorClient
      .from('study_tutor_session_state').select('id').in('id', [ownTutorState, peerTutorState]);
    expect(tutor).toHaveLength(2);

    const { data: history } = await instructorClient
      .from('socratic_state_history').select('id').eq('id', ownSocraticHistory);
    expect(history).toHaveLength(1);
  });

  it('institution admin reads textbook chat and copilot sessions', async () => {
    // These two use the correct argument order / an inline EXISTS, so the
    // admin grant works here.
    const { data: textbook, error } = await adminAClient
      .from('textbook_chat_messages').select('id').in('id', [ownTextbookChat, peerTextbookChat]);
    expect(error).toBeNull();
    expect(textbook).toHaveLength(2);

    const { data: copilot } = await adminAClient
      .from('copilot_sessions').select('id').in('id', [ownCopilot, peerCopilot]);
    expect(copilot).toHaveLength(2);
  });

  it('staff of another institution read nothing here', async () => {
    for (const table of [
      'socratic_session_state',
      'study_tutor_session_state',
      'copilot_sessions',
      'textbook_chat_messages',
    ]) {
      const { data, error } = await outsiderClient.from(table).select('id');
      expect(error, table).toBeNull();
      expect(data, table).toHaveLength(0);
    }
  });

  it('an instructor cannot rewrite a student’s tutor state', async () => {
    // Every staff grant on these tables is SELECT only.
    const { data: updated } = await instructorClient
      .from('socratic_session_state')
      .update({ current_state: { tampered: true } }).eq('id', ownSocratic).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await instructorClient
      .from('socratic_session_state').delete().eq('id', ownSocratic).select();
    expect(deleted).toHaveLength(0);
  });

  // =====================================================================
  // Institution-admin reads (#1128).
  //
  // The helper is is_institution_admin(_user_id uuid, _institution_id uuid).
  // These four policies used to pass (institution_id, auth.uid()) instead:
  //
  //   socratic_session_state    "Admins can read institution session states"
  //   study_tutor_session_state "Admins can read institution session states"
  //   socratic_state_history    "Admins can read institution state history"
  //   study_tutor_state_history "Admins can read institution state history"
  //
  // Both parameters are uuid, so it type-checked and evaluated false forever —
  // it looked for a user_institutions row whose user_id was an institution id.
  // It failed closed, so the admin visibility these policies were written to
  // grant simply never worked. 20260820110000 swaps the arguments back.
  //
  // Super admins are covered by the same four policies rather than a separate
  // grant: is_institution_admin() ends in `OR is_super_admin(_user_id)`, so
  // fixing the argument order restores both at once. None of these tables
  // calls is_super_admin() directly, which is why the reversal locked super
  // admins out too.
  // =====================================================================

  it('institution admin reads socratic session state for their institution', async () => {
    const { data, error } = await adminAClient
      .from('socratic_session_state').select('id').in('id', [ownSocratic, peerSocratic]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('institution admin reads study-tutor session state for their institution', async () => {
    const { data, error } = await adminAClient
      .from('study_tutor_session_state').select('id').in('id', [ownTutorState, peerTutorState]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('institution admin reads both state histories', async () => {
    const { data: socratic, error } = await adminAClient
      .from('socratic_state_history').select('id').eq('id', ownSocraticHistory);
    expect(error).toBeNull();
    expect(socratic).toHaveLength(1);

    const { data: tutor } = await adminAClient
      .from('study_tutor_state_history').select('id').eq('id', ownTutorHistory);
    expect(tutor).toHaveLength(1);
  });

  it('super admin reads tutor state through the same policies', async () => {
    const { data, error } = await superAdminClient
      .from('socratic_session_state').select('id').in('id', [ownSocratic, peerSocratic]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);

    const { data: history } = await superAdminClient
      .from('socratic_state_history').select('id').eq('id', ownSocraticHistory);
    expect(history).toHaveLength(1);
  });

  it('the restored admin grant stops at the tenant boundary', async () => {
    // The fix widens access to the right people, not to everyone: an admin of
    // another institution still reads nothing, and the grant is SELECT only.
    const { data: foreign, error } = await outsiderClient
      .from('socratic_session_state').select('id').in('id', [ownSocratic, peerSocratic]);
    expect(error).toBeNull();
    expect(foreign).toHaveLength(0);

    const { data: updated } = await adminAClient
      .from('socratic_session_state')
      .update({ current_state: { tampered: true } }).eq('id', ownSocratic).select();
    expect(updated).toHaveLength(0);

    const { data: deleted } = await adminAClient
      .from('socratic_session_state').delete().eq('id', ownSocratic).select();
    expect(deleted).toHaveLength(0);
  });
});
