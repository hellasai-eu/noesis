// Behaviour under test:
//   public.submit_study_guide_piece_answers(uuid, uuid, uuid, uuid, int, boolean, jsonb)
//
// Migrations:
//   * 20260728220000_study_guide_progress_draft_answers.sql (#980)
//   * 20260728230000_study_guide_submit_piece_rpc.sql       (#980, review)
//
// The RPC exists because the edge function alone could not make the guarantee.
// Inserting the graded answers and advancing `study_guide_progress` used to be
// two statements; if the second failed the answers were already committed while
// progress still pointed at the just-submitted piece. The immutable-answer
// constraint then makes every retry return `already_submitted`, stranding the
// student on a piece they can neither re-submit nor move past. Both writes now
// share one transaction.
//
// It is also the only DB-level guard on sequence: the edge function checks that
// the piece is the student's current one, but a direct service-role call would
// otherwise be free to skip ahead. Everything here therefore drives the RPC
// directly rather than through the handler.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
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
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

describe('submit_study_guide_piece_answers', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let classId: string;
  let offeringId: string;
  let studentId: string;
  let studentClient: SupabaseClient;

  const userIds: string[] = [];

  /** A guide with `pieceCount` pieces, each holding one MCQ. */
  async function createGuide(pieceCount: number) {
    const studyGuideId = await createStudyGuide(admin, courseId);
    const pieces: Array<{ id: string; position: number; questionId: string }> = [];
    for (let position = 0; position < pieceCount; position++) {
      const pieceId = await createStudyGuidePiece(admin, studyGuideId, position);
      const questionId = await createQuestion(admin, courseId);
      await addStudyGuidePieceQuestion(admin, pieceId, questionId, 0);
      pieces.push({ id: pieceId, position, questionId });
    }
    return { studyGuideId, pieces };
  }

  function submit(params: {
    studyGuideId: string;
    pieceId: string;
    piecePosition: number;
    questionId: string;
    isFinal?: boolean;
    userId?: string;
  }) {
    return admin.rpc('submit_study_guide_piece_answers' as never, {
      _user_id: params.userId ?? studentId,
      _study_guide_id: params.studyGuideId,
      _offering_id: offeringId,
      _piece_id: params.pieceId,
      _piece_position: params.piecePosition,
      _is_final: params.isFinal ?? false,
      _answers: [
        {
          question_id: params.questionId,
          submission: { selected_indices: [0] },
          is_correct: true,
          grade: 100,
          feedback: 'well done',
          strengths: ['clear'],
          areas_for_improvement: ['detail'],
        },
      ],
    } as never);
  }

  async function progressRow(studyGuideId: string) {
    const { data } = await admin
      .from('study_guide_progress' as never)
      .select('current_piece_position, completed_at, draft_answers')
      .eq('user_id', studentId)
      .eq('study_guide_id', studyGuideId)
      .eq('offering_id', offeringId)
      .maybeSingle();
    return data as {
      current_piece_position: number;
      completed_at: string | null;
      draft_answers: Record<string, unknown> | null;
    } | null;
  }

  async function answerCount(studyGuideId: string) {
    const { count } = await admin
      .from('study_guide_answers' as never)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', studentId)
      .eq('study_guide_id', studyGuideId);
    return count ?? 0;
  }

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `SG Submit RPC ${uid}`);
    courseId = await createCourse(admin, institutionId);
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);

    const s = await createTestUserClient(admin, `sg-submit-student-${uid}@test.local`);
    studentClient = s.client;
    studentId = s.userId;
    userIds.push(studentId);
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ── The sequence guard ────────────────────────────────────────────────

  it('refuses a piece ahead of the student and writes nothing', async () => {
    const { studyGuideId, pieces } = await createGuide(3);

    const { error } = await submit({
      studyGuideId,
      pieceId: pieces[2].id,
      piecePosition: 2,
      questionId: pieces[2].questionId,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('is not the current piece');
    expect(await answerCount(studyGuideId)).toBe(0);
    expect(await progressRow(studyGuideId)).toBeNull();
  });

  it('refuses a piece the student has already moved past', async () => {
    const { studyGuideId, pieces } = await createGuide(2);
    await submit({
      studyGuideId,
      pieceId: pieces[0].id,
      piecePosition: 0,
      questionId: pieces[0].questionId,
    });

    const { error } = await submit({
      studyGuideId,
      pieceId: pieces[0].id,
      piecePosition: 0,
      questionId: pieces[0].questionId,
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain('is not the current piece');
  });

  it('rejects an empty answer array rather than advancing for free', async () => {
    const { studyGuideId, pieces } = await createGuide(2);

    const { error } = await admin.rpc('submit_study_guide_piece_answers' as never, {
      _user_id: studentId,
      _study_guide_id: studyGuideId,
      _offering_id: offeringId,
      _piece_id: pieces[0].id,
      _piece_position: 0,
      _is_final: false,
      _answers: [],
    } as never);

    expect(error).not.toBeNull();
    expect(await progressRow(studyGuideId)).toBeNull();
  });

  // ── Atomicity: answers and progress move together ─────────────────────

  it('writes the answers and advances progress in the same call', async () => {
    const { studyGuideId, pieces } = await createGuide(2);

    const { error } = await submit({
      studyGuideId,
      pieceId: pieces[0].id,
      piecePosition: 0,
      questionId: pieces[0].questionId,
    });
    expect(error).toBeNull();

    expect(await answerCount(studyGuideId)).toBe(1);
    const progress = await progressRow(studyGuideId);
    expect(progress?.current_piece_position).toBe(1);
    expect(progress?.completed_at).toBeNull();
  });

  // A failed insert must not leave progress advanced — the mirror of the
  // original defect, where a failed progress write left the answers behind.
  it('leaves progress untouched when the answer insert fails', async () => {
    const { studyGuideId, pieces } = await createGuide(2);
    const foreign = await createGuide(1);

    // The tuple trigger rejects a question that is not part of the piece.
    const { error } = await admin.rpc('submit_study_guide_piece_answers' as never, {
      _user_id: studentId,
      _study_guide_id: studyGuideId,
      _offering_id: offeringId,
      _piece_id: pieces[0].id,
      _piece_position: 0,
      _is_final: false,
      _answers: [
        {
          question_id: foreign.pieces[0].questionId,
          submission: { selected_indices: [0] },
          is_correct: true,
          grade: 100,
        },
      ],
    } as never);

    expect(error).not.toBeNull();
    expect(await answerCount(studyGuideId)).toBe(0);
    expect(await progressRow(studyGuideId)).toBeNull();
  });

  it('records the graded values it was handed', async () => {
    const { studyGuideId, pieces } = await createGuide(1);
    await submit({
      studyGuideId,
      pieceId: pieces[0].id,
      piecePosition: 0,
      questionId: pieces[0].questionId,
      isFinal: true,
    });

    const { data } = await admin
      .from('study_guide_answers' as never)
      .select('is_correct, grade, feedback, strengths, areas_for_improvement, graded_at, submission')
      .eq('user_id', studentId)
      .eq('question_id', pieces[0].questionId)
      .single();

    const row = data as {
      is_correct: boolean;
      grade: number;
      feedback: string;
      strengths: string[];
      areas_for_improvement: string[];
      graded_at: string | null;
      submission: Record<string, unknown>;
    };
    expect(row.is_correct).toBe(true);
    expect(Number(row.grade)).toBe(100);
    expect(row.feedback).toBe('well done');
    expect(row.strengths).toEqual(['clear']);
    expect(row.areas_for_improvement).toEqual(['detail']);
    expect(row.graded_at).not.toBeNull();
    expect(row.submission).toEqual({ selected_indices: [0] });
  });

  // ── Completion ────────────────────────────────────────────────────────

  it('sets completed_at only when the final piece is submitted', async () => {
    const { studyGuideId, pieces } = await createGuide(2);

    await submit({
      studyGuideId,
      pieceId: pieces[0].id,
      piecePosition: 0,
      questionId: pieces[0].questionId,
      isFinal: false,
    });
    expect((await progressRow(studyGuideId))?.completed_at).toBeNull();

    await submit({
      studyGuideId,
      pieceId: pieces[1].id,
      piecePosition: 1,
      questionId: pieces[1].questionId,
      isFinal: true,
    });

    const done = await progressRow(studyGuideId);
    expect(done?.current_piece_position).toBe(2);
    expect(done?.completed_at).not.toBeNull();
  });

  // ── Drafts ────────────────────────────────────────────────────────────

  it('clears only the submitted piece from the saved drafts', async () => {
    const { studyGuideId, pieces } = await createGuide(2);

    await admin.from('study_guide_progress' as never).insert({
      user_id: studentId,
      study_guide_id: studyGuideId,
      offering_id: offeringId,
      current_piece_position: 0,
      draft_answers: {
        [pieces[0].id]: { [pieces[0].questionId]: { selected_indices: [1] } },
        [pieces[1].id]: { [pieces[1].questionId]: { selected_indices: [2] } },
      },
    });

    await submit({
      studyGuideId,
      pieceId: pieces[0].id,
      piecePosition: 0,
      questionId: pieces[0].questionId,
    });

    const drafts = (await progressRow(studyGuideId))?.draft_answers ?? {};
    expect(Object.keys(drafts)).toEqual([pieces[1].id]);
  });

  // ── The privilege boundary ────────────────────────────────────────────
  //
  // The migration reserves EXECUTE for `service_role` — the function takes
  // `_user_id` as a parameter, so a client who could reach it directly could
  // submit as anybody. (`scripts/local-db-grants.sh` used to re-grant EXECUTE
  // on every function, which made this untestable locally; it no longer
  // touches functions.)

  it('an authenticated client cannot EXECUTE the RPC directly', async () => {
    const { studyGuideId, pieces } = await createGuide(1);

    const { error } = await studentClient.rpc(
      'submit_study_guide_piece_answers' as never,
      {
        _user_id: studentId,
        _study_guide_id: studyGuideId,
        _offering_id: offeringId,
        _piece_id: pieces[0].id,
        _piece_position: 0,
        _is_final: false,
        _answers: [],
      } as never
    );

    expect(error).not.toBeNull();
    // The ACL denial specifically, not an in-function refusal that happens to
    // share the 42501 code.
    expect(error!.code).toBe('42501');
    expect(error!.message).toContain('permission denied for function submit_study_guide_piece_answers');
    expect(await answerCount(studyGuideId)).toBe(0);
    expect(await progressRow(studyGuideId)).toBeNull();
  });
});
