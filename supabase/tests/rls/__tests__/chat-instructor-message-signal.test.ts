// The signal that tells a pupil's open panel a teacher has written
// (`chat_sessions.last_instructor_message_at`, 20260906180000).
//
// Two things are worth pinning, and they pull in opposite directions.
//
// It must fire for every instructor message, whoever wrote it. The trigger is
// SECURITY DEFINER so that raising the signal never depends on the writer also
// holding UPDATE on the pupil's session row — those are two separate policies
// that agree today, and if they ever diverge a non-definer trigger stops
// signalling *silently*, because RLS refuses an UPDATE by matching zero rows
// rather than by raising. The teacher would be told their message was sent and
// the pupil's screen would never change: the bug this column exists to fix,
// restored in a form nothing reports.
//
// And it must not become a way in. A definer function that writes a row the
// caller cannot write is exactly the shape a privilege escalation takes, so the
// refusal case below is here to show the gate is the message table's own INSERT
// policy and the trigger never runs behind it.
//
// The cheap case — a pupil's own turn raising nothing — is load-bearing too.
// `chat_messages` left the Realtime publication in 20260903140000 because
// publishing a table written twice per tutoring turn is fan-out nobody reads;
// routing the signal through the already-published session row only avoids that
// cost if the trigger stays off the ordinary turns.

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

describe('an instructor message signals the session it was written into', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;

  let instructor: SupabaseClient;
  let instructorId: string;
  /** Restricted to section A, so section B's thread is closed to them. */
  let restricted: SupabaseClient;
  let restrictedId: string;

  let studentA: SupabaseClient;
  let sessionAId: string;
  let otherSessionAId: string;
  let sessionBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Signal ${uid}`);
    courseId = await createCourse(admin, institutionId);

    const classAId = await createClass(admin, institutionId);
    const offeringAId = await createOffering(admin, classAId, courseId);
    const classBId = await createClass(admin, institutionId);
    const offeringBId = await createOffering(admin, classBId, courseId);

    const i = await createTestUserClient(admin, `rls-signal-instr-${uid}@test.local`);
    instructor = i.client;
    instructorId = i.userId;
    userIds.push(i.userId);
    await addUserToInstitution(admin, i.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, i.userId);

    const r = await createTestUserClient(admin, `rls-signal-restr-${uid}@test.local`);
    restricted = r.client;
    restrictedId = r.userId;
    userIds.push(r.userId);
    await addUserToInstitution(admin, r.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, r.userId);
    await addSectionRestriction(admin, courseId, classAId, r.userId);

    const sa = await createTestUserClient(admin, `rls-signal-stu-a-${uid}@test.local`);
    studentA = sa.client;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    const sb = await createTestUserClient(admin, `rls-signal-stu-b-${uid}@test.local`);
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    sessionAId = await createChatSession(admin, {
      userId: sa.userId,
      courseId,
      offeringId: offeringAId,
      studySessionId: await createStudySession(admin, courseId),
    });
    otherSessionAId = await createChatSession(admin, {
      userId: sa.userId,
      courseId,
      offeringId: offeringAId,
      studySessionId: await createStudySession(admin, courseId),
    });
    sessionBId = await createChatSession(admin, {
      userId: sb.userId,
      courseId,
      offeringId: offeringBId,
      studySessionId: await createStudySession(admin, courseId),
    });
  });

  afterAll(async () => {
    // Same note as `chat-sessions-section-scope.test.ts`: CLAUDE.md's
    // "no cleanup" rule is scoped to E2E, where the point is to need no
    // privileged credential. This harness is service-role by construction and
    // runs against a local stack `db reset` recreates.
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  async function signalOf(id: string): Promise<string | null | undefined> {
    const { data } = await admin
      .from('chat_sessions')
      .select('last_instructor_message_at')
      .eq('id', id)
      .single();
    return (data as { last_instructor_message_at?: string | null } | null)
      ?.last_instructor_message_at;
  }

  it('starts unset', async () => {
    expect(await signalOf(sessionAId)).toBeNull();
  });

  it("is not raised by the pupil's own turn", async () => {
    await createChatMessage(admin, { sessionId: sessionAId, role: 'user', content: 'ναι' });
    await createChatMessage(admin, { sessionId: sessionAId, role: 'assistant', content: 'Ωραία.' });
    expect(await signalOf(sessionAId)).toBeNull();
  });

  it('is raised when an instructor writes, under the instructor\'s own credential', async () => {
    const { data, error } = await instructor
      .from('chat_messages')
      .insert({
        session_id: sessionAId,
        role: 'instructor',
        sender_user_id: instructorId,
        content: 'Have another look at the second worked example',
      })
      .select('created_at')
      .single();
    expect(error).toBeNull();

    // The message's own timestamp, not `now()`. The panel compares the value it
    // last acted on against the one the row carries, so a signal that did not
    // match the message it announced would re-fire on unrelated updates.
    expect(await signalOf(sessionAId)).toBe(data!.created_at);
  });

  it('touches only the session the message named', async () => {
    expect(await signalOf(otherSessionAId)).toBeNull();
  });

  it('is not raised by an insert the message policy refuses', async () => {
    // The definer trigger must not be reachable except behind that policy —
    // otherwise it is a way to write a row in a section you have no business in.
    const { error } = await restricted.from('chat_messages').insert({
      session_id: sessionBId,
      role: 'instructor',
      sender_user_id: restrictedId,
      content: 'A message the 1Β student should never receive from me',
    });
    expect(error).not.toBeNull();
    expect(await signalOf(sessionBId)).toBeNull();
  });

  it('advances when a second message is written', async () => {
    const first = await signalOf(sessionAId);
    const { data } = await instructor
      .from('chat_messages')
      .insert({
        session_id: sessionAId,
        role: 'instructor',
        sender_user_id: instructorId,
        content: 'And one more thing',
      })
      .select('created_at')
      .single();

    const second = await signalOf(sessionAId);
    expect(second).toBe(data!.created_at);
    expect(second).not.toBe(first);
  });

  it('leaves the pupil able to read the messages it announced', async () => {
    // The signal is only a nudge: the panel re-reads the transcript and renders
    // what it finds there. If the pupil could not read the rows, the nudge would
    // deliver an empty merge and the message would still never appear.
    const { data, error } = await studentA
      .from('chat_messages')
      .select('id, role, sender_user_id')
      .eq('session_id', sessionAId)
      .eq('role', 'instructor');
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
    expect(data?.every((m) => m.sender_user_id === instructorId)).toBe(true);
  });
});
