// Tables under test: public.quiz_analyses
//
// Migrations that introduced the policies covered here:
//   * 20260715000000_quiz_analyses.sql (#837)
//       - CREATE TABLE quiz_analyses (one row per (quiz_id, offering_id))
//       - "Managers can write quiz analyses" (FOR ALL, can_manage_offering)
//   * 20260912090000_quiz_analyses_manager_only_read.sql (compliance F3)
//       - "Managers can read quiz analyses" (FOR SELECT, can_manage_offering),
//         replacing the original has_offering_access read policy so enrolled
//         students can no longer read the stored analysis — its clusters JSON
//         names classmates under judgment labels.
//
// Both reads and writes are manager-scoped, matching study_guide_analyses.
// These tests lock in that behavior plus cross-institution isolation.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuiz,
  createQuizAnalysis,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('quiz_analyses RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;
  let quizId: string;
  let analysisId: string;

  let instructorClient: SupabaseClient;
  let studentClient: SupabaseClient;

  // Second institution — cross-tenant isolation.
  let otherInstitutionId: string;
  let otherCourseId: string;
  let otherOfferingId: string;
  let otherQuizId: string;
  let otherAdminClient: SupabaseClient;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS QuizAnalysis ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);
    quizId = await createQuiz(admin, courseId);
    analysisId = await createQuizAnalysis(admin, quizId, offeringId);

    const inst = await createTestUserClient(admin, `rls-qa-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const stu = await createTestUserClient(admin, `rls-qa-stu-${uid}@test.local`);
    studentClient = stu.client; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    // Second institution scaffold for cross-tenant isolation checks.
    otherInstitutionId = await createInstitution(admin, `RLS QuizAnalysis Other ${uid}`);
    otherCourseId = await createCourse(admin, otherInstitutionId);
    const otherClassId = await createClass(admin, otherInstitutionId);
    otherOfferingId = await createOffering(admin, otherClassId, otherCourseId);
    otherQuizId = await createQuiz(admin, otherCourseId);
    const otherAdmin = await createTestUserClient(admin, `rls-qa-otheradm-${uid}@test.local`);
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

  it('assigned instructor (manager) can read the analysis', async () => {
    const { data, error } = await instructorClient
      .from('quiz_analyses' as never).select('id').eq('id', analysisId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // SELECT is manager-only: the clusters JSON names classmates under judgment
  // labels, so an enrolled student must not be able to read it (F3).
  it('enrolled student cannot read the analysis', async () => {
    const { data, error } = await studentClient
      .from('quiz_analyses' as never).select('id').eq('id', analysisId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('admin of another institution cannot read the analysis', async () => {
    const { data, error } = await otherAdminClient
      .from('quiz_analyses' as never).select('id').eq('id', analysisId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // INSERT / UPDATE — managers only
  it('assigned instructor (manager) can insert an analysis', async () => {
    const q = await createQuiz(admin, courseId);
    const { data, error } = await instructorClient
      .from('quiz_analyses' as never)
      .insert({
        quiz_id: q,
        offering_id: offeringId,
        report: { summary: 'manager insert' },
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('assigned instructor (manager) can update an analysis', async () => {
    const { data, error } = await instructorClient
      .from('quiz_analyses' as never)
      .update({ submission_count: 5 })
      .eq('id', analysisId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('enrolled student cannot insert an analysis', async () => {
    const q = await createQuiz(admin, courseId);
    const { error } = await studentClient
      .from('quiz_analyses' as never)
      .insert({
        quiz_id: q,
        offering_id: offeringId,
        report: { summary: 'student insert' },
      });
    expect(error).not.toBeNull();
  });

  it('enrolled student cannot update an analysis', async () => {
    const { data } = await studentClient
      .from('quiz_analyses' as never)
      .update({ submission_count: 99 })
      .eq('id', analysisId)
      .select('id');
    expect(data).toHaveLength(0);
  });

  it('enrolled student cannot delete an analysis', async () => {
    const { data } = await studentClient
      .from('quiz_analyses' as never).delete().eq('id', analysisId).select();
    expect(data).toHaveLength(0);
  });

  it('assigned instructor (manager) can delete an analysis', async () => {
    const q = await createQuiz(admin, courseId);
    const toDelete = await createQuizAnalysis(admin, q, offeringId);
    const { data, error } = await instructorClient
      .from('quiz_analyses' as never).delete().eq('id', toDelete).select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('admin of another institution cannot insert an analysis for this offering', async () => {
    const q = await createQuiz(admin, courseId);
    const { error } = await otherAdminClient
      .from('quiz_analyses' as never)
      .insert({
        quiz_id: q,
        offering_id: offeringId,
        report: { summary: 'cross-tenant insert' },
      });
    expect(error).not.toBeNull();
  });

  it('admin of another institution can write within their own offering', async () => {
    const { data, error } = await otherAdminClient
      .from('quiz_analyses' as never)
      .insert({
        quiz_id: otherQuizId,
        offering_id: otherOfferingId,
        report: { summary: 'own-tenant insert' },
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});
