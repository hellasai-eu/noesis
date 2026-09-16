// Tables under test:
//   * public.open_answer_ai_drafts   (new with the removal of AI grading)
//   * public.study_guide_answers     (the manager UPDATE policy added then)
//
// The drafts table exists for exactly one reason: the AI's qualitative review
// notes must NOT be readable by the student they are about. Students can
// SELECT their own rows on `open_question_grades` and `study_guide_answers`,
// so anything stored there is student-visible at the API layer — the draft
// therefore lives here, with manager-only SELECT and no student policy at
// all. These tests pin that boundary.
//
// The second half pins the manager UPDATE policy on `study_guide_answers`:
// with AI grading removed, the instructor is the grader and needs a client
// write path for the grading columns — and nobody else may have one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createOpenTypeQuestion,
  createStudyGuide,
  createStudyGuidePiece,
  createStudyGuideAnswer,
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  addSectionRestriction,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('open_answer_ai_drafts + study_guide_answers manual grading RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let instA: string;
  let courseA: string;
  let classA: string;
  let offeringA: string;
  let questionA: string;

  let instB: string;
  let courseB: string;

  let draftId: string;
  let guideAnswerId: string;

  let studentClient: SupabaseClient;
  let studentId: string;
  let peerClient: SupabaseClient;
  let instructorClient: SupabaseClient; // assigned to courseA
  let sectionRestrictedClient: SupabaseClient; // assigned to courseA, other section only
  let unassignedInstructorClient: SupabaseClient; // same institution, no course
  let adminAClient: SupabaseClient;
  let outsiderInstructorClient: SupabaseClient; // institution B

  const userIds: string[] = [];

  beforeAll(async () => {
    instA = await createInstitution(admin, `RLS Drafts A ${uid}`);
    courseA = await createCourse(admin, instA);
    classA = await createClass(admin, instA);
    offeringA = await createOffering(admin, classA, courseA);
    questionA = await createOpenTypeQuestion(admin, courseA);

    instB = await createInstitution(admin, `RLS Drafts B ${uid}`);
    courseB = await createCourse(admin, instB);

    const stu = await createTestUserClient(admin, `rls-draft-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, instA, 'student');
    await enrollInClass(admin, classA, stu.userId, 'student');

    const peer = await createTestUserClient(admin, `rls-draft-peer-${uid}@test.local`);
    peerClient = peer.client; userIds.push(peer.userId);
    await addUserToInstitution(admin, peer.userId, instA, 'student');
    await enrollInClass(admin, classA, peer.userId, 'student');

    const instr = await createTestUserClient(admin, `rls-draft-instr-${uid}@test.local`);
    instructorClient = instr.client; userIds.push(instr.userId);
    await addUserToInstitution(admin, instr.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, instr.userId);

    // Restricted to a section (class) that is NOT the one offeringA teaches
    // — `can_manage_offering` must refuse them.
    const otherClass = await createClass(admin, instA);
    const restricted = await createTestUserClient(admin, `rls-draft-restricted-${uid}@test.local`);
    sectionRestrictedClient = restricted.client; userIds.push(restricted.userId);
    await addUserToInstitution(admin, restricted.userId, instA, 'instructor');
    await assignCourseInstructor(admin, courseA, restricted.userId);
    await addSectionRestriction(admin, courseA, otherClass, restricted.userId);

    const unassigned = await createTestUserClient(admin, `rls-draft-unassigned-${uid}@test.local`);
    unassignedInstructorClient = unassigned.client; userIds.push(unassigned.userId);
    await addUserToInstitution(admin, unassigned.userId, instA, 'instructor');

    const adm = await createTestUserClient(admin, `rls-draft-admin-${uid}@test.local`);
    adminAClient = adm.client; userIds.push(adm.userId);
    await addUserToInstitution(admin, adm.userId, instA, 'admin');

    const outInstr = await createTestUserClient(admin, `rls-draft-out-${uid}@test.local`);
    outsiderInstructorClient = outInstr.client; userIds.push(outInstr.userId);
    await addUserToInstitution(admin, outInstr.userId, instB, 'instructor');
    await assignCourseInstructor(admin, courseB, outInstr.userId);

    // The draft the whole suite revolves around: AI review notes about the
    // student's answer, written by the service role.
    const { data: draft, error: draftError } = await admin
      .from('open_answer_ai_drafts')
      .insert({
        question_id: questionA,
        user_id: studentId,
        course_id: courseA,
        offering_id: offeringA,
        source: 'practice',
        feedback: 'Draft feedback the student must never read',
        strengths: ['clear'],
        areas_for_improvement: ['depth'],
      })
      .select('id')
      .single();
    if (draftError) throw new Error(`draft insert: ${draftError.message}`);
    draftId = draft.id;

    // A pending open study-guide answer (recorded ungraded) for the manual
    // grading tests.
    const guideId = await createStudyGuide(admin, courseA);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    guideAnswerId = await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId: offeringA,
      pieceId,
      questionId: questionA,
      submission: { open_text: 'the answer' },
      isCorrect: null,
    });
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId: instB });
    await cleanupScaffold(admin, { institutionId: instA, userIds });
  });

  // =====================================================================
  // open_answer_ai_drafts — manager-only, invisible to the subject
  // =====================================================================

  it('the student the draft is about cannot read it', async () => {
    const { data, error } = await studentClient
      .from('open_answer_ai_drafts').select('id').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('a classmate cannot read it either', async () => {
    const { data, error } = await peerClient
      .from('open_answer_ai_drafts').select('id').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('the assigned instructor reads the draft', async () => {
    const { data, error } = await instructorClient
      .from('open_answer_ai_drafts').select('id, feedback').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('an institution admin reads the draft', async () => {
    const { data, error } = await adminAClient
      .from('open_answer_ai_drafts').select('id').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('a section-restricted instructor cannot read drafts about another section', async () => {
    const { data, error } = await sectionRestrictedClient
      .from('open_answer_ai_drafts').select('id').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an instructor with no assignment to the course cannot read it', async () => {
    const { data, error } = await unassignedInstructorClient
      .from('open_answer_ai_drafts').select('id').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an instructor from another institution cannot read it', async () => {
    const { data, error } = await outsiderInstructorClient
      .from('open_answer_ai_drafts').select('id').eq('id', draftId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('a student cannot insert a draft', async () => {
    const { error } = await studentClient
      .from('open_answer_ai_drafts')
      .insert({
        question_id: questionA,
        user_id: studentId,
        course_id: courseA,
        source: 'practice',
        feedback: 'forged draft',
      });
    expect(error).not.toBeNull();
  });

  it('nobody updates or deletes drafts from the client — not even managers', async () => {
    // Written exclusively by the service role; there are no UPDATE/DELETE
    // policies, so RLS declines by matching no rows.
    const { data: updated, error: updateError } = await instructorClient
      .from('open_answer_ai_drafts')
      .update({ feedback: 'edited' })
      .eq('id', draftId)
      .select('id');
    expect(updateError).toBeNull();
    expect(updated).toHaveLength(0);

    const { data: deleted, error: deleteError } = await instructorClient
      .from('open_answer_ai_drafts')
      .delete()
      .eq('id', draftId)
      .select('id');
    expect(deleteError).toBeNull();
    expect(deleted).toHaveLength(0);
  });

  // =====================================================================
  // study_guide_answers — the manager grading path
  // =====================================================================

  it('the assigned instructor grades a pending open answer', async () => {
    const { data, error } = await instructorClient
      .from('study_guide_answers')
      .update({ grade: 72, feedback: 'Solid, expand the second part', graded_at: new Date().toISOString() })
      .eq('id', guideAnswerId)
      .select('id, grade');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].grade).toBe(72);
  });

  it('the student cannot grade their own answer', async () => {
    const { data, error } = await studentClient
      .from('study_guide_answers')
      .update({ grade: 100 })
      .eq('id', guideAnswerId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('an instructor from another institution cannot grade it', async () => {
    const { data, error } = await outsiderInstructorClient
      .from('study_guide_answers')
      .update({ grade: 1 })
      .eq('id', guideAnswerId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('even a manager cannot rewrite the immutable submission columns', async () => {
    // RLS cannot scope an UPDATE to columns; the grading-columns-only trigger
    // is what keeps the student's answer and its attribution immutable.
    const { error: submissionError } = await instructorClient
      .from('study_guide_answers')
      .update({ submission: { open_text: 'forged answer' } })
      .eq('id', guideAnswerId);
    expect(submissionError).not.toBeNull();
    expect(submissionError!.message).toContain('only the grading columns');

    const { error: reassignError } = await instructorClient
      .from('study_guide_answers')
      .update({ user_id: crypto.randomUUID() })
      .eq('id', guideAnswerId);
    expect(reassignError).not.toBeNull();
  });
});
