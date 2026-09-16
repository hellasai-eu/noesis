// Table under test:
//   public.study_guide_analyses   (cached AI class assessment, #981)
//
// Migration that introduced it:
//   * 20260729090000_study_guide_analyses.sql
//       - "Managers can read study guide analyses"  → can_manage_offering
//       - "Managers can write study guide analyses" → can_manage_offering
//
// Why this table gets its own suite rather than riding on the #977 one: it is
// the ONLY study-guide table that is instructor-only on BOTH sides. Every other
// one has a student-facing SELECT policy, so the natural mistake — copying
// `quiz_analyses`, whose read policy is `has_offering_access(offering_id)` and
// therefore includes enrolled students — would publish a report naming which
// students are struggling with what to the students themselves. The read tests
// below exist to make that mistake fail loudly.
//
// The second property under test is section scoping: `can_manage_offering`
// folds in `course_instructor_sections`, so an instructor restricted to one
// section must not read another section's assessment even though they teach
// the course.

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
  createStudyGuide,
  createOfferingStudyGuide,
  createOfferingGroup,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

/**
 * Insert an analysis row as the service role.
 *
 * Inline rather than in helpers/data.ts because this is the only suite that
 * needs it, and — like `createQuizAnalysis` there — the table is not in the
 * generated types yet, so it carries a cast.
 */
async function createStudyGuideAnalysis(
  admin: SupabaseClient,
  studyGuideId: string,
  offeringId: string,
  opts: {
    report?: Record<string, unknown>;
    submissionCount?: number;
    groupId?: string | null;
  } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('study_guide_analyses' as never)
    .insert({
      study_guide_id: studyGuideId,
      offering_id: offeringId,
      group_id: opts.groupId ?? null,
      report: opts.report ?? { summary: 'RLS test assessment' },
      submission_count: opts.submissionCount ?? 3,
    })
    .select('id')
    .single();
  if (error) throw new Error(`createStudyGuideAnalysis: ${error.message}`);
  return (data as { id: string }).id;
}

describe('study_guide_analyses RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let guideId: string;

  // Two sections of the same course. The restricted instructor teaches only
  // section A.
  let classAId: string;
  let offeringAId: string;
  let classBId: string;
  let offeringBId: string;

  let analysisAId: string;
  let analysisBId: string;

  let instructorClient: SupabaseClient; // unrestricted — teaches both sections
  let restrictedClient: SupabaseClient; // restricted to section A
  let studentClient: SupabaseClient; // enrolled in section A
  let outsiderClient: SupabaseClient; // in the institution, not on the course

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS SGA ${uid}`);
    courseId = await createCourse(admin, institutionId);

    classAId = await createClass(admin, institutionId);
    offeringAId = await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    offeringBId = await createOffering(admin, classBId, courseId);

    guideId = await createStudyGuide(admin, courseId, { title: `SGA guide ${uid}` });
    await createOfferingStudyGuide(admin, offeringAId, guideId, { groupId: null, published: true });
    await createOfferingStudyGuide(admin, offeringBId, guideId, { groupId: null, published: true });

    const inst = await createTestUserClient(admin, `rls-sga-inst-${uid}@test.local`);
    instructorClient = inst.client;
    userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const restricted = await createTestUserClient(admin, `rls-sga-restr-${uid}@test.local`);
    restrictedClient = restricted.client;
    userIds.push(restricted.userId);
    await addUserToInstitution(admin, restricted.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, restricted.userId);
    await addSectionRestriction(admin, courseId, classAId, restricted.userId);

    const stu = await createTestUserClient(admin, `rls-sga-stu-${uid}@test.local`);
    studentClient = stu.client;
    userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, stu.userId, 'student');

    const outsider = await createTestUserClient(admin, `rls-sga-out-${uid}@test.local`);
    outsiderClient = outsider.client;
    userIds.push(outsider.userId);
    await addUserToInstitution(admin, outsider.userId, institutionId, 'instructor');

    analysisAId = await createStudyGuideAnalysis(admin, guideId, offeringAId);
    analysisBId = await createStudyGuideAnalysis(admin, guideId, offeringBId);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---- SELECT -------------------------------------------------------------

  it('the course instructor reads the assessment for every section they teach', async () => {
    const { data, error } = await instructorClient
      .from('study_guide_analyses' as never)
      .select('id')
      .in('id', [analysisAId, analysisBId]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it('a section-restricted instructor reads only their own section', async () => {
    const { data, error } = await restrictedClient
      .from('study_guide_analyses' as never)
      .select('id')
      .in('id', [analysisAId, analysisBId]);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((data as Array<{ id: string }>)[0].id).toBe(analysisAId);
  });

  it('an enrolled student cannot read the assessment for their own class', async () => {
    // The copy-quiz_analyses mistake: its read policy is has_offering_access,
    // which enrolled students satisfy. This report names weaknesses per class
    // and is instructor-only by design.
    const { data, error } = await studentClient
      .from('study_guide_analyses' as never)
      .select('id')
      .eq('id', analysisAId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an instructor who does not teach the course reads nothing', async () => {
    const { data, error } = await outsiderClient
      .from('study_guide_analyses' as never)
      .select('id')
      .in('id', [analysisAId, analysisBId]);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  // ---- INSERT / UPDATE / DELETE ------------------------------------------

  it('a section-restricted instructor cannot write an assessment for another section', async () => {
    const { error } = await restrictedClient
      .from('study_guide_analyses' as never)
      .insert({
        study_guide_id: guideId,
        offering_id: offeringBId,
        report: { summary: 'should be refused' },
        submission_count: 3,
      });
    expect(error).not.toBeNull();
  });

  it('a student cannot forge an assessment', async () => {
    const { error } = await studentClient
      .from('study_guide_analyses' as never)
      .insert({
        study_guide_id: guideId,
        offering_id: offeringAId,
        report: { summary: 'forged' },
        submission_count: 99,
      });
    expect(error).not.toBeNull();
  });

  it('a student cannot delete an assessment', async () => {
    const { error } = await studentClient
      .from('study_guide_analyses' as never)
      .delete()
      .eq('id', analysisAId);
    // RLS turns an unauthorized DELETE into a no-op rather than an error, so
    // the row still being there is the assertion that matters.
    expect(error).toBeNull();
    const { data } = await admin
      .from('study_guide_analyses' as never)
      .select('id')
      .eq('id', analysisAId);
    expect(data).toHaveLength(1);
  });

  it('the course instructor can update the assessment for a section they teach', async () => {
    const { error } = await instructorClient
      .from('study_guide_analyses' as never)
      .update({ report: { summary: 'edited by the instructor' } })
      .eq('id', analysisAId);
    expect(error).toBeNull();

    const { data } = await admin
      .from('study_guide_analyses' as never)
      .select('report')
      .eq('id', analysisAId)
      .single();
    expect((data as { report: { summary: string } }).report.summary).toBe(
      'edited by the instructor'
    );
  });

  // ---- Scope key ----------------------------------------------------------

  it('holds one assessment per (study guide, offering, scope)', async () => {
    // The whole-class slot must be a SINGLE row, not one per refresh — hence
    // NULLS NOT DISTINCT on the unique index. Without it, `group_id IS NULL`
    // rows never collide and every regeneration appends another.
    const { error } = await admin.from('study_guide_analyses' as never).insert({
      study_guide_id: guideId,
      offering_id: offeringAId,
      group_id: null,
      report: { summary: 'duplicate whole-class row' },
      submission_count: 1,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/duplicate key|unique/i);
  });

  it('keeps a group-scoped assessment separate from the whole-class one', async () => {
    // The bug this guards: a report about one group is not a report about the
    // class, and the panel cannot tell them apart from the row alone. Sharing a
    // slot let a group refresh overwrite the whole-class report and relabel one
    // cohort's weaknesses as everyone's.
    const groupId = await createOfferingGroup(admin, offeringAId, { name: `SGA grp ${uid}` });
    const groupAnalysisId = await createStudyGuideAnalysis(admin, guideId, offeringAId, {
      groupId,
      report: { summary: 'group scope' },
    });
    expect(groupAnalysisId).not.toBe(analysisAId);

    const { data } = await admin
      .from('study_guide_analyses' as never)
      .select('id, group_id')
      .eq('study_guide_id', guideId)
      .eq('offering_id', offeringAId);
    expect(data).toHaveLength(2);

    // And the group row is readable by the instructor who manages the section.
    const { data: seen, error } = await instructorClient
      .from('study_guide_analyses' as never)
      .select('id')
      .eq('id', groupAnalysisId);
    expect(error).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('refuses a group that belongs to a different offering', async () => {
    // Composite FK on (group_id, offering_id): without it, an assessment could
    // name a group from a class the row does not belong to.
    const foreignGroupId = await createOfferingGroup(admin, offeringBId, {
      name: `SGA foreign ${uid}`,
    });
    const { error } = await admin.from('study_guide_analyses' as never).insert({
      study_guide_id: guideId,
      offering_id: offeringAId,
      group_id: foreignGroupId,
      report: { summary: 'cross-offering group' },
      submission_count: 3,
    });
    expect(error).not.toBeNull();
  });
});
