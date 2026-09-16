// Tables under test: public.offering_group_members
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260603100000_add_offering_groups.sql
//       - CREATE TABLE offering_group_members, RLS policies
//         "Managers can manage offering group members",
//         "Students see their own group memberships"
//       - enforce_offering_group_member_enrollment trigger (BEFORE INSERT/UPDATE)
//   * 20260604010000_individual_offering_groups.sql
//       - Adds is_individual + owner_user_id for singleton "per-student" groups

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createOfferingGroup,
  addOfferingGroupMember,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('offering_group_members RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;
  let groupId: string;
  let individualGroupId: string;

  let otherCourseId: string;
  let otherClassId: string;
  let otherOfferingId: string;
  let otherGroupId: string;

  let instructorClient: SupabaseClient;
  let otherInstructorClient: SupabaseClient;
  let memberClient: SupabaseClient;
  let memberId: string;
  let peerStudentClient: SupabaseClient;
  let peerStudentId: string;
  let unenrolledStudentId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS GroupMembers ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    otherCourseId = await createCourse(admin, institutionId);
    otherClassId = await createClass(admin, institutionId);
    otherOfferingId = await createOffering(admin, otherClassId, otherCourseId);

    const inst = await createTestUserClient(admin, `rls-ogm-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const otherInst = await createTestUserClient(admin, `rls-ogm-inst2-${uid}@test.local`);
    otherInstructorClient = otherInst.client; userIds.push(otherInst.userId);
    await addUserToInstitution(admin, otherInst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, otherInst.userId);

    const member = await createTestUserClient(admin, `rls-ogm-mem-${uid}@test.local`);
    memberClient = member.client; memberId = member.userId; userIds.push(member.userId);
    await addUserToInstitution(admin, member.userId, institutionId, 'student');
    await enrollInClass(admin, classId, member.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-ogm-peer-${uid}@test.local`);
    peerStudentClient = peer.client; peerStudentId = peer.userId; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, institutionId, 'student');
    await enrollInClass(admin, classId, peer.userId, 'student');

    const unenrolled = await createTestUserClient(admin, `rls-ogm-unenr-${uid}@test.local`);
    unenrolledStudentId = unenrolled.userId; userIds.push(unenrolled.userId);
    await addUserToInstitution(admin, unenrolled.userId, institutionId, 'student');
    // intentionally NOT enrolled in classId

    groupId = await createOfferingGroup(admin, offeringId, { name: `Manual ${uid}` });
    await addOfferingGroupMember(admin, groupId, memberId);
    await addOfferingGroupMember(admin, groupId, peerStudentId);

    individualGroupId = await createOfferingGroup(admin, offeringId, {
      name: `Individual ${memberId}`,
      isIndividual: true,
      ownerUserId: memberId,
    });
    await addOfferingGroupMember(admin, individualGroupId, memberId);

    otherGroupId = await createOfferingGroup(admin, otherOfferingId, { name: `Other ${uid}` });
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // SELECT
  it('student can see their own membership row', async () => {
    const { data, error } = await memberClient
      .from('offering_group_members')
      .select('group_id, user_id')
      .eq('group_id', groupId)
      .eq('user_id', memberId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot see another student\'s membership row in the same group', async () => {
    const { data, error } = await memberClient
      .from('offering_group_members')
      .select('user_id')
      .eq('group_id', groupId)
      .eq('user_id', peerStudentId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('singleton (is_individual) group membership is visible only to its owner', async () => {
    const { data: ownerSees } = await memberClient
      .from('offering_group_members')
      .select('user_id')
      .eq('group_id', individualGroupId);
    expect(ownerSees).toHaveLength(1);

    const { data: peerSees } = await peerStudentClient
      .from('offering_group_members')
      .select('user_id')
      .eq('group_id', individualGroupId);
    expect(peerSees).toHaveLength(0);
  });

  // INSERT
  it('assigned instructor can add a student to a group on their offering', async () => {
    const tmpGroupId = await createOfferingGroup(admin, offeringId, { name: `Tmp ${uid}` });
    const { error } = await instructorClient
      .from('offering_group_members')
      .insert({ group_id: tmpGroupId, user_id: peerStudentId });
    expect(error).toBeNull();
  });

  it('instructor of another offering cannot add a member to this offering\'s group', async () => {
    const { error } = await otherInstructorClient
      .from('offering_group_members')
      .insert({ group_id: groupId, user_id: peerStudentId });
    expect(error).not.toBeNull();
  });

  it('student cannot add themselves to a group', async () => {
    const tmpGroupId = await createOfferingGroup(admin, offeringId, { name: `Tmp2 ${uid}` });
    const { error } = await memberClient
      .from('offering_group_members')
      .insert({ group_id: tmpGroupId, user_id: memberId });
    expect(error).not.toBeNull();
  });

  it('membership-integrity trigger blocks adding a non-enrolled student', async () => {
    const { error } = await admin
      .from('offering_group_members')
      .insert({ group_id: groupId, user_id: unenrolledStudentId });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/not a student enrolled/i);
  });

  // DELETE
  it('assigned instructor can remove a member from their offering\'s group', async () => {
    const tmpGroupId = await createOfferingGroup(admin, offeringId, { name: `Tmp3 ${uid}` });
    await addOfferingGroupMember(admin, tmpGroupId, memberId);
    const { data, error } = await instructorClient
      .from('offering_group_members')
      .delete()
      .eq('group_id', tmpGroupId)
      .eq('user_id', memberId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('instructor of another offering cannot delete members from this offering\'s group', async () => {
    const { data } = await otherInstructorClient
      .from('offering_group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', memberId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('student cannot delete their own membership', async () => {
    const { data } = await memberClient
      .from('offering_group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', memberId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('foreign instructor sees no manual-group members under their own offering', async () => {
    const { data } = await otherInstructorClient
      .from('offering_group_members')
      .select('group_id, user_id')
      .eq('group_id', otherGroupId);
    expect(data).toEqual([]);
  });
});
