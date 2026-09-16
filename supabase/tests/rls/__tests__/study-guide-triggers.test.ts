/**
 * Study guide integrity triggers — the three that shipped with the epic (#976)
 * carrying no direct coverage:
 *
 *   * touch_study_guide_theory_updated_at   (20260728160000)
 *   * offering_study_guides_course_must_match (20260727120000)
 *   * study_guide_answers_tuple_must_match    (20260727120000)
 *
 * Each is the ONLY thing enforcing its invariant, and each was reachable only
 * incidentally: `createStudyGuideAnswer` already works around the tuple trigger
 * by upserting the piece-question link, so the trigger was felt by the fixtures
 * but never asserted. A trigger nothing asserts is a trigger that can be
 * dropped, renamed or short-circuited by a later migration in silence.
 *
 * The staleness trigger is the one that actually motivated this file. Its
 * failure mode is silent: `pieceIsStale` reads `theory_updated_at`, so if the
 * trigger stops firing the predicate returns false forever and instructors ship
 * questions that no longer match the theory they edited — with no error
 * anywhere. `src/lib/study-guide.ts` even records that this exact warning went
 * missing once before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createQuestion,
  createStudyGuide,
  createStudyGuidePiece,
  addStudyGuidePieceQuestion,
  createOfferingStudyGuide,
  addUserToInstitution,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

// The predicate under test on the frontend side. Importing it here is
// deliberate and is the point of the first block below: the unit test in
// src/__tests__/lib/study-guide.test.ts feeds it hand-written timestamps, which
// proves the comparison but not that anything ever produces those timestamps.
// Asserting the trigger's real output against the real predicate is what closes
// that seam. Safe to import — the module is dependency-free pure functions.
import { pieceIsStale } from '../../../../src/lib/study-guide';

describe('study guide integrity triggers', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let otherCourseId: string;
  let classId: string;
  let offeringId: string;
  let otherOfferingId: string;
  let studentId: string;

  const userIds: string[] = [];

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS SG Triggers ${uid}`);
    courseId = await createCourse(admin, institutionId);
    // A second course in the SAME institution: RLS already blocks cross-tenant
    // access, so the mismatch these triggers catch is the intra-institution one.
    otherCourseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);
    otherOfferingId = await createOffering(admin, classId, otherCourseId);

    const stu = await createTestUserClient(admin, `rls-sgtrig-stu-${uid}@test.local`);
    studentId = stu.userId;
    userIds.push(stu.userId);
    await addUserToInstitution(admin, stu.userId, institutionId, 'student');
    await enrollInClass(admin, classId, stu.userId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  async function readPiece(pieceId: string) {
    const { data, error } = await admin
      .from('study_guide_pieces' as never)
      .select('theory_updated_at, questions_generated_at, title, theory_html')
      .eq('id', pieceId)
      .single();
    if (error) throw new Error(`readPiece: ${error.message}`);
    return data as unknown as {
      theory_updated_at: string | null;
      questions_generated_at: string | null;
      title: string;
      theory_html: string | null;
    };
  }

  /**
   * `theory_updated_at` has NO column default (20260728160000 adds it as a bare
   * `TIMESTAMP WITH TIME ZONE`), so a freshly inserted piece carries NULL until
   * the first theory edit fires the trigger.
   *
   * Every case below therefore establishes a real, database-clock baseline
   * first. Comparing against the NULL a fresh piece starts with would coerce to
   * the epoch in JavaScript and pass for the wrong reason — green whether or
   * not the trigger ever ran.
   */
  async function pieceWithStampedTheory(): Promise<{ pieceId: string; stampedAt: string }> {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0, {
      theoryHtml: '<p>v0</p>',
    });
    await admin
      .from('study_guide_pieces' as never)
      .update({ theory_html: '<p>v1</p>' })
      .eq('id', pieceId);
    const row = await readPiece(pieceId);
    expect(row.theory_updated_at).not.toBeNull();
    return { pieceId, stampedAt: row.theory_updated_at! };
  }

  describe('touch_study_guide_theory_updated_at', () => {
    it('starts NULL on a new piece and is stamped by the first theory edit', async () => {
      const guideId = await createStudyGuide(admin, courseId);
      const pieceId = await createStudyGuidePiece(admin, guideId, 0, {
        theoryHtml: '<p>v0</p>',
      });

      // Pinned deliberately: the absence of a column default is what makes the
      // NULL-handling in `pieceIsStale` load-bearing rather than defensive.
      expect((await readPiece(pieceId)).theory_updated_at).toBeNull();

      await admin
        .from('study_guide_pieces' as never)
        .update({ theory_html: '<p>v1</p>' })
        .eq('id', pieceId);

      expect((await readPiece(pieceId)).theory_updated_at).not.toBeNull();
    });

    it('bumps theory_updated_at on each subsequent theory change', async () => {
      const { pieceId, stampedAt } = await pieceWithStampedTheory();

      const { error } = await admin
        .from('study_guide_pieces' as never)
        .update({ theory_html: '<p>rewritten by the instructor</p>' })
        .eq('id', pieceId);
      expect(error).toBeNull();

      const after = await readPiece(pieceId);
      // Both sides non-null and both from the Postgres clock.
      expect(new Date(after.theory_updated_at!).getTime()).toBeGreaterThan(
        new Date(stampedAt).getTime(),
      );
    });

    it('does NOT bump when the theory is rewritten to the same html', async () => {
      const { pieceId, stampedAt } = await pieceWithStampedTheory();

      // IS DISTINCT FROM, not <>: writing the same value is not an edit, and
      // treating it as one would flag questions that are still perfectly valid.
      await admin
        .from('study_guide_pieces' as never)
        .update({ theory_html: '<p>v1</p>' })
        .eq('id', pieceId);

      expect((await readPiece(pieceId)).theory_updated_at).toBe(stampedAt);
    });

    it('does NOT bump when only the title changes', async () => {
      const { pieceId, stampedAt } = await pieceWithStampedTheory();

      await admin
        .from('study_guide_pieces' as never)
        .update({ title: 'Renamed, same theory' })
        .eq('id', pieceId);

      const after = await readPiece(pieceId);
      expect(after.title).toBe('Renamed, same theory');
      expect(after.theory_updated_at).toBe(stampedAt);
    });

    // The seam this file exists for: the trigger's real output, fed to the real
    // predicate. Either half passing alone would not catch the trigger silently
    // ceasing to fire.
    it('produces timestamps that make pieceIsStale() fire after a theory edit', async () => {
      const { pieceId, stampedAt } = await pieceWithStampedTheory();

      // Questions built from the current theory. The stamp is the piece's OWN
      // theory_updated_at, not `new Date()`: both sides of the comparison then
      // come from the Postgres clock, so the assertion cannot fail on skew
      // between the test runner and the database. A flaky test in a suite that
      // exists to catch a silent bug is worse than no test, because the usual
      // fix is to mute it.
      await admin
        .from('study_guide_pieces' as never)
        .update({ questions_generated_at: stampedAt })
        .eq('id', pieceId);

      const fresh = await readPiece(pieceId);
      expect(fresh.questions_generated_at).not.toBeNull();
      expect(pieceIsStale(fresh.questions_generated_at, fresh.theory_updated_at)).toBe(false);

      // The instructor rewrites the theory. The questions now test text no
      // student will read.
      await admin
        .from('study_guide_pieces' as never)
        .update({ theory_html: '<p>v2 — substantially rewritten</p>' })
        .eq('id', pieceId);

      const edited = await readPiece(pieceId);
      expect(pieceIsStale(edited.questions_generated_at, edited.theory_updated_at)).toBe(true);
    });
  });

  describe('offering_study_guides_course_must_match', () => {
    it("rejects assigning a guide to another course's offering", async () => {
      const guideId = await createStudyGuide(admin, courseId);

      const { error } = await admin
        .from('offering_study_guides' as never)
        .insert({
          offering_id: otherOfferingId,
          study_guide_id: guideId,
          published_at: new Date().toISOString(),
        });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/does not belong to the course of offering/i);
    });

    it('allows assigning a guide to its own course offering', async () => {
      const guideId = await createStudyGuide(admin, courseId);
      const rowId = await createOfferingStudyGuide(admin, offeringId, guideId);
      expect(rowId).toBeTruthy();
    });

    it('rejects moving an existing assignment onto a mismatched offering', async () => {
      const guideId = await createStudyGuide(admin, courseId);
      const rowId = await createOfferingStudyGuide(admin, offeringId, guideId);

      // The trigger covers UPDATE OF offering_id too — checking only INSERT
      // would leave the assignment reachable by editing it afterwards.
      const { error } = await admin
        .from('offering_study_guides' as never)
        .update({ offering_id: otherOfferingId })
        .eq('id', rowId);

      expect(error).not.toBeNull();
    });
  });

  describe('study_guide_answers_tuple_must_match', () => {
    it('rejects an answer whose piece belongs to a different guide', async () => {
      const guideA = await createStudyGuide(admin, courseId);
      const guideB = await createStudyGuide(admin, courseId);
      const pieceB = await createStudyGuidePiece(admin, guideB, 0);
      const questionId = await createQuestion(admin, courseId);
      await addStudyGuidePieceQuestion(admin, pieceB, questionId);
      await createOfferingStudyGuide(admin, offeringId, guideA);

      const { error } = await admin
        .from('study_guide_answers' as never)
        .insert({
          user_id: studentId,
          study_guide_id: guideA,
          offering_id: offeringId,
          piece_id: pieceB,
          question_id: questionId,
          submission: {},
          is_correct: true,
        });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/does not belong to study guide/i);
    });

    it('rejects an answer whose question is not part of the named piece', async () => {
      const guideId = await createStudyGuide(admin, courseId);
      const pieceId = await createStudyGuidePiece(admin, guideId, 0);
      // A real question on the same course, deliberately never linked to the piece.
      const strayQuestionId = await createQuestion(admin, courseId);
      await createOfferingStudyGuide(admin, offeringId, guideId);

      const { error } = await admin
        .from('study_guide_answers' as never)
        .insert({
          user_id: studentId,
          study_guide_id: guideId,
          offering_id: offeringId,
          piece_id: pieceId,
          question_id: strayQuestionId,
          submission: {},
          is_correct: true,
        });

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/is not part of piece/i);
    });

    it('accepts a consistent guide/piece/question tuple', async () => {
      const guideId = await createStudyGuide(admin, courseId);
      const pieceId = await createStudyGuidePiece(admin, guideId, 0);
      const questionId = await createQuestion(admin, courseId);
      await addStudyGuidePieceQuestion(admin, pieceId, questionId);
      await createOfferingStudyGuide(admin, offeringId, guideId);

      const { error } = await admin
        .from('study_guide_answers' as never)
        .insert({
          user_id: studentId,
          study_guide_id: guideId,
          offering_id: offeringId,
          piece_id: pieceId,
          question_id: questionId,
          submission: {},
          is_correct: true,
        });

      expect(error).toBeNull();
    });
  });
});
