import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createCourseMaterial,
  createMaterialChapter,
  createQuestion,
  addUserToInstitution,
  assignCourseEvaluator,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

// Issue #664: an evaluator gets read-only SELECT on the question surface for
// the courses they're explicitly assigned to via `course_evaluators` — and
// nothing else.
describe('course evaluators RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let assignedCourseId: string;
  let unassignedCourseId: string;
  let assignedQuestionId: string;
  let unassignedQuestionId: string;
  let assignedMaterialId: string;
  let unassignedMaterialId: string;
  let assignedChapterId: string;
  let unassignedChapterId: string;
  let assignedCompetencyId: string;
  let unassignedCompetencyId: string;

  // Cross-institution setup: a course in a second institution + an admin of
  // that other institution, used to prove the assignment table is itself
  // institutionally isolated.
  let otherInstitutionId: string;
  let otherCourseId: string;
  let otherAdminClient: SupabaseClient;

  let evaluatorClient: SupabaseClient;
  let evaluatorId: string;
  let unrelatedClient: SupabaseClient;
  let instAdminClient: SupabaseClient;
  let instAdminId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS Evaluator ${uid}`);
    assignedCourseId = await createCourse(admin, institutionId);
    unassignedCourseId = await createCourse(admin, institutionId);

    assignedQuestionId = await createQuestion(admin, assignedCourseId);
    unassignedQuestionId = await createQuestion(admin, unassignedCourseId);

    assignedMaterialId = await createCourseMaterial(admin, assignedCourseId);
    unassignedMaterialId = await createCourseMaterial(admin, unassignedCourseId);
    assignedChapterId = await createMaterialChapter(admin, assignedMaterialId, 1);
    unassignedChapterId = await createMaterialChapter(admin, unassignedMaterialId, 1);

    // Wire each question to its course's chapter so question_chapters has rows
    // to test SELECT against.
    const { error: linkAssignedErr } = await admin
      .from('question_chapters')
      .insert({ question_id: assignedQuestionId, chapter_id: assignedChapterId });
    if (linkAssignedErr) throw new Error(`link assigned chapter: ${linkAssignedErr.message}`);
    const { error: linkUnassignedErr } = await admin
      .from('question_chapters')
      .insert({ question_id: unassignedQuestionId, chapter_id: unassignedChapterId });
    if (linkUnassignedErr) throw new Error(`link unassigned chapter: ${linkUnassignedErr.message}`);

    // Same idea for course_competencies / question_competencies.
    const { data: assignedComp, error: assignedCompErr } = await admin
      .from('course_competencies')
      .insert({ course_id: assignedCourseId, title: `Comp A ${uid}` })
      .select('id').single();
    if (assignedCompErr) throw new Error(`assigned competency: ${assignedCompErr.message}`);
    assignedCompetencyId = assignedComp!.id as string;

    const { data: unassignedComp, error: unassignedCompErr } = await admin
      .from('course_competencies')
      .insert({ course_id: unassignedCourseId, title: `Comp B ${uid}` })
      .select('id').single();
    if (unassignedCompErr) throw new Error(`unassigned competency: ${unassignedCompErr.message}`);
    unassignedCompetencyId = unassignedComp!.id as string;

    const { error: linkAssignedCompErr } = await admin
      .from('question_competencies')
      .insert({ question_id: assignedQuestionId, competency_id: assignedCompetencyId });
    if (linkAssignedCompErr) throw new Error(`link assigned comp: ${linkAssignedCompErr.message}`);
    const { error: linkUnassignedCompErr } = await admin
      .from('question_competencies')
      .insert({ question_id: unassignedQuestionId, competency_id: unassignedCompetencyId });
    if (linkUnassignedCompErr) throw new Error(`link unassigned comp: ${linkUnassignedCompErr.message}`);

    // Evaluator scoped to course A only.
    const evalUser = await createTestUserClient(admin, `rls-eval-${uid}@test.local`);
    evaluatorClient = evalUser.client;
    evaluatorId = evalUser.userId;
    userIds.push(evalUser.userId);
    await addUserToInstitution(admin, evalUser.userId, institutionId, 'evaluator');
    await assignCourseEvaluator(admin, assignedCourseId, evalUser.userId);

    // Same institution, no evaluator role and no course assignment.
    const unrelated = await createTestUserClient(admin, `rls-eval-other-${uid}@test.local`);
    unrelatedClient = unrelated.client;
    userIds.push(unrelated.userId);
    await addUserToInstitution(admin, unrelated.userId, institutionId, 'student');

    // Institution admin (used as a sanity baseline + write check).
    const instAdmin = await createTestUserClient(admin, `rls-eval-adm-${uid}@test.local`);
    instAdminClient = instAdmin.client;
    instAdminId = instAdmin.userId;
    userIds.push(instAdmin.userId);
    await addUserToInstitution(admin, instAdmin.userId, institutionId, 'admin');

    // Seed question_votes rows for SELECT policy tests (4d). Must come after
    // instAdminId is assigned above. Voter is instAdminId (not evaluatorId) so
    // the evaluator-cannot-vote INSERT test doesn't hit a unique conflict.
    const { error: assignedVoteErr } = await admin
      .from('question_votes')
      .insert({ question_id: assignedQuestionId, user_id: instAdminId, vote_type: 'up' });
    if (assignedVoteErr) throw new Error(`seed assigned vote: ${assignedVoteErr.message}`);
    const { error: unassignedVoteErr } = await admin
      .from('question_votes')
      .insert({ question_id: unassignedQuestionId, user_id: instAdminId, vote_type: 'up' });
    if (unassignedVoteErr) throw new Error(`seed unassigned vote: ${unassignedVoteErr.message}`);

    // Separate institution + admin to test cross-institution isolation on
    // course_evaluators itself.
    otherInstitutionId = await createInstitution(admin, `RLS Evaluator Other ${uid}`);
    otherCourseId = await createCourse(admin, otherInstitutionId);
    const otherAdmin = await createTestUserClient(admin, `rls-eval-otheradm-${uid}@test.local`);
    otherAdminClient = otherAdmin.client;
    userIds.push(otherAdmin.userId);
    await addUserToInstitution(admin, otherAdmin.userId, otherInstitutionId, 'admin');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
    // Second institution scaffold — cleanupScaffold takes a single id, so handle
    // the other institution inline. user_institutions for the other-admin user
    // are scoped to otherInstitutionId, NOT institutionId, so the first call
    // above does NOT delete them — this explicit delete is required.
    await admin
      .from('user_institutions')
      .delete()
      .eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
  });

  // ── SELECT: assigned course ──────────────────────────────────────────

  it('evaluator can see questions in their assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('questions').select('id').eq('id', assignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('evaluator can see the assigned course row itself', async () => {
    const { data, error } = await evaluatorClient
      .from('courses').select('id').eq('id', assignedCourseId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('evaluator can see question_chapters for assigned-course questions', async () => {
    const { data, error } = await evaluatorClient
      .from('question_chapters').select('question_id, chapter_id').eq('question_id', assignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('evaluator can see question_competencies for assigned-course questions', async () => {
    const { data, error } = await evaluatorClient
      .from('question_competencies').select('question_id, competency_id').eq('question_id', assignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('evaluator can see material_chapters for assigned-course materials', async () => {
    const { data, error } = await evaluatorClient
      .from('material_chapters').select('id').eq('id', assignedChapterId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // #667 — gap-fill on course_materials so the unified question bank's
  // chapter loader (`material_chapters!inner(course_materials!inner(...))`)
  // doesn't silently drop chapter context for evaluators.
  it('evaluator can see course_materials for assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('course_materials').select('id').eq('id', assignedMaterialId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('evaluator can see course_competencies for assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('course_competencies').select('id').eq('id', assignedCompetencyId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('evaluator can read question_votes for assigned course (policy 4d)', async () => {
    const { data, error } = await evaluatorClient
      .from('question_votes').select('question_id').eq('question_id', assignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // ── SELECT isolation: same institution, different course ─────────────

  it('evaluator cannot see questions in an unassigned course in the same institution', async () => {
    const { data, error } = await evaluatorClient
      .from('questions').select('id').eq('id', unassignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot see unassigned courses', async () => {
    const { data, error } = await evaluatorClient
      .from('courses').select('id').eq('id', unassignedCourseId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot see question_chapters for unassigned-course questions', async () => {
    const { data, error } = await evaluatorClient
      .from('question_chapters').select('question_id').eq('question_id', unassignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot see question_competencies for unassigned-course questions', async () => {
    const { data, error } = await evaluatorClient
      .from('question_competencies').select('question_id').eq('question_id', unassignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot see material_chapters for unassigned-course materials', async () => {
    const { data, error } = await evaluatorClient
      .from('material_chapters').select('id').eq('id', unassignedChapterId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // #667 — same isolation check for the gap-fill course_materials policy.
  it('evaluator cannot see course_materials for unassigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('course_materials').select('id').eq('id', unassignedMaterialId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot see course_competencies for unassigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('course_competencies').select('id').eq('id', unassignedCompetencyId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot see question_votes for unassigned course (policy 4d isolation)', async () => {
    const { data, error } = await evaluatorClient
      .from('question_votes').select('question_id').eq('question_id', unassignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // ── WRITE: every mutation on the question surface is denied ──────────

  it('evaluator cannot insert a new question in the assigned course', async () => {
    const { error } = await evaluatorClient
      .from('questions')
      .insert({
        course_id: assignedCourseId,
        question: 'Evaluator should not be able to insert',
        type: 'mcq',
        payload: { options: ['A', 'B', 'C', 'D'] },
        answer_key: { correct_indices: [0], correct_index: 0 },
        difficulty: 'medium',
        created_by: evaluatorId,
      });
    expect(error).not.toBeNull();
  });

  it('evaluator cannot update a question in the assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('questions')
      .update({ question: 'tampered by evaluator' })
      .eq('id', assignedQuestionId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot delete a question in the assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('questions')
      .delete()
      .eq('id', assignedQuestionId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot insert question_chapters for the assigned course', async () => {
    const { error } = await evaluatorClient
      .from('question_chapters')
      .insert({ question_id: assignedQuestionId, chapter_id: assignedChapterId });
    expect(error).not.toBeNull();
  });

  it('evaluator cannot delete question_chapters for the assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('question_chapters')
      .delete()
      .eq('question_id', assignedQuestionId)
      .select();
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('evaluator cannot insert question_competencies for the assigned course', async () => {
    const { error } = await evaluatorClient
      .from('question_competencies')
      .insert({ question_id: assignedQuestionId, competency_id: assignedCompetencyId });
    expect(error).not.toBeNull();
  });

  it('evaluator cannot vote on a question in the assigned course', async () => {
    const { error } = await evaluatorClient
      .from('question_votes')
      .insert({
        question_id: assignedQuestionId,
        user_id: evaluatorId,
        vote_type: 'up',
      });
    expect(error).not.toBeNull();
  });

  // ── Other users: confirm policy isolation ────────────────────────────

  it('non-evaluator institution member cannot see assigned-course questions through the evaluator branch', async () => {
    // Sanity: an institution student with no enrollment / tag access still
    // can't see this question — proves the new SELECT policy didn't
    // accidentally widen access for non-evaluators.
    const { data, error } = await unrelatedClient
      .from('questions').select('id').eq('id', assignedQuestionId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin can still see questions in both courses (sanity)', async () => {
    const { data, error } = await instAdminClient
      .from('questions').select('id').in('id', [assignedQuestionId, unassignedQuestionId]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  // ── course_evaluators table itself ───────────────────────────────────

  it('institution admin can assign an evaluator in their own institution', async () => {
    // Insert a throwaway evaluator assignment via the admin client to prove
    // the management policy fires for an in-institution admin.
    const { data: evalUser } = await admin.auth.admin.createUser({
      email: `rls-eval-throwaway-${uid}@test.local`,
      password: 'testpass123',
      email_confirm: true,
    });
    const throwawayId = evalUser!.user!.id;
    userIds.push(throwawayId);
    await addUserToInstitution(admin, throwawayId, institutionId, 'evaluator');

    const { error } = await instAdminClient
      .from('course_evaluators')
      .insert({ course_id: assignedCourseId, user_id: throwawayId });
    expect(error).toBeNull();
  });

  it('an admin of another institution cannot assign evaluators to this institution\'s course', async () => {
    const { data: evalUser } = await admin.auth.admin.createUser({
      email: `rls-eval-cross-${uid}@test.local`,
      password: 'testpass123',
      email_confirm: true,
    });
    const crossUserId = evalUser!.user!.id;
    userIds.push(crossUserId);
    await addUserToInstitution(admin, crossUserId, otherInstitutionId, 'evaluator');

    const { error } = await otherAdminClient
      .from('course_evaluators')
      .insert({ course_id: assignedCourseId, user_id: crossUserId });
    // RLS blocks the insert on the source-institution's course.
    expect(error).not.toBeNull();
  });

  it('evaluator cannot self-assign to another course', async () => {
    const { error } = await evaluatorClient
      .from('course_evaluators')
      .insert({ course_id: unassignedCourseId, user_id: evaluatorId });
    expect(error).not.toBeNull();
  });
});
