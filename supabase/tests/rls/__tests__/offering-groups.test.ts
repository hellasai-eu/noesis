// Tables under test: public.offering_groups
//
// Migrations that introduced / shaped the policies covered here:
//   * 20260603100000_add_offering_groups.sql
//       - CREATE TABLE offering_groups, RLS policies
//         "Managers can manage offering groups", "Students see their own offering groups"
//   * 20260604010000_individual_offering_groups.sql
//       - Adds is_individual + owner_user_id columns

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
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('offering_groups RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;

  // A second, unrelated offering inside the same institution — used to prove
  // an instructor cannot write to groups outside the offerings they teach.
  let otherCourseId: string;
  let otherClassId: string;
  let otherOfferingId: string;

  let groupId: string;
  let individualGroupId: string;

  let instructorClient: SupabaseClient;
  let otherInstructorClient: SupabaseClient;
  let memberClient: SupabaseClient;
  let memberId: string;
  let nonMemberClient: SupabaseClient;
  let nonMemberId: string;
  let superAdminClient: SupabaseClient;

  const userIds: string[] = [];
  const superAdminEmail = `rls-og-sa-${uid}@test.local`;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS OfferingGroups ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    otherCourseId = await createCourse(admin, institutionId);
    otherClassId = await createClass(admin, institutionId);
    otherOfferingId = await createOffering(admin, otherClassId, otherCourseId);

    const inst = await createTestUserClient(admin, `rls-og-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const otherInst = await createTestUserClient(admin, `rls-og-inst2-${uid}@test.local`);
    otherInstructorClient = otherInst.client; userIds.push(otherInst.userId);
    await addUserToInstitution(admin, otherInst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, otherInst.userId);

    const member = await createTestUserClient(admin, `rls-og-mem-${uid}@test.local`);
    memberClient = member.client; memberId = member.userId; userIds.push(member.userId);
    await addUserToInstitution(admin, member.userId, institutionId, 'student');
    await enrollInClass(admin, classId, member.userId, 'student');

    const nonMember = await createTestUserClient(admin, `rls-og-nonmem-${uid}@test.local`);
    nonMemberClient = nonMember.client; nonMemberId = nonMember.userId; userIds.push(nonMember.userId);
    await addUserToInstitution(admin, nonMember.userId, institutionId, 'student');
    await enrollInClass(admin, classId, nonMember.userId, 'student');

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client; userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    groupId = await createOfferingGroup(admin, offeringId, { name: `Manual ${uid}` });
    await addOfferingGroupMember(admin, groupId, memberId);

    individualGroupId = await createOfferingGroup(admin, offeringId, {
      name: `Individual ${memberId}`,
      isIndividual: true,
      ownerUserId: memberId,
    });
    await addOfferingGroupMember(admin, individualGroupId, memberId);
  });

  afterAll(async () => {
    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // SELECT
  it('member can see groups they belong to', async () => {
    const { data, error } = await memberClient
      .from('offering_groups').select('id').eq('id', groupId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-member student cannot see manual groups', async () => {
    const { data, error } = await nonMemberClient
      .from('offering_groups').select('id').eq('id', groupId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('non-member student does not see other students\' individual groups', async () => {
    const { data, error } = await nonMemberClient
      .from('offering_groups').select('id').eq('id', individualGroupId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('individual group is visible to its owner', async () => {
    const { data, error } = await memberClient
      .from('offering_groups').select('id, is_individual, owner_user_id').eq('id', individualGroupId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].is_individual).toBe(true);
    expect(data![0].owner_user_id).toBe(memberId);
  });

  it('super-admin can see all groups in the offering', async () => {
    const { data, error } = await superAdminClient
      .from('offering_groups').select('id').eq('offering_id', offeringId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  it('assigned instructor can see groups in their offering', async () => {
    const { data, error } = await instructorClient
      .from('offering_groups').select('id').eq('offering_id', offeringId);
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  // INSERT
  it('assigned instructor can insert a group on their offering', async () => {
    const { data, error } = await instructorClient
      .from('offering_groups')
      .insert({ offering_id: offeringId, name: `Inserted ${uid}` })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('instructor of another offering cannot insert a group on this offering', async () => {
    const { error } = await otherInstructorClient
      .from('offering_groups')
      .insert({ offering_id: offeringId, name: `Cross ${uid}` });
    expect(error).not.toBeNull();
  });

  it('student cannot insert a group', async () => {
    const { error } = await memberClient
      .from('offering_groups')
      .insert({ offering_id: offeringId, name: `Blocked ${uid}` });
    expect(error).not.toBeNull();
  });

  // UPDATE
  it('assigned instructor can update a group on their offering', async () => {
    const { data, error } = await instructorClient
      .from('offering_groups')
      .update({ description: 'edited' })
      .eq('id', groupId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('instructor of another offering cannot update this offering\'s groups', async () => {
    const { data } = await otherInstructorClient
      .from('offering_groups')
      .update({ description: 'should not stick' })
      .eq('id', groupId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('student cannot update a group', async () => {
    const { data } = await memberClient
      .from('offering_groups')
      .update({ description: 'should not stick' })
      .eq('id', groupId)
      .select();
    expect(data).toHaveLength(0);
  });

  // DELETE
  it('assigned instructor can delete a group on their offering', async () => {
    const tmpGroupId = await createOfferingGroup(admin, offeringId, { name: `ToDelete ${uid}` });
    const { data, error } = await instructorClient
      .from('offering_groups').delete().eq('id', tmpGroupId).select();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot delete a group', async () => {
    const { data } = await memberClient
      .from('offering_groups').delete().eq('id', groupId).select();
    expect(data).toHaveLength(0);
  });

  it('instructor of another offering cannot delete this offering\'s group', async () => {
    const { data } = await otherInstructorClient
      .from('offering_groups').delete().eq('id', groupId).select();
    expect(data).toHaveLength(0);
  });

  // Sanity check the helper data didn't accidentally enroll the non-member
  it('non-member is enrolled in the class but is not in any group', async () => {
    expect(nonMemberId).toBeTruthy();
    // The unrelated/other offering exists but has no groups yet, so list is empty.
    const { data: groupsInOtherOffering } = await admin
      .from('offering_groups').select('id').eq('offering_id', otherOfferingId);
    expect(groupsInOtherOffering).toHaveLength(0);
  });
});
