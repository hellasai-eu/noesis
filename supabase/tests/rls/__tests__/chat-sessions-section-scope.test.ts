// Section scoping on the *live* tutoring tables — `chat_sessions` and
// `chat_messages` (20260902100000).
//
// `tutoring-section-scope.test.ts` covers the same rules on
// `student_study_progress` / `study_session_messages`, which the unified schema
// retired: nothing writes them any more and the follow-up migration will drop
// them. So the suite that was supposed to guard the instructor's pause/unpause
// path had stopped watching the path, and this is what it missed:
//
//   The study-tutor surface created every session with `offering_id = NULL`,
//   because its `authorize` returned a course and no offering. Reads did not
//   care — the staff SELECT policies are course-wide — but every write goes
//   through `instructor_can_access_student_work`, whose unattributed arm admits
//   only an instructor holding no `course_instructor_sections` rows. A teacher
//   who takes 1Α but not 1Β could therefore open a pupil's paused tutoring
//   session, press Unpause, be told it worked (RLS refuses by matching no rows,
//   not by erroring) and find it still paused. An institution admin, who
//   bypasses both arms, could unpause it. Same for deleting the transcript and
//   for replying in it.
//
// So the cases below are stated per surface, and the unattributed row is named
// explicitly rather than left implicit: it is the shape the bug lived in, and
// the policies' answer to it — "no section-restricted instructor may write
// here" — is deliberate (#1097) and must keep holding. What changed is that no
// study-tutor session should be in that shape any more.

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
  createStudySession,
  createChatSession,
  createChatMessage,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('tutoring writes on chat_sessions are section-scoped', () => {
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
  let unrestricted: SupabaseClient;
  let institutionAdmin: SupabaseClient;

  let studentAId: string;
  let studentBId: string;

  // Study-tutor sessions, one per section, plus the shape the bug produced.
  let sessionAId: string;
  let sessionBId: string;
  let unattributedSessionId: string;

  let messageAId: string;
  let messageBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Chat ${uid}`);
    courseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    offeringAId = await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    offeringBId = await createOffering(admin, classBId, courseId);

    const a = await createTestUserClient(admin, `rls-chat-a-${uid}@test.local`);
    instrA = a.client;
    instrAId = a.userId;
    userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, a.userId);
    await addSectionRestriction(admin, courseId, classAId, a.userId);

    const u = await createTestUserClient(admin, `rls-chat-u-${uid}@test.local`);
    unrestricted = u.client;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    const ad = await createTestUserClient(admin, `rls-chat-adm-${uid}@test.local`);
    institutionAdmin = ad.client;
    userIds.push(ad.userId);
    await addUserToInstitution(admin, ad.userId, institutionId, 'admin');

    const sa = await createTestUserClient(admin, `rls-chat-stu-a-${uid}@test.local`);
    studentAId = sa.userId;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    const sb = await createTestUserClient(admin, `rls-chat-stu-b-${uid}@test.local`);
    studentBId = sb.userId;
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    const studySessionId = await createStudySession(admin, courseId);
    const otherStudySessionId = await createStudySession(admin, courseId);

    sessionAId = await createChatSession(admin, {
      userId: studentAId,
      courseId,
      offeringId: offeringAId,
      studySessionId,
      status: 'paused',
    });
    sessionBId = await createChatSession(admin, {
      userId: studentBId,
      courseId,
      offeringId: offeringBId,
      studySessionId,
      status: 'paused',
    });
    // Student A's own work, in student A's own section — and unattributed. The
    // only thing separating it from `sessionAId` is the missing offering.
    unattributedSessionId = await createChatSession(admin, {
      userId: studentAId,
      courseId,
      offeringId: null,
      studySessionId: otherStudySessionId,
      status: 'paused',
    });

    messageAId = await createChatMessage(admin, { sessionId: sessionAId });
    messageBId = await createChatMessage(admin, { sessionId: sessionBId });
  });

  afterAll(async () => {
    // CLAUDE.md's "no cleanup" rule is scoped to E2E, where the target is a
    // shared preview branch and the point is to need no privileged credential.
    // The RLS harness is service-role by construction and runs against a local
    // stack that `db reset` recreates — same note, and same reason, as
    // `tutoring-section-scope.test.ts`.
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  async function statusOf(sessionId: string): Promise<string | undefined> {
    const { data } = await admin
      .from('chat_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    return data?.status;
  }

  // ---- unpausing ----------------------------------------------------------

  it('a restricted instructor can unpause their own section\'s tutoring session', async () => {
    const { error } = await instrA
      .from('chat_sessions')
      .update({ status: 'in_progress' })
      .eq('id', sessionAId);
    expect(error).toBeNull();
    expect(await statusOf(sessionAId)).toBe('in_progress');
  });

  it('a restricted instructor cannot unpause another section\'s tutoring session', async () => {
    const { error } = await instrA
      .from('chat_sessions')
      .update({ status: 'in_progress' })
      .eq('id', sessionBId);
    // A refusal is zero rows, not an error — which is why the instructor UI has
    // to read the returned rows rather than only the error.
    expect(error).toBeNull();
    expect(await statusOf(sessionBId)).toBe('paused');
  });

  it('an unpause reports no rows when the policy refuses it', async () => {
    // The fact the UI depends on: `.update(...).select()` comes back empty, so
    // "nothing happened" is distinguishable from "it worked" only by counting.
    const { data, error } = await instrA
      .from('chat_sessions')
      .update({ status: 'in_progress' })
      .eq('id', sessionBId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('a session naming no offering is unwritable by a restricted instructor', async () => {
    // The bug's shape, and the reason the study tutor was broken while the
    // open-question surface was not: an unattributed row has not been shown to
    // belong to section A, so section A's instructor does not get it — even
    // though the pupil is theirs.
    const { error } = await instrA
      .from('chat_sessions')
      .update({ status: 'in_progress' })
      .eq('id', unattributedSessionId);
    expect(error).toBeNull();
    expect(await statusOf(unattributedSessionId)).toBe('paused');
  });

  it('an unrestricted instructor can unpause a session naming no offering', async () => {
    // "No restriction rows means no confinement", which is why the bug looked
    // intermittent: whether an instructor could unpause depended on whether
    // anybody had ever limited them to a section.
    const { error } = await unrestricted
      .from('chat_sessions')
      .update({ status: 'in_progress' })
      .eq('id', unattributedSessionId);
    expect(error).toBeNull();
    expect(await statusOf(unattributedSessionId)).toBe('in_progress');

    await admin
      .from('chat_sessions')
      .update({ status: 'paused' })
      .eq('id', unattributedSessionId);
  });

  it('an institution admin can unpause a session naming no offering', async () => {
    // The asymmetry the bug was reported as: the admin could always do it.
    const { error } = await institutionAdmin
      .from('chat_sessions')
      .update({ status: 'in_progress' })
      .eq('id', unattributedSessionId);
    expect(error).toBeNull();
    expect(await statusOf(unattributedSessionId)).toBe('in_progress');
  });

  // ---- deleting -----------------------------------------------------------

  it('a restricted instructor cannot delete another section\'s transcript', async () => {
    const { error } = await instrA
      .from('chat_messages')
      .delete()
      .eq('id', messageBId);
    expect(error).toBeNull();
    const { data } = await admin.from('chat_messages').select('id').eq('id', messageBId);
    expect(data).toHaveLength(1);
  });

  it('a restricted instructor cannot delete another section\'s session', async () => {
    const { error } = await instrA.from('chat_sessions').delete().eq('id', sessionBId);
    expect(error).toBeNull();
    const { data } = await admin.from('chat_sessions').select('id').eq('id', sessionBId);
    expect(data).toHaveLength(1);
  });

  it('a restricted instructor can delete their own section\'s message', async () => {
    // The control: without it the refusals above could be about the statement
    // rather than about whose work it names.
    const { error } = await instrA
      .from('chat_messages')
      .delete()
      .eq('id', messageAId);
    expect(error).toBeNull();
    const { data } = await admin.from('chat_messages').select('id').eq('id', messageAId);
    expect(data).toHaveLength(0);
  });

  // ---- posting into a pupil's thread --------------------------------------

  it('a restricted instructor cannot post into another section\'s thread', async () => {
    // The student sees an instructor-role message attributed to a named person,
    // so this is impersonation inside a conversation the instructor has no
    // business being in. An INSERT that fails WITH CHECK does raise.
    const { error } = await instrA.from('chat_messages').insert({
      session_id: sessionBId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'A message the 1Β student should never receive from me',
    });
    expect(error).not.toBeNull();
  });

  it('a restricted instructor can post into their own section\'s thread', async () => {
    const { error } = await instrA.from('chat_messages').insert({
      session_id: sessionAId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'Have another look at the second worked example',
    });
    expect(error).toBeNull();
  });

  it('a restricted instructor cannot post into a thread naming no offering', async () => {
    // Their own pupil, and still refused — the same gap as the unpause, on the
    // surface where an instructor answers a paused session.
    const { error } = await instrA.from('chat_messages').insert({
      session_id: unattributedSessionId,
      role: 'instructor',
      sender_user_id: instrAId,
      content: 'Unblocking you now',
    });
    expect(error).not.toBeNull();
  });

  // ---- reads are course-wide ---------------------------------------------

  it('a restricted instructor still reads every section\'s sessions', async () => {
    // Stated so the asymmetry is on the record rather than inferred: reads are
    // institution-wide here (#1101) while writes are section-scoped, which is
    // what made the bug look like a UI failure — the instructor could see the
    // paused session perfectly well.
    const { data, error } = await instrA
      .from('chat_sessions')
      .select('id')
      .in('id', [sessionAId, sessionBId, unattributedSessionId]);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id).sort()).toEqual(
      [sessionAId, sessionBId, unattributedSessionId].sort()
    );
  });
});
