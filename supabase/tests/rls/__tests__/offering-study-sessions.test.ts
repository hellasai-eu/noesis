// Tables under test: public.offering_study_sessions
//
// Migrations that introduced / shaped the policies covered here:
//   * 20251229092037_a5c710cd-a65c-4dbf-92a0-ff2627558f5a.sql
//       - CREATE TABLE offering_study_sessions, base RLS policies
//         "Managers can manage offering study sessions",
//         "Students see published study sessions"
//   * 20260603100000_add_offering_groups.sql
//       - Adds nullable group_id column
//       - Rewrites "Students see published study sessions" with the group predicate
//   * 20260604010000_individual_offering_groups.sql
//       - Singleton (is_individual = true) groups used for per-student targeting
//   * (Relevant to issue #530, which builds per-student study-session targeting on
//     top of this policy.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createStudySession,
  createOfferingGroup,
  addOfferingGroupMember,
  createOfferingStudySession,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('offering_study_sessions RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;

  let wholeClassPubRowId: string;
  let groupTargetedPubRowId: string;
  let individualTargetedPubRowId: string;
  let unpublishedRowId: string;

  let groupId: string;

  let instructorClient: SupabaseClient;
  let groupMemberClient: SupabaseClient;
  let groupMemberId: string;
  let nonMemberClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS OffSS ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    const ssA = await createStudySession(admin, courseId);
    const ssB = await createStudySession(admin, courseId);
    const ssC = await createStudySession(admin, courseId);
    const ssD = await createStudySession(admin, courseId);

    const inst = await createTestUserClient(admin, `rls-offss-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const m = await createTestUserClient(admin, `rls-offss-mem-${uid}@test.local`);
    groupMemberClient = m.client; groupMemberId = m.userId; userIds.push(m.userId);
    await addUserToInstitution(admin, m.userId, institutionId, 'student');
    await enrollInClass(admin, classId, m.userId, 'student');

    const nm = await createTestUserClient(admin, `rls-offss-nonmem-${uid}@test.local`);
    nonMemberClient = nm.client; userIds.push(nm.userId);
    await addUserToInstitution(admin, nm.userId, institutionId, 'student');
    await enrollInClass(admin, classId, nm.userId, 'student');

    groupId = await createOfferingGroup(admin, offeringId, { name: `OffSS ${uid}` });
    await addOfferingGroupMember(admin, groupId, groupMemberId);

    const individualGroupId = await createOfferingGroup(admin, offeringId, {
      name: `Individual ${groupMemberId}`,
      isIndividual: true,
      ownerUserId: groupMemberId,
    });
    await addOfferingGroupMember(admin, individualGroupId, groupMemberId);

    wholeClassPubRowId = await createOfferingStudySession(admin, offeringId, ssA, {
      groupId: null,
      published: true,
    });
    groupTargetedPubRowId = await createOfferingStudySession(admin, offeringId, ssB, {
      groupId,
      published: true,
    });
    individualTargetedPubRowId = await createOfferingStudySession(admin, offeringId, ssC, {
      groupId: individualGroupId,
      published: true,
    });
    unpublishedRowId = await createOfferingStudySession(admin, offeringId, ssD, {
      groupId: null,
      published: false,
    });
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  it('every enrolled student sees a whole-class published study session', async () => {
    const { data: gm } = await groupMemberClient
      .from('offering_study_sessions').select('id').eq('id', wholeClassPubRowId);
    expect(gm).toHaveLength(1);
    const { data: nm } = await nonMemberClient
      .from('offering_study_sessions').select('id').eq('id', wholeClassPubRowId);
    expect(nm).toHaveLength(1);
  });

  it('group member sees a group-targeted published study session', async () => {
    const { data, error } = await groupMemberClient
      .from('offering_study_sessions').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-member enrolled student does not see a group-targeted published study session', async () => {
    const { data, error } = await nonMemberClient
      .from('offering_study_sessions').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('individually targeted study session visible to the singleton-group owner only', async () => {
    const { data: ownerSees } = await groupMemberClient
      .from('offering_study_sessions').select('id').eq('id', individualTargetedPubRowId);
    expect(ownerSees).toHaveLength(1);
    const { data: peerSees } = await nonMemberClient
      .from('offering_study_sessions').select('id').eq('id', individualTargetedPubRowId);
    expect(peerSees).toHaveLength(0);
  });

  it('unpublished row is invisible to students', async () => {
    const { data: gm } = await groupMemberClient
      .from('offering_study_sessions').select('id').eq('id', unpublishedRowId);
    expect(gm).toHaveLength(0);
  });

  it('assigned instructor can publish a study session whole-class', async () => {
    const ss = await createStudySession(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_study_sessions')
      .insert({
        offering_id: offeringId,
        study_session_id: ss,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('assigned instructor can publish a study session to a group', async () => {
    const ss = await createStudySession(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_study_sessions')
      .insert({
        offering_id: offeringId,
        study_session_id: ss,
        group_id: groupId,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot insert an offering_study_sessions row', async () => {
    const ss = await createStudySession(admin, courseId);
    const { error } = await groupMemberClient
      .from('offering_study_sessions')
      .insert({
        offering_id: offeringId,
        study_session_id: ss,
        published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  it('student cannot delete an offering_study_sessions row', async () => {
    const { data } = await groupMemberClient
      .from('offering_study_sessions').delete().eq('id', wholeClassPubRowId).select();
    expect(data).toHaveLength(0);
  });
});
