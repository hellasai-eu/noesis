// Tables under test:
//   public.student_evaluations
//   public.evaluation_competency_scores
//   public.evaluation_timeline_cache
//
// Migrations that introduced / shaped the policies covered here:
//   * 20251214071925_...sql
//       - CREATE TABLE student_evaluations, policies
//         "Admins and instructors can manage evaluations" (FOR ALL, USING only —
//         so USING doubles as the WITH CHECK for writes)
//         "Students can view their own evaluations" (SELECT, user_id = auth.uid())
//   * 20260102185625_...sql
//       - CREATE TABLE evaluation_timeline_cache, policy
//         "Admins and instructors can manage timeline cache" (FOR ALL, USING +
//         WITH CHECK). Deliberately has NO student-read policy.
//   * 20260423000000_evaluation_competency_scores_table.sql
//       - CREATE TABLE evaluation_competency_scores, policies
//         "Admins and instructors can manage evaluation competency scores",
//         "Students can view their own evaluation competency scores"
//   * 20260424000000_add_is_manual_to_evaluation_competency_scores.sql
//
// The recurring shape across all three tables is
//   is_super_admin(uid) OR (member of the course's institution AND
//                           (role = 'admin' OR is_course_instructor(course, uid)))
// so the interesting cases are the *near misses*: an instructor at the same
// institution assigned to a different course, an evaluator assigned to this
// course, and the subject student themselves.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createCourseCompetency,
  createStudentEvaluation,
  createEvaluationCompetencyScore,
  createEvaluationTimelineCache,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  assignCourseEvaluator,
  addSuperAdmin,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('student_evaluations / evaluation_competency_scores / evaluation_timeline_cache RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let otherInstitutionId: string;
  let courseId: string;
  let otherCourseId: string;
  let otherInstCourseId: string;
  let classId: string;
  let offeringId: string;
  let competencyId: string;
  let secondCompetencyId: string;
  let evaluationId: string;
  let scoreId: string;
  let timelineId: string;

  let superAdminClient: SupabaseClient;
  let adminClient: SupabaseClient;
  let teachingInstructorClient: SupabaseClient;
  let otherCourseInstructorClient: SupabaseClient;
  let evaluatorClient: SupabaseClient;
  let studentSelfClient: SupabaseClient;
  let studentSelfId: string;
  let otherStudentClient: SupabaseClient;
  let otherStudentId: string;
  let otherInstAdminClient: SupabaseClient;

  const userIds: string[] = [];
  const otherInstUserIds: string[] = [];
  const superAdminEmail = `rls-se-sa-${uid}@test.local`;

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS SE ${uid}`);
    otherInstitutionId = await createInstitution(admin, `RLS SE Other ${uid}`);

    courseId = await createCourse(admin, institutionId);
    otherCourseId = await createCourse(admin, institutionId);
    otherInstCourseId = await createCourse(admin, otherInstitutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    // Super-admin clients need an aal2 token since the MFA mandate (see helpers/auth.ts).
    const sa = await createTestUserClient(admin, superAdminEmail, 'testpass123', { aal2: true });
    superAdminClient = sa.client;
    userIds.push(sa.userId);
    await addSuperAdmin(admin, superAdminEmail);

    const adm = await createTestUserClient(admin, `rls-se-adm-${uid}@test.local`);
    adminClient = adm.client;
    userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, institutionId, 'admin');

    const teaching = await createTestUserClient(admin, `rls-se-tinst-${uid}@test.local`);
    teachingInstructorClient = teaching.client;
    userIds.push(teaching.userId);
    await addUserToInstitution(admin, teaching.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, teaching.userId);

    // Same institution, but assigned to a different course — the sharpest
    // isolation case, since institution membership alone must not grant access.
    const otherCourseInst = await createTestUserClient(
      admin,
      `rls-se-oinst-${uid}@test.local`
    );
    otherCourseInstructorClient = otherCourseInst.client;
    userIds.push(otherCourseInst.userId);
    await addUserToInstitution(admin, otherCourseInst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, otherCourseId, otherCourseInst.userId);

    // Evaluators get broad read access to a course's question bank
    // (20260624200000). They must NOT inherit access to student evaluations.
    const evaluator = await createTestUserClient(admin, `rls-se-eval-${uid}@test.local`);
    evaluatorClient = evaluator.client;
    userIds.push(evaluator.userId);
    await addUserToInstitution(admin, evaluator.userId, institutionId, 'evaluator');
    await assignCourseEvaluator(admin, courseId, evaluator.userId);

    const stu = await createTestUserClient(admin, `rls-se-stu-${uid}@test.local`);
    studentSelfClient = stu.client;
    studentSelfId = stu.userId;
    userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    const otherStu = await createTestUserClient(admin, `rls-se-stu2-${uid}@test.local`);
    otherStudentClient = otherStu.client;
    otherStudentId = otherStu.userId;
    userIds.push(otherStu.userId);
    await addUserToInstitution(admin, otherStu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, otherStu.userId, 'student');

    const otherAdm = await createTestUserClient(admin, `rls-se-oadm-${uid}@test.local`);
    otherInstAdminClient = otherAdm.client;
    otherInstUserIds.push(otherAdm.userId);
    await addUserToInstitution(admin, otherAdm.userId, otherInstitutionId, 'admin');

    competencyId = await createCourseCompetency(admin, courseId, { title: `Fractions ${uid}` });
    secondCompetencyId = await createCourseCompetency(admin, courseId, {
      title: `Geometry ${uid}`,
    });

    evaluationId = await createStudentEvaluation(admin, courseId, studentSelfId, {
      offeringId,
      overallAssessment: `Baseline evaluation ${uid}`,
    });
    scoreId = await createEvaluationCompetencyScore(admin, evaluationId, competencyId, {
      score: 72,
    });
    timelineId = await createEvaluationTimelineCache(admin, courseId, studentSelfId);
  });

  afterAll(async () => {
    // ON DELETE RESTRICT chains mean these must go before the institution:
    //   evaluation_competency_scores → course_competencies (RESTRICT)
    //   student_evaluations          → offerings           (RESTRICT)
    const { data: evals } = await admin
      .from('student_evaluations')
      .select('id')
      .in('course_id', [courseId, otherCourseId, otherInstCourseId]);
    const evalIds = (evals ?? []).map((e) => e.id);
    if (evalIds.length > 0) {
      await admin.from('evaluation_competency_scores').delete().in('evaluation_id', evalIds);
      await admin.from('student_evaluations').delete().in('id', evalIds);
    }
    await admin
      .from('evaluation_timeline_cache')
      .delete()
      .in('course_id', [courseId, otherCourseId, otherInstCourseId]);

    await admin.from('super_admins').delete().eq('email', superAdminEmail);
    await admin.from('user_institutions').delete().eq('institution_id', otherInstitutionId);
    await admin.from('institutions').delete().eq('id', otherInstitutionId);
    for (const id of otherInstUserIds) await admin.auth.admin.deleteUser(id);

    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---------------------------------------------------------------- SELECT
  describe('student_evaluations — read', () => {
    it('institution admin can read the evaluation', async () => {
      const { data, error } = await adminClient
        .from('student_evaluations')
        .select('id, overall_assessment')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('super-admin can read the evaluation', async () => {
      const { data, error } = await superAdminClient
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('instructor assigned to the course can read the evaluation', async () => {
      const { data, error } = await teachingInstructorClient
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('the subject student can read their own evaluation', async () => {
      const { data, error } = await studentSelfClient
        .from('student_evaluations')
        .select('id, overall_assessment')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('instructor of a different course in the same institution cannot read it', async () => {
      const { data, error } = await otherCourseInstructorClient
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('evaluator assigned to the course cannot read student evaluations', async () => {
      const { data, error } = await evaluatorClient
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('another student in the same class cannot read it', async () => {
      const { data, error } = await otherStudentClient
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('admin of another institution cannot read it', async () => {
      const { data, error } = await otherInstAdminClient
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('an unfiltered student read returns only their own evaluations', async () => {
      const otherEvalId = await createStudentEvaluation(admin, courseId, otherStudentId);
      const { data, error } = await studentSelfClient
        .from('student_evaluations')
        .select('id, user_id');
      expect(error).toBeNull();
      expect(data!.every((row) => row.user_id === studentSelfId)).toBe(true);
      expect(data!.map((r) => r.id)).not.toContain(otherEvalId);
      await admin.from('student_evaluations').delete().eq('id', otherEvalId);
    });
  });

  // ---------------------------------------------------------------- INSERT
  describe('student_evaluations — insert', () => {
    it('institution admin can insert an evaluation', async () => {
      const { data, error } = await adminClient
        .from('student_evaluations')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          overall_assessment: `Admin-authored ${uid}`,
          is_manual: true,
        })
        .select('id')
        .single();
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      await admin.from('student_evaluations').delete().eq('id', data!.id);
    });

    it('instructor assigned to the course can insert an evaluation', async () => {
      const { data, error } = await teachingInstructorClient
        .from('student_evaluations')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          overall_assessment: `Instructor-authored ${uid}`,
          is_manual: true,
        })
        .select('id')
        .single();
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      await admin.from('student_evaluations').delete().eq('id', data!.id);
    });

    it('instructor of a different course cannot insert into this course', async () => {
      const { error } = await otherCourseInstructorClient
        .from('student_evaluations')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          overall_assessment: `Should be blocked ${uid}`,
        });
      expect(error).not.toBeNull();
    });

    it('the subject student cannot write an evaluation about themselves', async () => {
      const { error } = await studentSelfClient
        .from('student_evaluations')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          overall_assessment: `Self-authored ${uid}`,
        });
      expect(error).not.toBeNull();
    });

    it('evaluator cannot insert an evaluation', async () => {
      const { error } = await evaluatorClient
        .from('student_evaluations')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          overall_assessment: `Evaluator-authored ${uid}`,
        });
      expect(error).not.toBeNull();
    });

    it('admin of another institution cannot insert into this institution course', async () => {
      const { error } = await otherInstAdminClient
        .from('student_evaluations')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          overall_assessment: `Cross-institution ${uid}`,
        });
      expect(error).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------- UPDATE
  describe('student_evaluations — update', () => {
    it('instructor assigned to the course can add instructor feedback', async () => {
      const { data, error } = await teachingInstructorClient
        .from('student_evaluations')
        .update({ instructor_feedback: `Nice work ${uid}` })
        .eq('id', evaluationId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('the subject student cannot edit their own evaluation', async () => {
      const { data } = await studentSelfClient
        .from('student_evaluations')
        .update({ overall_assessment: `Student edit ${uid}` })
        .eq('id', evaluationId)
        .select();
      expect(data).toHaveLength(0);
    });

    it('instructor of a different course cannot edit it', async () => {
      const { data } = await otherCourseInstructorClient
        .from('student_evaluations')
        .update({ overall_assessment: `Foreign edit ${uid}` })
        .eq('id', evaluationId)
        .select();
      expect(data).toHaveLength(0);
    });

    it('evaluator cannot edit it', async () => {
      const { data } = await evaluatorClient
        .from('student_evaluations')
        .update({ overall_assessment: `Evaluator edit ${uid}` })
        .eq('id', evaluationId)
        .select();
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- DELETE
  describe('student_evaluations — delete', () => {
    it('institution admin can delete an evaluation', async () => {
      const tmpId = await createStudentEvaluation(admin, courseId, studentSelfId);
      const { data, error } = await adminClient
        .from('student_evaluations')
        .delete()
        .eq('id', tmpId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('instructor assigned to the course can delete an evaluation', async () => {
      const tmpId = await createStudentEvaluation(admin, courseId, studentSelfId);
      const { data, error } = await teachingInstructorClient
        .from('student_evaluations')
        .delete()
        .eq('id', tmpId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('the subject student cannot delete their own evaluation', async () => {
      const { data } = await studentSelfClient
        .from('student_evaluations')
        .delete()
        .eq('id', evaluationId)
        .select();
      expect(data).toHaveLength(0);
      const { data: still } = await admin
        .from('student_evaluations')
        .select('id')
        .eq('id', evaluationId);
      expect(still).toHaveLength(1);
    });

    it('instructor of a different course cannot delete it', async () => {
      const { data } = await otherCourseInstructorClient
        .from('student_evaluations')
        .delete()
        .eq('id', evaluationId)
        .select();
      expect(data).toHaveLength(0);
    });
  });

  // ------------------------------------------- evaluation_competency_scores
  describe('evaluation_competency_scores', () => {
    it('institution admin can read a score', async () => {
      const { data, error } = await adminClient
        .from('evaluation_competency_scores')
        .select('id, score')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('instructor assigned to the course can read a score', async () => {
      const { data, error } = await teachingInstructorClient
        .from('evaluation_competency_scores')
        .select('id')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('the subject student can read their own score', async () => {
      const { data, error } = await studentSelfClient
        .from('evaluation_competency_scores')
        .select('id, score')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('another student cannot read it', async () => {
      const { data, error } = await otherStudentClient
        .from('evaluation_competency_scores')
        .select('id')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('instructor of a different course cannot read it', async () => {
      const { data, error } = await otherCourseInstructorClient
        .from('evaluation_competency_scores')
        .select('id')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('evaluator assigned to the course cannot read it', async () => {
      const { data, error } = await evaluatorClient
        .from('evaluation_competency_scores')
        .select('id')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('admin of another institution cannot read it', async () => {
      const { data, error } = await otherInstAdminClient
        .from('evaluation_competency_scores')
        .select('id')
        .eq('id', scoreId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('instructor can override a score and flag it manual', async () => {
      const { data, error } = await teachingInstructorClient
        .from('evaluation_competency_scores')
        .update({ score: 88, is_manual: true })
        .eq('id', scoreId)
        .select('score, is_manual');
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(Number(data![0].score)).toBe(88);
      expect(data![0].is_manual).toBe(true);
    });

    it('the subject student cannot edit their own score', async () => {
      const { data } = await studentSelfClient
        .from('evaluation_competency_scores')
        .update({ score: 100 })
        .eq('id', scoreId)
        .select();
      expect(data).toHaveLength(0);
    });

    it('instructor can insert a score for a second competency', async () => {
      const { data, error } = await teachingInstructorClient
        .from('evaluation_competency_scores')
        .insert({
          evaluation_id: evaluationId,
          competency_id: secondCompetencyId,
          score: 55,
        })
        .select('id')
        .single();
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      await admin.from('evaluation_competency_scores').delete().eq('id', data!.id);
    });

    it('the subject student cannot insert a score', async () => {
      const { error } = await studentSelfClient
        .from('evaluation_competency_scores')
        .insert({
          evaluation_id: evaluationId,
          competency_id: secondCompetencyId,
          score: 100,
        });
      expect(error).not.toBeNull();
    });

    it('rejects a score above 100 (CHECK)', async () => {
      const { error } = await adminClient
        .from('evaluation_competency_scores')
        .insert({
          evaluation_id: evaluationId,
          competency_id: secondCompetencyId,
          score: 101,
        });
      expect(error).not.toBeNull();
    });

    it('rejects a negative score (CHECK)', async () => {
      const { error } = await adminClient
        .from('evaluation_competency_scores')
        .insert({
          evaluation_id: evaluationId,
          competency_id: secondCompetencyId,
          score: -1,
        });
      expect(error).not.toBeNull();
    });

    it('rejects a duplicate (evaluation, competency) pair (UNIQUE)', async () => {
      const { error } = await adminClient
        .from('evaluation_competency_scores')
        .insert({
          evaluation_id: evaluationId,
          competency_id: competencyId,
          score: 10,
        });
      expect(error).not.toBeNull();
    });

    it('cascade-deletes with its parent evaluation', async () => {
      const tmpEvalId = await createStudentEvaluation(admin, courseId, studentSelfId);
      const tmpScoreId = await createEvaluationCompetencyScore(
        admin,
        tmpEvalId,
        secondCompetencyId
      );

      await adminClient.from('student_evaluations').delete().eq('id', tmpEvalId);

      const { data } = await admin
        .from('evaluation_competency_scores')
        .select('id')
        .eq('id', tmpScoreId);
      expect(data).toHaveLength(0);
    });
  });

  // ---------------------------------------------- evaluation_timeline_cache
  describe('evaluation_timeline_cache', () => {
    it('institution admin can read the cached timeline', async () => {
      const { data, error } = await adminClient
        .from('evaluation_timeline_cache')
        .select('id, summary')
        .eq('id', timelineId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('instructor assigned to the course can read the cached timeline', async () => {
      const { data, error } = await teachingInstructorClient
        .from('evaluation_timeline_cache')
        .select('id')
        .eq('id', timelineId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('super-admin can read the cached timeline', async () => {
      const { data, error } = await superAdminClient
        .from('evaluation_timeline_cache')
        .select('id')
        .eq('id', timelineId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    // Unlike student_evaluations and evaluation_competency_scores, this table
    // has no "students can view their own" policy. The timeline is an
    // instructor-facing artefact; pin that so a future policy change is a
    // deliberate one.
    it('the subject student cannot read their own cached timeline', async () => {
      const { data, error } = await studentSelfClient
        .from('evaluation_timeline_cache')
        .select('id')
        .eq('id', timelineId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('instructor of a different course cannot read it', async () => {
      const { data, error } = await otherCourseInstructorClient
        .from('evaluation_timeline_cache')
        .select('id')
        .eq('id', timelineId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('admin of another institution cannot read it', async () => {
      const { data, error } = await otherInstAdminClient
        .from('evaluation_timeline_cache')
        .select('id')
        .eq('id', timelineId);
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('instructor assigned to the course can update it', async () => {
      const { data, error } = await teachingInstructorClient
        .from('evaluation_timeline_cache')
        .update({ summary: `Refreshed ${uid}`, evaluation_count: 3 })
        .eq('id', timelineId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('instructor assigned to the course can insert a cache row', async () => {
      const { data, error } = await teachingInstructorClient
        .from('evaluation_timeline_cache')
        .insert({
          course_id: courseId,
          user_id: otherStudentId,
          summary: `Fresh ${uid}`,
          overall_trend: 'stable',
          evaluation_count: 2,
        })
        .select('id')
        .single();
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      await admin.from('evaluation_timeline_cache').delete().eq('id', data!.id);
    });

    it('instructor cannot insert a cache row for a course they do not teach (WITH CHECK)', async () => {
      const { error } = await teachingInstructorClient
        .from('evaluation_timeline_cache')
        .insert({
          course_id: otherCourseId,
          user_id: studentSelfId,
          summary: `Should be blocked ${uid}`,
          overall_trend: 'stable',
          evaluation_count: 2,
        });
      expect(error).not.toBeNull();
    });

    it('the subject student cannot insert a cache row for themselves', async () => {
      const { error } = await studentSelfClient
        .from('evaluation_timeline_cache')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          summary: `Self-authored ${uid}`,
          overall_trend: 'improving',
          evaluation_count: 2,
        });
      expect(error).not.toBeNull();
    });

    it('the subject student cannot delete their own cache row', async () => {
      const { data } = await studentSelfClient
        .from('evaluation_timeline_cache')
        .delete()
        .eq('id', timelineId)
        .select();
      expect(data).toHaveLength(0);
    });

    it('institution admin can delete a cache row', async () => {
      const tmpId = await createEvaluationTimelineCache(admin, courseId, otherStudentId);
      const { data, error } = await adminClient
        .from('evaluation_timeline_cache')
        .delete()
        .eq('id', tmpId)
        .select();
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it('rejects a duplicate (course, user) cache row (UNIQUE)', async () => {
      const { error } = await adminClient
        .from('evaluation_timeline_cache')
        .insert({
          course_id: courseId,
          user_id: studentSelfId,
          summary: `Duplicate ${uid}`,
          overall_trend: 'stable',
          evaluation_count: 1,
        });
      expect(error).not.toBeNull();
    });
  });
});
