// Section scoping on evaluations and their derived rows (#1103, part of #1097).
//
// All three tables carried a FOR ALL policy keyed on
// `ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())`. FOR ALL, so
// this was never only a read: a 1Α-restricted instructor could overwrite or
// delete a 1Β student's AI-generated evaluation and competency breakdown.
//
// `student-evaluations.test.ts` exists but gives its fixture a single
// unrestricted instructor, so it keeps passing through every one of these
// changes. These cases are additions, not adaptations.
//
// Two shapes are worth naming, because they are why the fix resolves the
// section through the student rather than through the row:
//
//   * `evaluation_timeline_cache` has no offering column at all — course_id
//     and user_id only — so `can_manage_offering` is not available to it;
//   * `evaluation_competency_scores` has neither, only `evaluation_id`, so it
//     hops to the parent evaluation and applies the same rule to the parent's
//     (course, student).
//
// The competency-score cases below therefore double as a check that the child
// policy is self-sufficient rather than merely inheriting whatever the parent
// happens to expose.

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
  createCourseCompetency,
  createStudentEvaluation,
  createEvaluationCompetencyScore,
  createEvaluationTimelineCache,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

function ids(data: unknown): string[] {
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
}

describe('student evaluations and their derived rows are section-scoped', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let competencyId: string;

  let classAId: string;
  let offeringAId: string;
  let classBId: string;
  let offeringBId: string;

  let instrA: SupabaseClient; // restricted to section A
  let instrB: SupabaseClient; // restricted to section B
  let unrestricted: SupabaseClient;
  let adminClient: SupabaseClient;
  let studentBClient: SupabaseClient;

  let studentAId: string;
  let studentBId: string;

  let evalAId: string;
  let evalBId: string;
  let scoreAId: string;
  let scoreBId: string;
  let timelineAId: string;
  let timelineBId: string;

  // A student sitting in both sections, with an evaluation attributed to B.
  let dualStudentId: string;
  let dualEvalBId: string;
  let dualScoreBId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS EvalSect ${uid}`);
    courseId = await createCourse(admin, institutionId);
    competencyId = await createCourseCompetency(admin, courseId);

    classAId = await createClass(admin, institutionId);
    offeringAId = await createOffering(admin, classAId, courseId);
    classBId = await createClass(admin, institutionId);
    offeringBId = await createOffering(admin, classBId, courseId);

    const a = await createTestUserClient(admin, `rls-ev-a-${uid}@test.local`);
    instrA = a.client;
    userIds.push(a.userId);
    await addUserToInstitution(admin, a.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, a.userId);
    await addSectionRestriction(admin, courseId, classAId, a.userId);

    const b = await createTestUserClient(admin, `rls-ev-b-${uid}@test.local`);
    instrB = b.client;
    userIds.push(b.userId);
    await addUserToInstitution(admin, b.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, b.userId);
    await addSectionRestriction(admin, courseId, classBId, b.userId);

    const u = await createTestUserClient(admin, `rls-ev-u-${uid}@test.local`);
    unrestricted = u.client;
    userIds.push(u.userId);
    await addUserToInstitution(admin, u.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, u.userId);

    const ia = await createTestUserClient(admin, `rls-ev-adm-${uid}@test.local`);
    adminClient = ia.client;
    userIds.push(ia.userId);
    await addUserToInstitution(admin, ia.userId, institutionId, 'admin');

    const sa = await createTestUserClient(admin, `rls-ev-stu-a-${uid}@test.local`);
    studentAId = sa.userId;
    userIds.push(sa.userId);
    await addUserToInstitution(admin, sa.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, sa.userId, 'student');

    const sb = await createTestUserClient(admin, `rls-ev-stu-b-${uid}@test.local`);
    studentBId = sb.userId;
    studentBClient = sb.client;
    userIds.push(sb.userId);
    await addUserToInstitution(admin, sb.userId, institutionId, 'student');
    await enrollInClass(admin, classBId, sb.userId, 'student');

    const dual = await createTestUserClient(admin, `rls-ev-stu-dual-${uid}@test.local`);
    dualStudentId = dual.userId;
    userIds.push(dual.userId);
    await addUserToInstitution(admin, dual.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, dual.userId, 'student');
    await enrollInClass(admin, classBId, dual.userId, 'student');

    evalAId = await createStudentEvaluation(admin, courseId, studentAId, {
      offeringId: offeringAId,
    });
    evalBId = await createStudentEvaluation(admin, courseId, studentBId, {
      offeringId: offeringBId,
    });

    scoreAId = await createEvaluationCompetencyScore(admin, evalAId, competencyId);
    scoreBId = await createEvaluationCompetencyScore(admin, evalBId, competencyId);

    dualEvalBId = await createStudentEvaluation(admin, courseId, dualStudentId, {
      offeringId: offeringBId,
    });
    dualScoreBId = await createEvaluationCompetencyScore(admin, dualEvalBId, competencyId);

    // No offering column on this table at all — course + student only.
    timelineAId = await createEvaluationTimelineCache(admin, courseId, studentAId);
    timelineBId = await createEvaluationTimelineCache(admin, courseId, studentBId);
  });

  afterAll(async () => {
    // CLAUDE.md's "no cleanup" rule is scoped to E2E, where the target is a
    // shared preview branch and the point is to need no privileged credential.
    // The RLS harness is service-role by construction — `getAdminClient()`
    // seeds every fixture row precisely so it can be read back as a role that
    // does not bypass RLS — and runs against a local stack that `db reset`
    // recreates. `cleanupScaffold` is what all the other suites here use.
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---- student_evaluations ------------------------------------------------

  it('each restricted instructor reads only their own section\'s evaluations', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('student_evaluations')
      .select('id')
      .in('id', [evalAId, evalBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([evalAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('student_evaluations')
      .select('id')
      .in('id', [evalAId, evalBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([evalBId]);
  });

  it('an unrestricted instructor and the institution admin read both', async () => {
    const { data: byInstructor } = await unrestricted
      .from('student_evaluations')
      .select('id')
      .in('id', [evalAId, evalBId]);
    expect(ids(byInstructor)).toEqual([evalAId, evalBId].sort());

    const { data: byAdmin } = await adminClient
      .from('student_evaluations')
      .select('id')
      .in('id', [evalAId, evalBId]);
    expect(ids(byAdmin)).toEqual([evalAId, evalBId].sort());
  });

  it('a restricted instructor cannot overwrite another section\'s evaluation', async () => {
    const { error } = await instrA
      .from('student_evaluations')
      .update({ instructor_feedback: 'tampered' })
      .eq('id', evalBId);
    expect(error).toBeNull(); // narrowed to zero rows
    const { data } = await admin
      .from('student_evaluations')
      .select('instructor_feedback')
      .eq('id', evalBId)
      .single();
    expect(data?.instructor_feedback).toBeNull();
  });

  it('a restricted instructor can write their own section\'s evaluation', async () => {
    const { error } = await instrA
      .from('student_evaluations')
      .update({ instructor_feedback: 'well done' })
      .eq('id', evalAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('student_evaluations')
      .select('instructor_feedback')
      .eq('id', evalAId)
      .single();
    expect(data?.instructor_feedback).toBe('well done');
  });

  it('a restricted instructor cannot delete another section\'s evaluation', async () => {
    const { error } = await instrA.from('student_evaluations').delete().eq('id', evalBId);
    expect(error).toBeNull();
    const { data } = await admin.from('student_evaluations').select('id').eq('id', evalBId);
    expect(data).toHaveLength(1);
  });

  it('a restricted instructor cannot create an evaluation for another section', async () => {
    const { error } = await instrA.from('student_evaluations').insert({
      course_id: courseId,
      user_id: studentBId,
      offering_id: offeringBId,
      overall_assessment: 'forged',
    });
    expect(error).not.toBeNull();
  });

  it('a restricted instructor can create an evaluation for their own section', async () => {
    // The control for the case above: the same insert differing only in which
    // student it names has to succeed, or the refusal would be telling us
    // about the row's shape rather than about the section rule.
    const { error } = await instrA.from('student_evaluations').insert({
      course_id: courseId,
      user_id: studentAId,
      offering_id: offeringAId,
      overall_assessment: 'a second, manual evaluation',
    });
    expect(error).toBeNull();
  });

  it('a restricted instructor cannot create an unattributed evaluation', async () => {
    // The insert the Student 360 UI actually issued until the fix for this
    // case: no `offering_id`, because the component never stamped one. Nothing
    // in such a row places it in a section, and the write rule's NULL arm
    // therefore refuses it for anyone the restriction rows confine — which is
    // why generating an AI evaluation failed with "new row violates row-level
    // security policy" for exactly the instructors who are section-restricted,
    // and worked for everyone else.
    const { error } = await instrA.from('student_evaluations').insert({
      course_id: courseId,
      user_id: studentAId,
      overall_assessment: 'unattributed',
    });
    expect(error).not.toBeNull();
  });

  it('an unrestricted instructor may still create an unattributed evaluation', async () => {
    // The other half, and the reason the bug looked intermittent: the NULL arm
    // turns on the restriction rows, not on the row's contents, so the very
    // same insert succeeds for an instructor nothing confines. Without this
    // control the case above would pass just as well against a policy that
    // refused every unattributed evaluation outright.
    const { error } = await unrestricted.from('student_evaluations').insert({
      course_id: courseId,
      user_id: studentAId,
      overall_assessment: 'unattributed, but by an unconfined instructor',
    });
    expect(error).toBeNull();
  });

  // ---- evaluation_competency_scores ---------------------------------------

  it('competency scores follow the section of the parent evaluation', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('evaluation_competency_scores')
      .select('id')
      .in('id', [scoreAId, scoreBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([scoreAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('evaluation_competency_scores')
      .select('id')
      .in('id', [scoreAId, scoreBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([scoreBId]);
  });

  it('a restricted instructor cannot rewrite another section\'s competency score', async () => {
    const { error } = await instrA
      .from('evaluation_competency_scores')
      .update({ score: 1, rationale: 'tampered' })
      .eq('id', scoreBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('evaluation_competency_scores')
      .select('score')
      .eq('id', scoreBId)
      .single();
    expect(data?.score).toBe(75);
  });

  it('a restricted instructor can rewrite their own section\'s competency score', async () => {
    const { error } = await instrA
      .from('evaluation_competency_scores')
      .update({ score: 90 })
      .eq('id', scoreAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('evaluation_competency_scores')
      .select('score')
      .eq('id', scoreAId)
      .single();
    expect(data?.score).toBe(90);
  });

  it('the student still reads their own competency scores', async () => {
    const { data, error } = await studentBClient
      .from('evaluation_competency_scores')
      .select('id')
      .eq('id', scoreBId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // ---- the multi-enrolment case ------------------------------------------

  it('a student in both sections does not expose their section-B evaluation to A', async () => {
    // Deciding an offering-attributed row on the student's enrolments alone
    // would authorise this: the student *is* in section A. The row names its
    // offering, so the offering decides and the fallback never runs.
    const { data: seenByA, error } = await instrA
      .from('student_evaluations')
      .select('id')
      .eq('id', dualEvalBId);
    expect(error).toBeNull();
    expect(seenByA).toHaveLength(0);

    const { data: seenByB } = await instrB
      .from('student_evaluations')
      .select('id')
      .eq('id', dualEvalBId);
    expect(seenByB).toHaveLength(1);
  });

  it('the same holds for the derived competency score', async () => {
    const { data: seenByA } = await instrA
      .from('evaluation_competency_scores')
      .select('id')
      .eq('id', dualScoreBId);
    expect(seenByA).toHaveLength(0);

    const { data: seenByB } = await instrB
      .from('evaluation_competency_scores')
      .select('id')
      .eq('id', dualScoreBId);
    expect(seenByB).toHaveLength(1);
  });

  it('a managed offering cannot be used to forge an evaluation about another section', async () => {
    // The offering arm has to be coherent with the rest of the row. Section A's
    // instructor manages offering A, so without that check, stamping offering A
    // onto an evaluation naming section B's student would pass WITH CHECK —
    // a FOR ALL policy turning a managed offering into a forging primitive.
    const { error } = await instrA.from('student_evaluations').insert({
      course_id: courseId,
      user_id: studentBId,
      offering_id: offeringAId,
      overall_assessment: 'forged through an offering I do manage',
    });
    expect(error).not.toBeNull();
  });

  it('a student leaving the class does not take their evaluation with them', async () => {
    // Reads are on the access rule, not the write rule: enrolment is a fact
    // about now, the evaluation is a fact about then. Gating reads on current
    // enrolment would erase a course's record every time a class list is
    // tidied up at year end.
    const leaver = await createTestUserClient(admin, `rls-ev-stu-leaver-${uid}@test.local`);
    userIds.push(leaver.userId);
    await addUserToInstitution(admin, leaver.userId, institutionId, 'student');
    await enrollInClass(admin, classAId, leaver.userId, 'student');

    const historicEvalId = await createStudentEvaluation(admin, courseId, leaver.userId, {
      offeringId: offeringAId,
    });

    await admin
      .from('class_enrollments')
      .delete()
      .eq('class_id', classAId)
      .eq('user_id', leaver.userId);

    const { data: seenByA, error } = await instrA
      .from('student_evaluations')
      .select('id')
      .eq('id', historicEvalId);
    expect(error).toBeNull();
    expect(seenByA).toHaveLength(1);

    // Still not section B's, though — the row names section A's offering.
    const { data: seenByB } = await instrB
      .from('student_evaluations')
      .select('id')
      .eq('id', historicEvalId);
    expect(seenByB).toHaveLength(0);
  });

  // ---- evaluation_timeline_cache ------------------------------------------

  it('the timeline cache is section-scoped despite having no offering column', async () => {
    const { data: seenByA, error: errA } = await instrA
      .from('evaluation_timeline_cache')
      .select('id')
      .in('id', [timelineAId, timelineBId]);
    expect(errA).toBeNull();
    expect(ids(seenByA)).toEqual([timelineAId]);

    const { data: seenByB, error: errB } = await instrB
      .from('evaluation_timeline_cache')
      .select('id')
      .in('id', [timelineAId, timelineBId]);
    expect(errB).toBeNull();
    expect(ids(seenByB)).toEqual([timelineBId]);
  });

  it('a restricted instructor cannot delete another section\'s timeline cache', async () => {
    const { error } = await instrA
      .from('evaluation_timeline_cache')
      .delete()
      .eq('id', timelineBId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('evaluation_timeline_cache')
      .select('id')
      .eq('id', timelineBId);
    expect(data).toHaveLength(1);
  });

  it('a restricted instructor can delete their own section\'s timeline cache', async () => {
    const { error } = await instrA
      .from('evaluation_timeline_cache')
      .delete()
      .eq('id', timelineAId);
    expect(error).toBeNull();
    const { data } = await admin
      .from('evaluation_timeline_cache')
      .select('id')
      .eq('id', timelineAId);
    expect(data).toHaveLength(0);
  });
});
