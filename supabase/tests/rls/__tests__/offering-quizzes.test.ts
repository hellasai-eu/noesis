// Tables under test: public.offering_quizzes
//
// Migrations that introduced / shaped the policies covered here:
//   * 20251229065522_53a2d1cf-de22-4ff1-ae14-3f63352d8fc1.sql
//       - CREATE TABLE offering_quizzes, base RLS policies
//         "Managers can manage offering quizzes" (FOR ALL, can_manage_offering)
//         "Students see published quizzes"       (FOR SELECT, has_offering_access)
//   * 20260603100000_add_offering_groups.sql
//       - Adds nullable group_id column
//       - Rewrites "Students see published quizzes" with the group predicate
//         (group_id IS NULL OR is_offering_group_member(group_id))
//   * 20260604010000_individual_offering_groups.sql
//       - Singleton (is_individual = true) groups used for per-student targeting
//   * 20260907120000_answers_released_requires_closure.sql
//       - CHECK (NOT answers_released OR closed_at IS NOT NULL) plus a
//         reopen_offering_quiz that retracts the release in the same statement
//
// Coverage: whole-class vs group-scoped vs individually-targeted visibility,
// unpublished invisibility, manager write access, student write denial,
// cross-institution isolation, and the answers_released-requires-closure
// invariant.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuiz,
  createOfferingGroup,
  addOfferingGroupMember,
  createOfferingQuiz,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('offering_quizzes RLS', () => {
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

  let quizA: string; // whole-class
  let quizB: string; // group-targeted
  let quizC: string; // individually targeted
  let quizD: string; // unpublished

  let groupId: string;

  let instructorClient: SupabaseClient;
  let groupMemberClient: SupabaseClient;
  let groupMemberId: string;
  let nonMemberClient: SupabaseClient;
  let studentClient: SupabaseClient; // generic enrolled student

  // Second institution — cross-tenant isolation.
  let otherInstitutionId: string;
  let otherCourseId: string;
  let otherAdminClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS OffQuiz ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    quizA = await createQuiz(admin, courseId);
    quizB = await createQuiz(admin, courseId);
    quizC = await createQuiz(admin, courseId);
    quizD = await createQuiz(admin, courseId);

    const inst = await createTestUserClient(admin, `rls-offquiz-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const m = await createTestUserClient(admin, `rls-offquiz-mem-${uid}@test.local`);
    groupMemberClient = m.client; groupMemberId = m.userId; userIds.push(m.userId);
    await addUserToInstitution(admin, m.userId, institutionId, 'student');
    await enrollInClass(admin, classId, m.userId, 'student');

    const nm = await createTestUserClient(admin, `rls-offquiz-nonmem-${uid}@test.local`);
    nonMemberClient = nm.client; userIds.push(nm.userId);
    await addUserToInstitution(admin, nm.userId, institutionId, 'student');
    await enrollInClass(admin, classId, nm.userId, 'student');

    const stu = await createTestUserClient(admin, `rls-offquiz-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    groupId = await createOfferingGroup(admin, offeringId, { name: `OffQuiz ${uid}` });
    await addOfferingGroupMember(admin, groupId, groupMemberId);

    const individualGroupId = await createOfferingGroup(admin, offeringId, {
      name: `Individual ${groupMemberId}`,
      isIndividual: true,
      ownerUserId: groupMemberId,
    });
    await addOfferingGroupMember(admin, individualGroupId, groupMemberId);

    wholeClassPubRowId = await createOfferingQuiz(admin, offeringId, quizA, {
      groupId: null,
      published: true,
    });
    groupTargetedPubRowId = await createOfferingQuiz(admin, offeringId, quizB, {
      groupId,
      published: true,
    });
    individualTargetedPubRowId = await createOfferingQuiz(admin, offeringId, quizC, {
      groupId: individualGroupId,
      published: true,
    });
    unpublishedRowId = await createOfferingQuiz(admin, offeringId, quizD, {
      groupId: null,
      published: false,
    });

    // Second institution scaffold for cross-tenant isolation checks.
    otherInstitutionId = await createInstitution(admin, `RLS OffQuiz Other ${uid}`);
    otherCourseId = await createCourse(admin, otherInstitutionId);
    const otherAdmin = await createTestUserClient(admin, `rls-offquiz-otheradm-${uid}@test.local`);
    otherAdminClient = otherAdmin.client;
    userIds.push(otherAdmin.userId);
    await addUserToInstitution(admin, otherAdmin.userId, otherInstitutionId, 'admin');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    // cleanupScaffold takes a single institution id; the other-admin's
    // user_institutions rows are scoped to otherInstitutionId, so remove them
    // and the institution explicitly.
    await admin
      .from('user_institutions')
      .delete()
      .eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  // SELECT — whole-class published row
  it('every enrolled student sees a whole-class published row', async () => {
    const { data: gm } = await groupMemberClient
      .from('offering_quizzes').select('id').eq('id', wholeClassPubRowId);
    expect(gm).toHaveLength(1);
    const { data: nm } = await nonMemberClient
      .from('offering_quizzes').select('id').eq('id', wholeClassPubRowId);
    expect(nm).toHaveLength(1);
    const { data: st } = await studentClient
      .from('offering_quizzes').select('id').eq('id', wholeClassPubRowId);
    expect(st).toHaveLength(1);
  });

  // SELECT — group-targeted published row
  it('group member sees a group-targeted published row', async () => {
    const { data, error } = await groupMemberClient
      .from('offering_quizzes').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-member enrolled student does not see a group-targeted published row', async () => {
    const { data, error } = await nonMemberClient
      .from('offering_quizzes').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // SELECT — singleton group-targeted row (per-student)
  it('individually targeted row visible to the singleton-group owner only', async () => {
    const { data: ownerSees } = await groupMemberClient
      .from('offering_quizzes').select('id').eq('id', individualTargetedPubRowId);
    expect(ownerSees).toHaveLength(1);

    const { data: peerSees } = await nonMemberClient
      .from('offering_quizzes').select('id').eq('id', individualTargetedPubRowId);
    expect(peerSees).toHaveLength(0);
  });

  // SELECT — unpublished
  it('unpublished row is invisible to students', async () => {
    const { data: gm } = await groupMemberClient
      .from('offering_quizzes').select('id').eq('id', unpublishedRowId);
    expect(gm).toHaveLength(0);
    const { data: st } = await studentClient
      .from('offering_quizzes').select('id').eq('id', unpublishedRowId);
    expect(st).toHaveLength(0);
  });

  // INSERT / UPDATE — manager
  it('assigned instructor can assign a quiz whole-class', async () => {
    const q = await createQuiz(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_quizzes')
      .insert({
        offering_id: offeringId,
        quiz_id: q,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('assigned instructor can assign a quiz to a group', async () => {
    const q = await createQuiz(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_quizzes')
      .insert({
        offering_id: offeringId,
        quiz_id: q,
        group_id: groupId,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('assigned instructor can update an offering_quizzes row', async () => {
    const { data, error } = await instructorClient
      .from('offering_quizzes')
      .update({ due_date: new Date().toISOString() })
      .eq('id', wholeClassPubRowId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('student cannot insert an offering_quizzes row', async () => {
    const q = await createQuiz(admin, courseId);
    const { error } = await groupMemberClient
      .from('offering_quizzes')
      .insert({
        offering_id: offeringId,
        quiz_id: q,
        published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  it('student cannot update an offering_quizzes row', async () => {
    const { data } = await groupMemberClient
      .from('offering_quizzes')
      .update({ due_date: new Date().toISOString() })
      .eq('id', wholeClassPubRowId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('student cannot delete an offering_quizzes row', async () => {
    const { data } = await groupMemberClient
      .from('offering_quizzes').delete().eq('id', wholeClassPubRowId).select();
    expect(data).toHaveLength(0);
  });

  // Cross-institution isolation
  it('admin of another institution cannot see this offering\'s quiz assignment', async () => {
    const { data, error } = await otherAdminClient
      .from('offering_quizzes').select('id').eq('id', wholeClassPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // Answer release is gated on closure (CHECK constraint, migration
  // 20260907120000). The instructor UI disables the switch, but the invariant
  // has to hold for any client that writes the column directly.
  it('instructor cannot release answers while the assignment is open', async () => {
    const q = await createQuiz(admin, courseId);
    const rowId = await createOfferingQuiz(admin, offeringId, q);

    const { error } = await instructorClient
      .from('offering_quizzes')
      .update({ answers_released: true })
      .eq('id', rowId)
      .select();

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23514');
  });

  it('instructor can release answers once the assignment is marked as done, and reopening retracts the release', async () => {
    const q = await createQuiz(admin, courseId);
    const rowId = await createOfferingQuiz(admin, offeringId, q);

    const { error: closeError } = await instructorClient.rpc(
      'mark_offering_quiz_done',
      { p_offering_quiz_id: rowId },
    );
    expect(closeError).toBeNull();

    const { data: released, error: releaseError } = await instructorClient
      .from('offering_quizzes')
      .update({ answers_released: true })
      .eq('id', rowId)
      .select('answers_released');
    expect(releaseError).toBeNull();
    expect(released).toHaveLength(1);
    expect(released![0].answers_released).toBe(true);

    // Reopening must not leave the class holding the answer key while they can
    // start fresh attempts — the RPC clears both columns in one statement.
    const { error: reopenError } = await instructorClient.rpc(
      'reopen_offering_quiz',
      { p_offering_quiz_id: rowId },
    );
    expect(reopenError).toBeNull();

    const { data: after } = await admin
      .from('offering_quizzes')
      .select('closed_at, answers_released')
      .eq('id', rowId)
      .single();
    expect(after!.closed_at).toBeNull();
    expect(after!.answers_released).toBe(false);
  });

  it('admin of another institution cannot insert into this offering', async () => {
    const q = await createQuiz(admin, otherCourseId);
    const { error } = await otherAdminClient
      .from('offering_quizzes')
      .insert({
        offering_id: offeringId,
        quiz_id: q,
        published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });
});
