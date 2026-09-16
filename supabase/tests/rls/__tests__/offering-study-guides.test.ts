// Tables under test:
//   public.offering_study_guides   (assignment junction)
//   public.study_guides            (the guide itself)
//   public.study_guide_pieces      (ordered theory + question groupings)
//   public.study_guide_piece_questions
//   public.study_guide_progress
//   public.study_guide_answers
//
// Migration that introduced these:
//   * 20260727120000_study_guides.sql (#977)
//       - CREATE TABLE for all of the above
//       - study_guide_published_to_user(uuid) helper, used by the student-side
//         SELECT policies on the content tables
//       - "Managers can manage offering study guides" / "Students see published
//         study guides", mirroring the group predicate established in
//         20260603100000_add_offering_groups.sql:
//           published_at IS NOT NULL
//           AND has_offering_access(offering_id)
//           AND (group_id IS NULL OR is_offering_group_member(group_id))
//       - Individual (is_individual = true) groups per 20260604010000 are used
//         for per-student targeting.

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
  addUserToInstitution,
  enrollInClass,
  assignCourseInstructor,
  createStudyGuide,
  createStudyGuidePiece,
  addStudyGuidePieceQuestion,
  createOfferingStudyGuide,
  createStudyGuideAnswer,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('study guides RLS', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;

  // One guide per assignment shape, so visibility can be asserted independently.
  let guideWholeClass: string;
  let guideGroup: string;
  let guideIndividual: string;
  let guideUnpublished: string;

  let wholeClassPubRowId: string;
  let groupTargetedPubRowId: string;
  let individualTargetedPubRowId: string;
  let unpublishedRowId: string;

  let groupId: string;
  let individualGroupId: string;

  // Same course, same student, but no guide ever assigned to it.
  let unassignedClassId: string;
  let unassignedOfferingId: string;

  // Pieces + questions belonging to the whole-class guide and the unpublished one.
  let wholeClassPieceId: string;
  let wholeClassQuestionId: string;
  let unpublishedPieceId: string;
  let unpublishedQuestionId: string;

  let instructorClient: SupabaseClient;
  let groupMemberClient: SupabaseClient;
  let groupMemberId: string;
  let nonMemberClient: SupabaseClient;
  let nonMemberId: string;
  let studentClient: SupabaseClient; // generic enrolled student
  let studentId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS SG ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    guideWholeClass = await createStudyGuide(admin, courseId, { title: `SG whole ${uid}` });
    guideGroup = await createStudyGuide(admin, courseId, { title: `SG group ${uid}` });
    guideIndividual = await createStudyGuide(admin, courseId, { title: `SG indiv ${uid}` });
    guideUnpublished = await createStudyGuide(admin, courseId, { title: `SG unpub ${uid}` });

    const inst = await createTestUserClient(admin, `rls-sg-inst-${uid}@test.local`);
    instructorClient = inst.client; userIds.push(inst.userId);
    await addUserToInstitution(admin, inst.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, inst.userId);

    const m = await createTestUserClient(admin, `rls-sg-mem-${uid}@test.local`);
    groupMemberClient = m.client; groupMemberId = m.userId; userIds.push(m.userId);
    await addUserToInstitution(admin, m.userId, institutionId, 'student');
    await enrollInClass(admin, classId, m.userId, 'student');

    const nm = await createTestUserClient(admin, `rls-sg-nonmem-${uid}@test.local`);
    nonMemberClient = nm.client; nonMemberId = nm.userId; userIds.push(nm.userId);
    await addUserToInstitution(admin, nm.userId, institutionId, 'student');
    await enrollInClass(admin, classId, nm.userId, 'student');

    const stu = await createTestUserClient(admin, `rls-sg-stu-${uid}@test.local`);
    studentClient = stu.client; studentId = stu.userId; userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');

    groupId = await createOfferingGroup(admin, offeringId, { name: `SG group ${uid}` });
    await addOfferingGroupMember(admin, groupId, groupMemberId);

    individualGroupId = await createOfferingGroup(admin, offeringId, {
      name: `Individual ${groupMemberId}`,
      isIndividual: true,
      ownerUserId: groupMemberId,
    });
    await addOfferingGroupMember(admin, individualGroupId, groupMemberId);

    wholeClassPubRowId = await createOfferingStudyGuide(admin, offeringId, guideWholeClass, {
      groupId: null,
      published: true,
    });
    groupTargetedPubRowId = await createOfferingStudyGuide(admin, offeringId, guideGroup, {
      groupId,
      published: true,
    });
    individualTargetedPubRowId = await createOfferingStudyGuide(admin, offeringId, guideIndividual, {
      groupId: individualGroupId,
      published: true,
    });
    unpublishedRowId = await createOfferingStudyGuide(admin, offeringId, guideUnpublished, {
      groupId: null,
      published: false,
    });

    // A second section of the same course that the generic student is also
    // enrolled in, but which no guide is assigned to. Used to prove that
    // progress/answers cannot be filed against an offering the guide was
    // never published to.
    unassignedClassId = await createClass(admin, institutionId);
    unassignedOfferingId = await createOffering(admin, unassignedClassId, courseId);
    await enrollInClass(admin, unassignedClassId, studentId, 'student');

    wholeClassPieceId = await createStudyGuidePiece(admin, guideWholeClass, 0);
    wholeClassQuestionId = await createQuestion(admin, courseId);
    await addStudyGuidePieceQuestion(admin, wholeClassPieceId, wholeClassQuestionId, 0);

    unpublishedPieceId = await createStudyGuidePiece(admin, guideUnpublished, 0);
    unpublishedQuestionId = await createQuestion(admin, courseId);
    await addStudyGuidePieceQuestion(admin, unpublishedPieceId, unpublishedQuestionId, 0);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---- offering_study_guides: SELECT -------------------------------------

  it('every enrolled student sees a whole-class published row', async () => {
    for (const client of [groupMemberClient, nonMemberClient, studentClient]) {
      const { data, error } = await client
        .from('offering_study_guides').select('id').eq('id', wholeClassPubRowId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }
  });

  it('group member sees a group-targeted published row', async () => {
    const { data, error } = await groupMemberClient
      .from('offering_study_guides').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('non-member enrolled student does not see a group-targeted published row', async () => {
    const { data, error } = await nonMemberClient
      .from('offering_study_guides').select('id').eq('id', groupTargetedPubRowId);
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    expect(nonMemberId).toBeTruthy();
  });

  it('individually targeted row visible to the singleton-group owner only', async () => {
    const { data: ownerSees } = await groupMemberClient
      .from('offering_study_guides').select('id').eq('id', individualTargetedPubRowId);
    expect(ownerSees).toHaveLength(1);

    const { data: peerSees } = await nonMemberClient
      .from('offering_study_guides').select('id').eq('id', individualTargetedPubRowId);
    expect(peerSees).toHaveLength(0);
  });

  it('unpublished row is invisible to students', async () => {
    for (const client of [groupMemberClient, studentClient]) {
      const { data } = await client
        .from('offering_study_guides').select('id').eq('id', unpublishedRowId);
      expect(data).toHaveLength(0);
    }
  });

  it('assigned instructor sees every row including unpublished', async () => {
    const { data, error } = await instructorClient
      .from('offering_study_guides').select('id').eq('offering_id', offeringId);
    expect(error).toBeNull();
    const ids = new Set((data ?? []).map((r) => (r as { id: string }).id));
    // Asserted by membership rather than an exact count: later tests in this
    // file insert further rows into the same offering.
    expect(ids).toContain(wholeClassPubRowId);
    expect(ids).toContain(groupTargetedPubRowId);
    expect(ids).toContain(individualTargetedPubRowId);
    expect(ids).toContain(unpublishedRowId);
  });

  // ---- offering_study_guides: write --------------------------------------

  it('assigned instructor can publish a guide whole-class', async () => {
    const g = await createStudyGuide(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_study_guides')
      .insert({
        offering_id: offeringId,
        study_guide_id: g,
        published_at: new Date().toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('assigned instructor can publish a guide to a group with a due date', async () => {
    const g = await createStudyGuide(admin, courseId);
    const { data, error } = await instructorClient
      .from('offering_study_guides')
      .insert({
        offering_id: offeringId,
        study_guide_id: g,
        group_id: groupId,
        published_at: new Date().toISOString(),
        due_date: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot insert an offering_study_guides row', async () => {
    const g = await createStudyGuide(admin, courseId);
    const { error } = await groupMemberClient
      .from('offering_study_guides')
      .insert({
        offering_id: offeringId,
        study_guide_id: g,
        published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  it('student cannot delete an offering_study_guides row', async () => {
    const { data } = await groupMemberClient
      .from('offering_study_guides').delete().eq('id', wholeClassPubRowId).select();
    expect(data).toHaveLength(0);
  });

  // A group belonging to a different offering must be rejected by the
  // composite (group_id, offering_id) FK, not silently accepted.
  it('rejects a group from a different offering', async () => {
    const otherClassId = await createClass(admin, institutionId);
    const otherOfferingId = await createOffering(admin, otherClassId, courseId);
    const foreignGroupId = await createOfferingGroup(admin, otherOfferingId, {
      name: `Foreign ${uid}`,
    });
    const g = await createStudyGuide(admin, courseId);

    const { error } = await admin
      .from('offering_study_guides' as never)
      .insert({
        offering_id: offeringId,
        study_guide_id: g,
        group_id: foreignGroupId,
        published_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  // A guide from another course must not be publishable into this offering —
  // otherwise students get content from a course they are not taking.
  it('rejects publishing a guide that belongs to a different course', async () => {
    const otherCourseId = await createCourse(admin, institutionId);
    const foreignGuideId = await createStudyGuide(admin, otherCourseId);

    const { error: instructorError } = await instructorClient
      .from('offering_study_guides')
      .insert({
        offering_id: offeringId,
        study_guide_id: foreignGuideId,
        published_at: new Date().toISOString(),
      });
    expect(instructorError).not.toBeNull();

    // Also enforced below RLS, so a service-role writer cannot slip past it.
    const { error: adminError } = await admin
      .from('offering_study_guides' as never)
      .insert({
        offering_id: offeringId,
        study_guide_id: foreignGuideId,
        published_at: new Date().toISOString(),
      });
    expect(adminError).not.toBeNull();
  });

  // ---- study_guides / pieces / piece_questions ---------------------------

  it('student sees a guide published to them and not one that is unpublished', async () => {
    const { data: visible } = await studentClient
      .from('study_guides').select('id').eq('id', guideWholeClass);
    expect(visible).toHaveLength(1);

    const { data: hidden } = await studentClient
      .from('study_guides').select('id').eq('id', guideUnpublished);
    expect(hidden).toHaveLength(0);
  });

  it('student does not see a guide targeted at a group they are not in', async () => {
    const { data } = await nonMemberClient
      .from('study_guides').select('id').eq('id', guideGroup);
    expect(data).toHaveLength(0);
  });

  it('student sees pieces and piece questions of a published guide only', async () => {
    const { data: pieces } = await studentClient
      .from('study_guide_pieces').select('id').eq('id', wholeClassPieceId);
    expect(pieces).toHaveLength(1);

    const { data: pieceQuestions } = await studentClient
      .from('study_guide_piece_questions').select('question_id').eq('piece_id', wholeClassPieceId);
    expect(pieceQuestions).toHaveLength(1);

    const { data: hiddenPieces } = await studentClient
      .from('study_guide_pieces').select('id').eq('id', unpublishedPieceId);
    expect(hiddenPieces).toHaveLength(0);

    const { data: hiddenPieceQuestions } = await studentClient
      .from('study_guide_piece_questions').select('question_id').eq('piece_id', unpublishedPieceId);
    expect(hiddenPieceQuestions).toHaveLength(0);
    expect(unpublishedQuestionId).toBeTruthy();
  });

  it('student cannot edit a piece', async () => {
    const { data } = await studentClient
      .from('study_guide_pieces')
      .update({ theory_html: '<p>tampered</p>' })
      .eq('id', wholeClassPieceId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('instructor can edit a piece', async () => {
    const { data, error } = await instructorClient
      .from('study_guide_pieces')
      .update({ theory_html: '<p>edited by instructor</p>' })
      .eq('id', wholeClassPieceId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('source chapters are instructor-only', async () => {
    const { data } = await studentClient
      .from('study_guide_source_chapters').select('chapter_id').eq('study_guide_id', guideWholeClass);
    expect(data).toHaveLength(0);
  });

  // ---- study_guide_progress ----------------------------------------------

  it('student can create and read their own progress row', async () => {
    const { data, error } = await studentClient
      .from('study_guide_progress')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        current_piece_position: 0,
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot create a progress row for someone else', async () => {
    const { error } = await nonMemberClient
      .from('study_guide_progress')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        current_piece_position: 0,
      });
    expect(error).not.toBeNull();
  });

  it('student cannot create a progress row for an unpublished guide', async () => {
    const { error } = await studentClient
      .from('study_guide_progress')
      .insert({
        user_id: studentId,
        study_guide_id: guideUnpublished,
        offering_id: offeringId,
        current_piece_position: 0,
      });
    expect(error).not.toBeNull();
  });

  // `offering_id` is independent of `study_guide_id`, so an assigned student
  // must not be able to file progress against a different section — that would
  // surface them in the results of a class the guide was never assigned to.
  it('student cannot file progress against an offering the guide is not assigned to', async () => {
    const { error } = await studentClient
      .from('study_guide_progress')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: unassignedOfferingId,
        current_piece_position: 0,
      });
    expect(error).not.toBeNull();
    expect(unassignedClassId).toBeTruthy();
  });

  it('student cannot file an answer against an offering the guide is not assigned to', async () => {
    const q = await createQuestion(admin, courseId);
    await addStudyGuidePieceQuestion(admin, wholeClassPieceId, q, 3);
    const { error } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: unassignedOfferingId,
        piece_id: wholeClassPieceId,
        question_id: q,
        submission: { selected_indices: [0] },
      });
    expect(error).not.toBeNull();
  });

  it("student cannot read another student's progress", async () => {
    const { data } = await nonMemberClient
      .from('study_guide_progress').select('id').eq('user_id', studentId);
    expect(data).toHaveLength(0);
  });

  it('instructor sees student progress for their offering', async () => {
    const { data, error } = await instructorClient
      .from('study_guide_progress').select('id').eq('offering_id', offeringId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  // ---- study_guide_answers -----------------------------------------------

  it('student can submit their own answer for a published guide', async () => {
    const { data, error } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: wholeClassPieceId,
        question_id: wholeClassQuestionId,
        submission: { selected_indices: [0] },
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  it('student cannot submit an answer as another user', async () => {
    const q = await createQuestion(admin, courseId);
    await addStudyGuidePieceQuestion(admin, wholeClassPieceId, q, 1);
    const { error } = await nonMemberClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: wholeClassPieceId,
        question_id: q,
        submission: { selected_indices: [0] },
      });
    expect(error).not.toBeNull();
  });

  it('student cannot submit an answer for an unpublished guide', async () => {
    const { error } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideUnpublished,
        offering_id: offeringId,
        piece_id: unpublishedPieceId,
        question_id: unpublishedQuestionId,
        submission: { selected_indices: [0] },
      });
    expect(error).not.toBeNull();
  });

  // Answers are immutable once submitted — there is deliberately no UPDATE or
  // DELETE policy for students, so a tamper attempt must affect zero rows.
  it('student cannot update their own submitted answer', async () => {
    const answerId = await createStudyGuideAnswer(admin, {
      userId: groupMemberId,
      studyGuideId: guideWholeClass,
      offeringId,
      pieceId: wholeClassPieceId,
      questionId: await createQuestion(admin, courseId),
    });
    const { data } = await groupMemberClient
      .from('study_guide_answers')
      .update({ is_correct: true, grade: 100 })
      .eq('id', answerId)
      .select();
    expect(data).toHaveLength(0);
  });

  it('student cannot delete their own submitted answer', async () => {
    const answerId = await createStudyGuideAnswer(admin, {
      userId: groupMemberId,
      studyGuideId: guideWholeClass,
      offeringId,
      pieceId: wholeClassPieceId,
      questionId: await createQuestion(admin, courseId),
    });
    const { data } = await groupMemberClient
      .from('study_guide_answers').delete().eq('id', answerId).select();
    expect(data).toHaveLength(0);
  });

  // Grading columns must be NULL on a student insert. Service-role grading
  // bypassing RLS is not enough on its own — without the WITH CHECK predicates
  // a student could post their own grade and have it shown to instructors.
  it('student cannot submit forged grading fields', async () => {
    const forgeries: Array<Record<string, unknown>> = [
      { is_correct: true },
      { grade: 100 },
      { feedback: 'A+ from me' },
      { strengths: ['everything'] },
      { areas_for_improvement: [] },
      { graded_at: new Date().toISOString() },
    ];
    for (const forged of forgeries) {
      // A distinct question per attempt: reusing one would let a *successful*
      // first insert mask the rest behind the (user, offering, question)
      // unique constraint, and the test would pass vacuously.
      const q = await createQuestion(admin, courseId);
      await addStudyGuidePieceQuestion(admin, wholeClassPieceId, q, 100);
      const { error } = await studentClient
        .from('study_guide_answers')
        .insert({
          user_id: studentId,
          study_guide_id: guideWholeClass,
          offering_id: offeringId,
          piece_id: wholeClassPieceId,
          question_id: q,
          submission: { selected_indices: [0] },
          ...forged,
        });
      expect(error, `forged ${Object.keys(forged)[0]} should be rejected`).not.toBeNull();

      // Positive control: the same insert without the forged column succeeds,
      // proving the rejection above is caused by the grading field and not by
      // some unrelated policy or constraint.
      const { error: cleanError } = await studentClient
        .from('study_guide_answers')
        .insert({
          user_id: studentId,
          study_guide_id: guideWholeClass,
          offering_id: offeringId,
          piece_id: wholeClassPieceId,
          question_id: q,
          submission: { selected_indices: [0] },
        });
      expect(cleanError, `clean insert for ${Object.keys(forged)[0]} should succeed`).toBeNull();
    }
  });

  it('rejects an answer whose piece belongs to a different guide', async () => {
    const q = await createQuestion(admin, courseId);
    const { error } = await admin
      .from('study_guide_answers' as never)
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: unpublishedPieceId, // belongs to guideUnpublished
        question_id: q,
        submission: { selected_indices: [0] },
      });
    expect(error).not.toBeNull();
  });

  it('rejects an answer whose question is not part of the named piece', async () => {
    // A real question on the same course, deliberately not linked to the piece.
    const strayQuestion = await createQuestion(admin, courseId);
    const { error } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: wholeClassPieceId,
        question_id: strayQuestion,
        submission: { selected_indices: [0] },
      });
    expect(error).not.toBeNull();

    // Linking it makes the identical insert succeed — proving the rejection
    // came from the missing piece-question link, not something else.
    await addStudyGuidePieceQuestion(admin, wholeClassPieceId, strayQuestion, 200);
    const { error: afterLink } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: wholeClassPieceId,
        question_id: strayQuestion,
        submission: { selected_indices: [0] },
      });
    expect(afterLink).toBeNull();
  });

  it("student cannot read another student's answers", async () => {
    const { data } = await nonMemberClient
      .from('study_guide_answers').select('id').eq('user_id', studentId);
    expect(data).toHaveLength(0);
  });

  it('instructor sees all answers for their offering', async () => {
    const { data, error } = await instructorClient
      .from('study_guide_answers').select('id').eq('offering_id', offeringId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  // ---- closure (closed_at, 20260910120000) --------------------------------
  //
  // Marking an assignment done sets `closed_at`, which
  // `study_guide_assigned_in_offering` now requires to be NULL: students can
  // no longer submit answers or advance progress, but everything they could
  // READ before stays readable — the guide, their answers, their results.
  // These run last in the file on purpose: they mutate the whole-class row.

  it('closing an assignment blocks new answers but keeps everything readable', async () => {
    const { error: closeErr } = await admin
      .from('offering_study_guides')
      .update({ closed_at: new Date().toISOString() })
      .eq('id', wholeClassPubRowId);
    expect(closeErr).toBeNull();

    const q = await createQuestion(admin, courseId);
    await addStudyGuidePieceQuestion(admin, wholeClassPieceId, q, 8);
    const { error } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: wholeClassPieceId,
        question_id: q,
        submission: { selected_indices: [0] },
      });
    expect(error).not.toBeNull();

    // Visibility is untouched: the guide and the student's own earlier answer
    // are still there to review.
    const { data: guides } = await studentClient
      .from('study_guides').select('id').eq('id', guideWholeClass);
    expect(guides).toHaveLength(1);
    const { data: answers } = await studentClient
      .from('study_guide_answers').select('id').eq('user_id', studentId);
    expect((answers ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('closing an assignment blocks progress writes', async () => {
    // The FOR ALL policy's WITH CHECK re-evaluates on UPDATE, so advancing an
    // existing progress row is refused too, not just creating one.
    const { data, error } = await studentClient
      .from('study_guide_progress')
      .update({ current_piece_position: 1 })
      .eq('user_id', studentId)
      .eq('study_guide_id', guideWholeClass)
      .eq('offering_id', offeringId)
      .select('id');
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  // ---- deadline start gate (20260910130000) -------------------------------
  //
  // A past-due assignment cannot be STARTED (no new progress row), but a
  // student who already has a progress row keeps the grace period and can
  // still advance it. Runs while the whole-class row is still closed from the
  // block above; the due date is what these assert on, so it sets its own.

  it('past-due assignment refuses a new progress row but honors started grace', async () => {
    const { error: dueErr } = await admin
      .from('offering_study_guides')
      .update({ closed_at: null, due_date: '2020-01-01T00:00:00Z' })
      .eq('id', wholeClassPubRowId);
    expect(dueErr).toBeNull();

    // nonMember is enrolled and whole-class-authorized but never started.
    const { error } = await nonMemberClient
      .from('study_guide_progress')
      .insert({
        user_id: nonMemberId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        current_piece_position: 0,
      });
    expect(error).not.toBeNull();

    // studentId created a progress row earlier — advancing it stays allowed.
    const { data, error: updErr } = await studentClient
      .from('study_guide_progress')
      .update({ current_piece_position: 1 })
      .eq('user_id', studentId)
      .eq('study_guide_id', guideWholeClass)
      .eq('offering_id', offeringId)
      .select('id');
    expect(updErr).toBeNull();
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);

    // Clear the deadline again so the reopen test below asserts closure only.
    const { error: resetErr } = await admin
      .from('offering_study_guides')
      .update({ closed_at: new Date().toISOString(), due_date: null })
      .eq('id', wholeClassPubRowId);
    expect(resetErr).toBeNull();
  });

  it('reopening the assignment restores submission', async () => {
    const { error: reopenErr } = await admin
      .from('offering_study_guides')
      .update({ closed_at: null })
      .eq('id', wholeClassPubRowId);
    expect(reopenErr).toBeNull();

    const q = await createQuestion(admin, courseId);
    await addStudyGuidePieceQuestion(admin, wholeClassPieceId, q, 9);
    const { data, error } = await studentClient
      .from('study_guide_answers')
      .insert({
        user_id: studentId,
        study_guide_id: guideWholeClass,
        offering_id: offeringId,
        piece_id: wholeClassPieceId,
        question_id: q,
        submission: { selected_indices: [0] },
      })
      .select('id').single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  // ---- reopen_study_guide RPC (20260910160000) ----------------------------
  //
  // The instructor-facing reopen goes through a definer RPC so closure and
  // any PASSED due date clear in one statement, per row — a section whose
  // deadline is still ahead keeps it. Authorization is the function's own
  // check (instructor / institution admin / super-admin), so the student
  // denial below is about the RPC, not about RLS on the table.

  it('reopen_study_guide clears closure everywhere but only passed due dates', async () => {
    // Two published rows of the same guide in different states: the
    // whole-class row done via closure + a passed deadline, a second row
    // (other offering) closed with a deadline still ahead.
    const futureDue = '2100-01-01T00:00:00Z';
    const secondRowId = await createOfferingStudyGuide(
      admin, unassignedOfferingId, guideWholeClass, { dueDate: futureDue },
    );
    const { error: setupErr } = await admin
      .from('offering_study_guides')
      .update({ closed_at: new Date().toISOString(), due_date: '2020-01-01T00:00:00Z' })
      .eq('id', wholeClassPubRowId);
    expect(setupErr).toBeNull();
    const { error: setup2Err } = await admin
      .from('offering_study_guides')
      .update({ closed_at: new Date().toISOString() })
      .eq('id', secondRowId);
    expect(setup2Err).toBeNull();

    const { error: rpcErr } = await instructorClient.rpc('reopen_study_guide', {
      _study_guide_id: guideWholeClass,
    });
    expect(rpcErr).toBeNull();

    const { data: rows } = await admin
      .from('offering_study_guides')
      .select('id, closed_at, due_date')
      .in('id', [wholeClassPubRowId, secondRowId]);
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    // Passed deadline: closure AND due date cleared.
    expect(byId.get(wholeClassPubRowId)!.closed_at).toBeNull();
    expect(byId.get(wholeClassPubRowId)!.due_date).toBeNull();
    // Future deadline: closure cleared, the deadline survives.
    expect(byId.get(secondRowId)!.closed_at).toBeNull();
    expect(byId.get(secondRowId)!.due_date).not.toBeNull();

    // Leave no published row behind on the unassigned offering — the earlier
    // tests' premise for that class is "no guide ever assigned".
    await admin.from('offering_study_guides').delete().eq('id', secondRowId);
  });

  it('a student cannot call reopen_study_guide', async () => {
    const { error: closeErr } = await admin
      .from('offering_study_guides')
      .update({ closed_at: new Date().toISOString() })
      .eq('id', wholeClassPubRowId);
    expect(closeErr).toBeNull();

    const { error } = await studentClient.rpc('reopen_study_guide', {
      _study_guide_id: guideWholeClass,
    });
    expect(error).not.toBeNull();

    const { data: row } = await admin
      .from('offering_study_guides')
      .select('closed_at')
      .eq('id', wholeClassPubRowId)
      .single();
    expect(row!.closed_at).not.toBeNull();
  });
});
