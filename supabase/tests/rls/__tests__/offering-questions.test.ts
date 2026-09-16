// Tables under test: public.offering_questions
//
// Migrations that introduced / shaped the policies covered here:
//   * 20251230131704_893258e7-3bcf-457f-bab3-2e74945077aa.sql
//       - CREATE TABLE offering_questions, base RLS policies
//         "Managers can manage offering questions", "Students see published questions"
//   * 20260603100000_add_offering_groups.sql
//       - Adds nullable group_id column
//       - Rewrites "Students see published questions" with the group predicate
//         (group_id IS NULL OR is_offering_group_member(group_id))
//   * 20260604010000_individual_offering_groups.sql
//       - Singleton (is_individual = true) groups used for per-student targeting

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuestion,
  createOfferingGroup,
  addOfferingGroupMember,
  createOfferingQuestion,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('offering_questions RLS', () => {
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

  let questionA: string; // whole-class
  let questionB: string; // group-targeted
  let questionC: string; // individually targeted
  let questionD: string; // unpublished

  let groupId: string;

  let instructorClient: SupabaseClient;
  let groupMemberClient: SupabaseClient;
  let groupMemberId: string;
  let nonMemberClient: SupabaseClient;
  let nonMemberId: string;
  let studentClient: SupabaseClient; // generic enrolled student

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS OffQ ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    questionA = await createQuestion(admin, courseId);
    questionB = await createQuestion(admin, courseId);
    questionC = await createQuestion(admin, courseId);
    questionD = await createQuestion(admin, courseId);

    const inst = await createTestUserClient(admin, `rls-offq-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const m = await createTestUserClient(admin, `rls-offq-mem-${uid}@test.local`);
    groupMemberClient = m.client; groupMemberId = m.userId; userIds.push(m.userId);
    await addUserToInstitution(admin, m.userId, institutionId, 'student');
    await enrollInClass(admin, classId, m.userId, 'student');

    const nm = await createTestUserClient(admin, `rls-offq-nonmem-${uid}@test.local`);
    nonMemberClient = nm.client; nonMemberId = nm.userId; userIds.push(nm.userId);
    await addUserToInstitution(admin, nm.userId, institutionId, 'student');
    await enrollInClass(admin, classId, nm.userId, 'student');

    const stu = await createTestUserClient(admin, `rls-offq-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    groupId = await createOfferingGroup(admin, offeringId, { name: `OffQ ${uid}` });
    await addOfferingGroupMember(admin, groupId, groupMemberId);

    const individualGroupId = await createOfferingGroup(admin, offeringId, {
      name: `Individual ${groupMemberId}`,
      isIndividual: true,
      ownerUserId: groupMemberId,
    });
    await addOfferingGroupMember(admin, individualGroupId, groupMemberId);

    wholeClassPubRowId = await createOfferingQuestion(admin, offeringId, questionA, {
      groupId: null,
      published: true,
    });
    groupTargetedPubRowId = await createOfferingQuestion(admin, offeringId, questionB, {
      groupId,
      published: true,
    });
    individualTargetedPubRowId = await createOfferingQuestion(admin, offeringId, questionC, {
      groupId: individualGroupId,
      published: true,
    });
    unpublishedRowId = await createOfferingQuestion(admin, offeringId, questionD, {
      groupId: null,
      published: false,
    });
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // SELECT — whole-class published row
  it('every enrolled student sees a whole-class published row', async () => {
    const { data: gm } = await groupMemberClient
      .from('offering_questions').select('id').eq('id', wholeClassPubRowId);
    expect(gm).toHaveLength(1);
    const { data: nm } = await nonMemberClient
      .from('offering_questions').select('id').eq('id', wholeClassPubRowId);
    expect(nm).toHaveLength(1);
    const { data: st } = await studentClient
      .from('offering_questions').select('id').eq('id', wholeClassPubRowId);
    expect(st).toHaveLength(1);
  });

  // SELECT — group-targeted published row
  it('group member sees a group-targeted published row', async () => {
    const { data, error } = await groupMemberClient
      .from('offering_questions').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-member enrolled student does not see a group-targeted published row', async () => {
    const { data, error } = await nonMemberClient
      .from('offering_questions').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // SELECT — singleton group-targeted row (per-student)
  it('individually targeted row visible to the singleton-group owner only', async () => {
    const { data: ownerSees } = await groupMemberClient
      .from('offering_questions').select('id').eq('id', individualTargetedPubRowId);
    expect(ownerSees).toHaveLength(1);

    const { data: peerSees } = await nonMemberClient
      .from('offering_questions').select('id').eq('id', individualTargetedPubRowId);
    expect(peerSees).toHaveLength(0);

    expect(nonMemberId).toBeTruthy(); // keep var live for the assertion above
  });

  // SELECT — unpublished
  it('unpublished row is invisible to students', async () => {
    const { data: gm } = await groupMemberClient
      .from('offering_questions').select('id').eq('id', unpublishedRowId);
    expect(gm).toHaveLength(0);
    const { data: st } = await studentClient
      .from('offering_questions').select('id').eq('id', unpublishedRowId);
    expect(st).toHaveLength(0);
  });

  // INSERT
  it('assigned instructor can publish a question whole-class', async () => {
    const q = await createQuestion(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_questions')
      .insert({
        offering_id: offeringId,
        question_id: q,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('assigned instructor can publish a question to a group', async () => {
    const q = await createQuestion(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_questions')
      .insert({
        offering_id: offeringId,
        question_id: q,
        group_id: groupId,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot insert an offering_questions row', async () => {
    const q = await createQuestion(admin, courseId);
    const { error } = await groupMemberClient
      .from('offering_questions')
      .insert({
        offering_id: offeringId,
        question_id: q,
        published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  it('student cannot delete an offering_questions row', async () => {
    const { data } = await groupMemberClient
      .from('offering_questions').delete().eq('id', wholeClassPubRowId).select();
    expect(data).toHaveLength(0);
  });
});
