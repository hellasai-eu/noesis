import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createQuestion,
  addUserToInstitution,
  assignCourseEvaluator,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

// Issue #665: question_evaluation_sessions + question_evaluations storage.
// Evaluators own/write their own rows for courses they're assigned to;
// instructors/admins of the same course read-only; no student access.
describe('question evaluations RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let assignedCourseId: string;
  let unassignedCourseId: string;
  let assignedQuestionId: string;
  let unassignedQuestionId: string;

  let evaluatorClient: SupabaseClient;
  let evaluatorId: string;
  let secondEvaluatorClient: SupabaseClient;
  let secondEvaluatorId: string;
  let dualEvaluatorClient: SupabaseClient;
  let dualEvaluatorId: string;
  let instructorClient: SupabaseClient;
  let adminClient: SupabaseClient;
  let studentClient: SupabaseClient;

  const userIds: string[] = [];

  // Convenience: a fully-populated insert payload for question_evaluations.
  // Tests override individual fields to exercise specific CHECKs/RLS branches.
  const baseEvaluation = (overrides: Record<string, unknown> = {}) => ({
    verdict: 'good',
    difficulty_confirmation: 'correct',
    question_good: true,
    answer_good: true,
    clarity: 5,
    distractor_quality: 4,
    curriculum_alignment: 5,
    question_bank_alignment: 4,
    pedagogical_value: 5,
    language_appropriateness: 5,
    problem_categories: [] as string[],
    comment: null,
    was_sampled: false,
    cognitive_level: null,
    ...overrides,
  });

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS QEval ${uid}`);
    assignedCourseId = await createCourse(admin, institutionId);
    unassignedCourseId = await createCourse(admin, institutionId);
    assignedQuestionId = await createQuestion(admin, assignedCourseId);
    unassignedQuestionId = await createQuestion(admin, unassignedCourseId);

    const evalUser = await createTestUserClient(admin, `rls-qeval-eval-${uid}@test.local`);
    evaluatorClient = evalUser.client;
    evaluatorId = evalUser.userId;
    userIds.push(evalUser.userId);
    await addUserToInstitution(admin, evalUser.userId, institutionId, 'evaluator');
    await assignCourseEvaluator(admin, assignedCourseId, evalUser.userId);

    // Second evaluator on a DIFFERENT course in the same institution — used
    // to prove evaluator A can't read evaluator B's rows.
    const evalUser2 = await createTestUserClient(admin, `rls-qeval-eval2-${uid}@test.local`);
    secondEvaluatorClient = evalUser2.client;
    secondEvaluatorId = evalUser2.userId;
    userIds.push(evalUser2.userId);
    await addUserToInstitution(admin, evalUser2.userId, institutionId, 'evaluator');
    await assignCourseEvaluator(admin, unassignedCourseId, evalUser2.userId);

    // Dual-course evaluator — assigned to BOTH courses, used to verify that
    // a session from Course A cannot be paired with a question from Course B.
    const dualEval = await createTestUserClient(admin, `rls-qeval-dual-${uid}@test.local`);
    dualEvaluatorClient = dualEval.client;
    dualEvaluatorId = dualEval.userId;
    userIds.push(dualEval.userId);
    await addUserToInstitution(admin, dualEval.userId, institutionId, 'evaluator');
    await assignCourseEvaluator(admin, assignedCourseId, dualEval.userId);
    await assignCourseEvaluator(admin, unassignedCourseId, dualEval.userId);

    const inst = await createTestUserClient(admin, `rls-qeval-inst-${uid}@test.local`);
    instructorClient = inst.client;
    userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, assignedCourseId, inst.userId);

    const adm = await createTestUserClient(admin, `rls-qeval-adm-${uid}@test.local`);
    adminClient = adm.client;
    userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const stu = await createTestUserClient(admin, `rls-qeval-stu-${uid}@test.local`);
    studentClient = stu.client;
    userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ── question_evaluation_sessions: evaluator owns own ──────────────────

  it('evaluator can create a session in their assigned course', async () => {
    const { data, error } = await evaluatorClient
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  it('evaluator cannot create a session for an unassigned course', async () => {
    const { error } = await evaluatorClient
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: unassignedCourseId });
    expect(error).not.toBeNull();
  });

  it('evaluator cannot spoof evaluator_id on session insert', async () => {
    const { error } = await evaluatorClient
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: secondEvaluatorId, course_id: assignedCourseId });
    expect(error).not.toBeNull();
  });

  it('evaluator can update their own session (e.g. set ended_at + summary)', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;

    const { data, error } = await evaluatorClient
      .from('question_evaluation_sessions')
      .update({
        ended_at: new Date().toISOString(),
        overall_quality: 4,
        recurring_problems: 'Some recurring issue',
        would_use: 'yes_with_fixes',
      })
      .eq('id', sessionId)
      .select('id, overall_quality, would_use')
      .single();
    expect(error).toBeNull();
    expect(data?.overall_quality).toBe(4);
    expect(data?.would_use).toBe('yes_with_fixes');
  });

  it("session.would_use rejects values outside the allowed set", async () => {
    const { error } = await admin
      .from('question_evaluation_sessions')
      .insert({
        evaluator_id: evaluatorId,
        course_id: assignedCourseId,
        would_use: 'maybe',
      });
    expect(error).not.toBeNull();
  });

  it('session.overall_quality must be 1..5', async () => {
    const { error } = await admin
      .from('question_evaluation_sessions')
      .insert({
        evaluator_id: evaluatorId,
        course_id: assignedCourseId,
        overall_quality: 6,
      });
    expect(error).not.toBeNull();
  });

  // ── question_evaluations: evaluator owns own ──────────────────────────

  it('evaluator can insert an evaluation row for an assigned-course question', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;

    const { data, error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: assignedQuestionId,
        evaluator_id: evaluatorId,
      }))
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  it('evaluator cannot insert an evaluation for a question in an unassigned course', async () => {
    // Create a session in the unassigned course via service role so the FK is
    // satisfied — the RLS branch should still reject the evaluation insert
    // because the question's course isn't assigned to this evaluator.
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: unassignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;

    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: unassignedQuestionId,
        evaluator_id: evaluatorId,
      }));
    expect(error).not.toBeNull();
  });

  it('evaluator assigned to both courses cannot mix a Course A session with a Course B question', async () => {
    // Demonstrates the cross-course mismatch fix: even though dualEvaluatorId
    // is assigned to both courses, a session from assignedCourseId must not
    // be usable with a question from unassignedCourseId.
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: dualEvaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;

    const { error } = await dualEvaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: unassignedQuestionId, // belongs to unassignedCourseId
        evaluator_id: dualEvaluatorId,
      }));
    expect(error).not.toBeNull();
  });

  it('re-submission updates the existing row and repoints session_id', async () => {
    const { data: session1 } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const session1Id = session1!.id as string;

    // Use a fresh question to avoid the UNIQUE collision with rows seeded in
    // earlier tests in this suite.
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { data: firstRow, error: firstErr } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: session1Id,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
        verdict: 'needs_fixing',
        problem_categories: ['weak_distractors'],
      }))
      .select('id')
      .single();
    expect(firstErr).toBeNull();
    const rowId = firstRow!.id as string;

    // Start a new session and update the existing per-question row to point
    // to it — the "re-submission updates the same row" criterion.
    const { data: session2 } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const session2Id = session2!.id as string;

    const { data: updated, error: updErr } = await evaluatorClient
      .from('question_evaluations')
      .update({ session_id: session2Id, verdict: 'good', problem_categories: [] })
      .eq('id', rowId)
      .select('id, session_id, verdict')
      .single();
    expect(updErr).toBeNull();
    expect(updated?.session_id).toBe(session2Id);
    expect(updated?.verdict).toBe('good');
  });

  it('UNIQUE(evaluator_id, question_id) blocks a second insert for the same pair', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;

    // The first test in this block already inserted (evaluatorId, assignedQuestionId).
    // A second insert for the same pair must fail.
    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: assignedQuestionId,
        evaluator_id: evaluatorId,
      }));
    expect(error).not.toBeNull();
  });

  it('problem_categories rejects a code outside the allowed set', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
        verdict: 'needs_fixing',
        problem_categories: ['not_a_valid_code'],
      }));
    expect(error).not.toBeNull();
  });

  it('was_sampled=true requires cognitive_level', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
        was_sampled: true,
        cognitive_level: null,
      }));
    expect(error).not.toBeNull();
  });

  it('was_sampled=false forbids cognitive_level', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
        was_sampled: false,
        cognitive_level: 'recall',
      }));
    expect(error).not.toBeNull();
  });

  it('was_sampled=true + valid cognitive_level passes', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
        was_sampled: true,
        cognitive_level: 'application_analysis',
      }));
    expect(error).toBeNull();
  });

  it('1..5 ratings reject 6', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await evaluatorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
        clarity: 6,
      }));
    expect(error).not.toBeNull();
  });

  // ── Cross-evaluator isolation ────────────────────────────────────────

  it("an evaluator cannot read another evaluator's session or evaluation", async () => {
    // Seed evaluator-2's session + a row via service role on the OTHER course
    // so its question is one only evaluator-2 can write for.
    const { data: session2 } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: secondEvaluatorId, course_id: unassignedCourseId })
      .select('id')
      .single();
    const session2Id = session2!.id as string;

    const { data: row2 } = await admin
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: session2Id,
        question_id: unassignedQuestionId,
        evaluator_id: secondEvaluatorId,
      }))
      .select('id')
      .single();
    const row2Id = row2!.id as string;

    // Evaluator-1 must NOT see either row.
    const { data: sData } = await evaluatorClient
      .from('question_evaluation_sessions').select('id').eq('id', session2Id);
    expect(sData).toHaveLength(0);

    const { data: rData } = await evaluatorClient
      .from('question_evaluations').select('id').eq('id', row2Id);
    expect(rData).toHaveLength(0);

    // But evaluator-2 can see their own.
    const { data: ownSession } = await secondEvaluatorClient
      .from('question_evaluation_sessions').select('id').eq('id', session2Id);
    expect(ownSession).toHaveLength(1);
    const { data: ownRow } = await secondEvaluatorClient
      .from('question_evaluations').select('id').eq('id', row2Id);
    expect(ownRow).toHaveLength(1);
  });

  // ── Instructor / admin read-only ─────────────────────────────────────

  it('assigned-course instructor can read sessions and evaluations', async () => {
    const { data: sessions, error: sErr } = await instructorClient
      .from('question_evaluation_sessions')
      .select('id')
      .eq('course_id', assignedCourseId);
    expect(sErr).toBeNull();
    expect(sessions?.length).toBeGreaterThan(0);

    const { data: rows, error: rErr } = await instructorClient
      .from('question_evaluations')
      .select('id')
      .eq('question_id', assignedQuestionId);
    expect(rErr).toBeNull();
    expect(rows?.length).toBeGreaterThan(0);
  });

  it('institution admin can read sessions and evaluations', async () => {
    const { data: sessions, error: sErr } = await adminClient
      .from('question_evaluation_sessions')
      .select('id')
      .eq('course_id', assignedCourseId);
    expect(sErr).toBeNull();
    expect(sessions?.length).toBeGreaterThan(0);

    const { data: rows, error: rErr } = await adminClient
      .from('question_evaluations')
      .select('id')
      .eq('question_id', assignedQuestionId);
    expect(rErr).toBeNull();
    expect(rows?.length).toBeGreaterThan(0);
  });

  it('instructor cannot insert evaluations even for their assigned course', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await instructorClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
      }));
    expect(error).not.toBeNull();
  });

  it('instructor cannot update an evaluator\'s row', async () => {
    const { data, error } = await instructorClient
      .from('question_evaluations')
      .update({ verdict: 'reject' })
      .eq('question_id', assignedQuestionId)
      .select();
    // RLS makes the row invisible to the UPDATE; no error, zero rows touched.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('institution admin cannot insert evaluations even for their institution', async () => {
    const { data: session } = await admin
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId })
      .select('id')
      .single();
    const sessionId = session!.id as string;
    const freshQuestionId = await createQuestion(admin, assignedCourseId);

    const { error } = await adminClient
      .from('question_evaluations')
      .insert(baseEvaluation({
        session_id: sessionId,
        question_id: freshQuestionId,
        evaluator_id: evaluatorId,
      }));
    expect(error).not.toBeNull();
  });

  it('institution admin cannot update an evaluator\'s row', async () => {
    const { data, error } = await adminClient
      .from('question_evaluations')
      .update({ verdict: 'reject' })
      .eq('question_id', assignedQuestionId)
      .select();
    // RLS makes the row invisible to the UPDATE; no error, zero rows touched.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('student cannot read sessions or evaluations', async () => {
    const { data: sData, error: sErr } = await studentClient
      .from('question_evaluation_sessions')
      .select('id')
      .eq('course_id', assignedCourseId);
    expect(sErr).toBeNull();
    expect(sData).toHaveLength(0);

    const { data: rData, error: rErr } = await studentClient
      .from('question_evaluations')
      .select('id')
      .eq('question_id', assignedQuestionId);
    expect(rErr).toBeNull();
    expect(rData).toHaveLength(0);
  });

  it('student cannot insert a session or evaluation', async () => {
    const { error: sErr } = await studentClient
      .from('question_evaluation_sessions')
      .insert({ evaluator_id: evaluatorId, course_id: assignedCourseId });
    expect(sErr).not.toBeNull();
  });
});
