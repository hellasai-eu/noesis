// Behaviour under test:
//   public.replace_study_guide_piece_questions(uuid, uuid, uuid, jsonb)
//   idx_jobs_one_active_study_guide_generation
//
// Migration:
//   * 20260727190000_study_guide_piece_content_rpc.sql (#978, review of #991)
//
// Both exist because the edge function alone could not make the guarantee:
//
//   * The RPC writes a piece's questions, their junctions and their piece
//     links in ONE transaction. The previous two-step write (insert questions,
//     then insert links) left committed questions with nothing pointing at
//     them when the second step failed — orphans that leaked into the
//     instructor's Question Bank, whose #977 filter excludes only questions
//     *present in* study_guide_piece_questions. A retry then generated a
//     second full set on top.
//
//   * The partial unique index closes a time-of-check/time-of-use race in the
//     enqueue function: two concurrent callers could both pass its "is a job
//     already running?" SELECT before either inserted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { getAdminClient, createTestUserClient } from '../helpers/auth';
import {
  createInstitution,
  createCourse,
  createClass,
  createOffering,
  createStudyGuide,
  createStudyGuidePiece,
  createStudyGuideAnswer,
  addUserToInstitution,
  assignCourseInstructor,
  enrollInClass,
} from '../helpers/data';
import { cleanupScaffold } from '../helpers/cleanup';

/** Minimal valid unified rows, matching what the converter emits. */
function mcqRow(text: string) {
  return {
    question: text,
    type: 'mcq',
    payload: { options: ['A', 'B', 'C'] },
    answer_key: { correct_indices: [0], correct_index: 0 },
    explanation: 'because',
    difficulty: 'medium',
    competency_id: null,
    competency_ids: [],
    chapter_ids: [],
    hidden: false,
    is_user_generated: false,
  };
}

describe('study guide generation integrity', () => {
  const admin = getAdminClient();
  const uid = crypto.randomUUID().slice(0, 8);

  let institutionId: string;
  let courseId: string;
  let creatorId: string;
  let creatorClient: SupabaseClient;
  let classId: string;
  let offeringId: string;
  let studentId: string;

  const userIds: string[] = [];

  async function callRpc(pieceId: string, questions: unknown[]) {
    return await admin.rpc('replace_study_guide_piece_questions' as never, {
      _piece_id: pieceId,
      _course_id: courseId,
      _created_by: creatorId,
      _questions: questions,
    } as never);
  }

  async function linkedQuestionIds(pieceId: string): Promise<string[]> {
    const { data, error } = await admin
      .from('study_guide_piece_questions' as never)
      .select('question_id')
      .eq('piece_id', pieceId)
      .order('position', { ascending: true });
    if (error) throw new Error(`linkedQuestionIds: ${error.message}`);
    return (data as Array<{ question_id: string }>).map((r) => r.question_id);
  }

  async function questionExists(id: string): Promise<boolean> {
    const { data } = await admin
      .from('questions')
      .select('id')
      .eq('id', id);
    return (data ?? []).length > 0;
  }

  beforeAll(async () => {
    institutionId = await createInstitution(admin, `RLS SGGen ${uid}`);
    courseId = await createCourse(admin, institutionId);

    const creator = await createTestUserClient(admin, `rls-sggen-${uid}@test.local`);
    creatorId = creator.userId;
    creatorClient = creator.client;
    userIds.push(creator.userId);
    await addUserToInstitution(admin, creator.userId, institutionId, 'instructor');
    await assignCourseInstructor(admin, courseId, creator.userId);

    // Needed by the "has submissions" case: an answer row requires a real
    // offering and a real student.
    classId = await createClass(admin, institutionId);
    offeringId = await createOffering(admin, classId, courseId);
    const student = await createTestUserClient(admin, `rls-sggen-stu-${uid}@test.local`);
    studentId = student.userId;
    userIds.push(student.userId);
    await addUserToInstitution(admin, student.userId, institutionId, 'student');
    await enrollInClass(admin, classId, student.userId, 'student');
  });

  afterAll(async () => {
    await cleanupScaffold(admin, { institutionId, userIds });
  });

  // ---- replace_study_guide_piece_questions --------------------------------

  it('inserts questions and links them in order', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);

    const { data, error } = await callRpc(pieceId, [mcqRow('Q1'), mcqRow('Q2')]);
    expect(error).toBeNull();
    const ids = data as string[];
    expect(ids).toHaveLength(2);

    // Links come back in insertion order, so the student sees them as written.
    expect(await linkedQuestionIds(pieceId)).toEqual(ids);
  });

  it('replaces a previous attempt instead of accumulating', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);

    const first = (await callRpc(pieceId, [mcqRow('old-1'), mcqRow('old-2')])).data as string[];
    expect(first).toHaveLength(2);

    // A retry of the same job item must not leave the first set behind.
    const second = (await callRpc(pieceId, [mcqRow('new-1')])).data as string[];
    expect(second).toHaveLength(1);

    expect(await linkedQuestionIds(pieceId)).toEqual(second);
    for (const oldId of first) {
      expect(await questionExists(oldId)).toBe(false);
    }
    expect(await questionExists(second[0])).toBe(true);
  });

  it('writes nothing when one question in the batch is invalid', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);

    // `type` violates the questions_type_check, so the whole call must roll
    // back — study guides are all-or-nothing, and a partially written piece
    // would ship short.
    const { error } = await callRpc(pieceId, [mcqRow('good'), { ...mcqRow('bad'), type: 'essay' }]);
    expect(error).not.toBeNull();
    expect(await linkedQuestionIds(pieceId)).toHaveLength(0);
  });

  it('refuses to replace a piece whose questions have been answered', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const first = (await callRpc(pieceId, [mcqRow('answered')])).data as string[];

    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId,
      pieceId,
      questionId: first[0],
    });

    // Reachable on a retry: the RPC commits, the worker dies before the item
    // is marked complete, the lease expires and another worker re-runs it. A
    // student answering in that window must not lose their submission.
    const { error } = await callRpc(pieceId, [mcqRow('replacement')]);
    expect(error).not.toBeNull();

    // Rolled back — the answered question and its link both survive.
    expect(await questionExists(first[0])).toBe(true);
    expect(await linkedQuestionIds(pieceId)).toEqual(first);
  });

  // Pins why the submissions guard is a lock + check inside the RPCs rather
  // than `ON DELETE RESTRICT` on study_guide_answers.question_id. RESTRICT
  // would read as the tidier fix, but `questions.course_id` is ON DELETE
  // CASCADE — so it would abort that cascade and make deleting a course (and
  // the GDPR erasure paths built on it) fail whenever any study guide answer
  // existed. If this test ever starts failing, that trade-off has been undone.
  it('still allows deleting a course whose study guide questions were answered', async () => {
    const throwawayCourse = await createCourse(admin, institutionId);
    const throwawayOffering = await createOffering(admin, classId, throwawayCourse);
    const guideId = await createStudyGuide(admin, throwawayCourse);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);

    const { data, error: rpcError } = await admin.rpc(
      'replace_study_guide_piece_questions' as never,
      {
        _piece_id: pieceId,
        _course_id: throwawayCourse,
        _created_by: creatorId,
        _questions: [mcqRow('answered')],
      } as never,
    );
    expect(rpcError).toBeNull();
    const ids = data as string[];

    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId: throwawayOffering,
      pieceId,
      questionId: ids[0],
    });

    const { error } = await admin.from('courses').delete().eq('id', throwawayCourse);
    expect(error).toBeNull();
    expect(await questionExists(ids[0])).toBe(false);
  });

  it('rejects an empty question array', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const { error } = await callRpc(pieceId, []);
    expect(error).not.toBeNull();
  });

  it('rejects an unknown piece', async () => {
    const { error } = await callRpc(crypto.randomUUID(), [mcqRow('Q1')]);
    expect(error).not.toBeNull();
  });

  it('links questions to the course so they are ordinary rows', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('Q1')])).data as string[];

    const { data } = await admin
      .from('questions')
      .select('course_id, hidden, is_user_generated, created_by')
      .eq('id', ids[0])
      .single();
    expect(data).toMatchObject({
      course_id: courseId,
      hidden: false,
      is_user_generated: false,
      created_by: creatorId,
    });
  });

  // ---- clear_study_guide_pieces -------------------------------------------

  it('deletes the previous attempt\'s questions, not just the pieces', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('Q1'), mcqRow('Q2')])).data as string[];

    const { error } = await admin.rpc('clear_study_guide_pieces' as never, {
      _study_guide_id: guideId,
    } as never);
    expect(error).toBeNull();

    // The naive `DELETE FROM study_guide_pieces` cascades to the JUNCTION
    // rows only — `questions` is the junction's other parent, not its child —
    // so it would leave these behind with nothing left to identify them by,
    // and they would surface in the instructor's Question Bank.
    for (const id of ids) {
      expect(await questionExists(id)).toBe(false);
    }

    const { data: pieces } = await admin
      .from('study_guide_pieces' as never)
      .select('id')
      .eq('study_guide_id', guideId);
    expect(pieces).toHaveLength(0);
  });

  it('leaves other guides untouched when clearing one', async () => {
    const keepGuide = await createStudyGuide(admin, courseId);
    const keepPiece = await createStudyGuidePiece(admin, keepGuide, 0);
    const keepIds = (await callRpc(keepPiece, [mcqRow('keep')])).data as string[];

    const dropGuide = await createStudyGuide(admin, courseId);
    const dropPiece = await createStudyGuidePiece(admin, dropGuide, 0);
    await callRpc(dropPiece, [mcqRow('drop')]);

    await admin.rpc('clear_study_guide_pieces' as never, {
      _study_guide_id: dropGuide,
    } as never);

    expect(await questionExists(keepIds[0])).toBe(true);
    expect(await linkedQuestionIds(keepPiece)).toEqual(keepIds);
  });

  it('refuses to clear a guide that has student submissions, losing nothing', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('Q1')])).data as string[];

    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId,
      pieceId,
      questionId: ids[0],
    });

    // The enqueue handler checks this too, but a student can submit between
    // that check and this cleanup — so the guarantee has to live here, in the
    // same transaction as the delete.
    const { error } = await admin.rpc('clear_study_guide_pieces' as never, {
      _study_guide_id: guideId,
    } as never);
    expect(error).not.toBeNull();

    // Rolled back: the guide's content survives intact.
    expect(await questionExists(ids[0])).toBe(true);
    expect(await linkedQuestionIds(pieceId)).toEqual(ids);
  });

  it('is a no-op on a guide that has never generated', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const { error } = await admin.rpc('clear_study_guide_pieces' as never, {
      _study_guide_id: guideId,
    } as never);
    expect(error).toBeNull();
  });

  // ---- move_study_guide_piece (#979) --------------------------------------

  it('swaps a piece with its neighbour despite the unique position constraint', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const a = await createStudyGuidePiece(admin, guideId, 0, { title: 'A' });
    const b = await createStudyGuidePiece(admin, guideId, 1, { title: 'B' });

    // Two sequential client-side updates would collide on
    // UNIQUE (study_guide_id, position); the RPC does it in one statement.
    const { error } = await admin.rpc('move_study_guide_piece' as never, {
      _piece_id: b,
      _direction: 'up',
    } as never);
    expect(error).toBeNull();

    const { data } = await admin
      .from('study_guide_pieces' as never)
      .select('id, position')
      .eq('study_guide_id', guideId)
      .order('position', { ascending: true });
    const rows = data as Array<{ id: string; position: number }>;
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('is a no-op at the ends rather than an error', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const first = await createStudyGuidePiece(admin, guideId, 0, { title: 'first' });
    await createStudyGuidePiece(admin, guideId, 1, { title: 'second' });

    const { error } = await admin.rpc('move_study_guide_piece' as never, {
      _piece_id: first,
      _direction: 'up',
    } as never);
    expect(error).toBeNull();

    const { data } = await admin
      .from('study_guide_pieces' as never)
      .select('position')
      .eq('id', first)
      .single();
    expect((data as { position: number }).position).toBe(0);
  });

  it('rejects a bogus direction', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const { error } = await admin.rpc('move_study_guide_piece' as never, {
      _piece_id: pieceId,
      _direction: 'sideways',
    } as never);
    expect(error).not.toBeNull();
  });

  // ---- delete_study_guide_question (#979) ---------------------------------

  it('deletes an unanswered question and its piece link', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('Q1'), mcqRow('Q2')])).data as string[];

    const { error } = await creatorClient.rpc('delete_study_guide_question' as never, {
      _question_id: ids[0],
    } as never);
    expect(error).toBeNull();
    expect(await questionExists(ids[0])).toBe(false);
    expect(await linkedQuestionIds(pieceId)).toEqual([ids[1]]);
  });

  it('refuses to delete an answered question, losing nothing', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('answered')])).data as string[];
    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId,
      pieceId,
      questionId: ids[0],
    });

    // A plain DELETE here would look harmless and cascade the submission away,
    // which is exactly why the editor goes through the RPC. The function is
    // SECURITY DEFINER so its count sees answers in every offering, including
    // sections this instructor cannot read — an invoker-scoped count would
    // return zero and let the delete cascade them away.
    const { error } = await creatorClient.rpc('delete_study_guide_question' as never, {
      _question_id: ids[0],
    } as never);
    expect(error).not.toBeNull();
    expect(await questionExists(ids[0])).toBe(true);
  });

  // ---- delete_study_guide (#979, review of #997) --------------------------

  it('deletes a guide that has no submissions anywhere', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    await createStudyGuidePiece(admin, guideId, 0);

    // The instructor, not the service role: the function is SECURITY DEFINER
    // and checks auth.uid() explicitly, so a service-role caller (auth.uid()
    // NULL) is correctly refused.
    const { error } = await creatorClient.rpc('delete_study_guide' as never, {
      _study_guide_id: guideId,
    } as never);
    expect(error).toBeNull();

    const { data } = await admin
      .from('study_guides' as never)
      .select('id')
      .eq('id', guideId);
    expect(data).toHaveLength(0);
  });

  it('refuses to delete a guide with submissions in ANY offering', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('answered')])).data as string[];
    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId,
      pieceId,
      questionId: ids[0],
    });

    // The manager used to decide this from a browser query, which RLS scopes to
    // the offerings the caller manages — while the delete cascades across all
    // of them. Counting as definer here is the whole point.
    const { error } = await creatorClient.rpc('delete_study_guide' as never, {
      _study_guide_id: guideId,
    } as never);
    expect(error).not.toBeNull();

    const { data } = await admin
      .from('study_guides' as never)
      .select('id')
      .eq('id', guideId);
    expect(data).toHaveLength(1);
  });

  it('refuses deletion for a user who does not manage the course', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const outsider = await createTestUserClient(admin, `rls-sggen-out-${uid}@test.local`);
    userIds.push(outsider.userId);
    await addUserToInstitution(admin, outsider.userId, institutionId, 'student');

    // SECURITY DEFINER bypasses RLS, so the manager check has to be explicit.
    const { error } = await outsider.client.rpc('delete_study_guide' as never, {
      _study_guide_id: guideId,
    } as never);
    expect(error).not.toBeNull();
  });

  it('refuses question deletion for a user who does not manage the course', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('Q1')])).data as string[];

    const outsider = await createTestUserClient(admin, `rls-sggen-qout-${uid}@test.local`);
    userIds.push(outsider.userId);
    await addUserToInstitution(admin, outsider.userId, institutionId, 'student');

    // SECURITY DEFINER bypasses RLS on `questions`, so the manager check has to
    // be explicit or anyone could delete anyone's question.
    const { error } = await outsider.client.rpc('delete_study_guide_question' as never, {
      _question_id: ids[0],
    } as never);
    expect(error).not.toBeNull();
    expect(await questionExists(ids[0])).toBe(true);
  });

  // ---- replace_study_guide_outline (#1004) --------------------------------

  it('replaces the outline atomically, taking the old questions with it', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const oldPiece = await createStudyGuidePiece(admin, guideId, 0, { title: 'old' });
    const oldQuestions = (await callRpc(oldPiece, [mcqRow('old-q')])).data as string[];

    const { data, error } = await admin.rpc('replace_study_guide_outline' as never, {
      _study_guide_id: guideId,
      _pieces: [{ title: 'new one' }, { title: 'new two' }],
    } as never);
    expect(error).toBeNull();

    const rows = data as Array<{ id: string; position: number; title: string }>;
    expect(rows.map((r) => r.title)).toEqual(['new one', 'new two']);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);

    // The previous attempt's questions go with it — deleting only the pieces
    // would strand them in the instructor's Question Bank.
    expect(await questionExists(oldQuestions[0])).toBe(false);
  });

  it('refuses to replace the outline when a student has answered', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('answered')])).data as string[];
    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId,
      pieceId,
      questionId: ids[0],
    });

    const { error } = await admin.rpc('replace_study_guide_outline' as never, {
      _study_guide_id: guideId,
      _pieces: [{ title: 'replacement' }],
    } as never);
    expect(error).not.toBeNull();

    // Rolled back: the answered content survives intact.
    expect(await questionExists(ids[0])).toBe(true);
    expect(await linkedQuestionIds(pieceId)).toEqual(ids);
  });

  it('rejects an empty outline rather than emptying the guide', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    await createStudyGuidePiece(admin, guideId, 0, { title: 'keep me' });

    const { error } = await admin.rpc('replace_study_guide_outline' as never, {
      _study_guide_id: guideId,
      _pieces: [],
    } as never);
    expect(error).not.toBeNull();

    const { data } = await admin
      .from('study_guide_pieces' as never)
      .select('id')
      .eq('study_guide_id', guideId);
    expect(data).toHaveLength(1);
  });

  // ---- staleness timestamps (#1004) ---------------------------------------

  it('stamps questions_generated_at, and a theory edit moves theory_updated_at past it', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    await callRpc(pieceId, [mcqRow('Q1')]);

    const readStamps = async () => {
      const { data } = await admin
        .from('study_guide_pieces' as never)
        .select('theory_updated_at, questions_generated_at')
        .eq('id', pieceId)
        .single();
      return data as { theory_updated_at: string | null; questions_generated_at: string | null };
    };

    const fresh = await readStamps();
    expect(fresh.questions_generated_at).not.toBeNull();
    // Questions just written are not stale.
    expect(
      new Date(fresh.questions_generated_at!) >= new Date(fresh.theory_updated_at ?? 0),
    ).toBe(true);

    await admin
      .from('study_guide_pieces' as never)
      .update({ theory_html: '<p>rewritten by the instructor</p>' })
      .eq('id', pieceId);

    const edited = await readStamps();
    // Now the questions predate the text they are supposed to test.
    expect(new Date(edited.theory_updated_at!) > new Date(edited.questions_generated_at!)).toBe(
      true,
    );
  });

  it('does not flag staleness when only the title changes', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    await callRpc(pieceId, [mcqRow('Q1')]);

    const before = await admin
      .from('study_guide_pieces' as never)
      .select('theory_updated_at')
      .eq('id', pieceId)
      .single();

    // The generic updated_at trigger fires on any update; theory_updated_at
    // must not, or renaming a piece would raise a false alarm.
    await admin
      .from('study_guide_pieces' as never)
      .update({ title: 'renamed' })
      .eq('id', pieceId);

    const after = await admin
      .from('study_guide_pieces' as never)
      .select('theory_updated_at')
      .eq('id', pieceId)
      .single();

    expect((after.data as { theory_updated_at: string }).theory_updated_at).toBe(
      (before.data as { theory_updated_at: string }).theory_updated_at,
    );
  });

  // ---- delete_study_guide_piece (#1005) -----------------------------------

  it('deletes a piece with its questions and closes the position gap', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const first = await createStudyGuidePiece(admin, guideId, 0, { title: 'first' });
    const middle = await createStudyGuidePiece(admin, guideId, 1, { title: 'middle' });
    const last = await createStudyGuidePiece(admin, guideId, 2, { title: 'last' });
    const middleQuestions = (await callRpc(middle, [mcqRow('doomed')])).data as string[];

    const { error } = await creatorClient.rpc('delete_study_guide_piece' as never, {
      _piece_id: middle,
    } as never);
    expect(error).toBeNull();

    // A plain delete would leave these orphaned in the Question Bank: the
    // cascade removes only the junction rows that identify them.
    expect(await questionExists(middleQuestions[0])).toBe(false);

    const { data } = await admin
      .from('study_guide_pieces' as never)
      .select('id, position')
      .eq('study_guide_id', guideId)
      .order('position', { ascending: true });
    const rows = data as Array<{ id: string; position: number }>;
    // Students advance strictly piece by piece, so positions stay contiguous.
    expect(rows.map((r) => r.id)).toEqual([first, last]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it('refuses to delete a piece a student has answered', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const ids = (await callRpc(pieceId, [mcqRow('answered')])).data as string[];
    await createStudyGuideAnswer(admin, {
      userId: studentId,
      studyGuideId: guideId,
      offeringId,
      pieceId,
      questionId: ids[0],
    });

    const { error } = await creatorClient.rpc('delete_study_guide_piece' as never, {
      _piece_id: pieceId,
    } as never);
    expect(error).not.toBeNull();
    expect(await questionExists(ids[0])).toBe(true);
  });

  it('refuses piece deletion for a user who does not manage the course', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const pieceId = await createStudyGuidePiece(admin, guideId, 0);
    const outsider = await createTestUserClient(admin, `rls-sgpiece-out-${uid}@test.local`);
    userIds.push(outsider.userId);
    await addUserToInstitution(admin, outsider.userId, institutionId, 'student');

    const { error } = await outsider.client.rpc('delete_study_guide_piece' as never, {
      _piece_id: pieceId,
    } as never);
    expect(error).not.toBeNull();
  });

  // ---- shared questions survive cleanup (#1005 review) --------------------
  //
  // study_guide_piece_questions has PRIMARY KEY (piece_id, question_id), so a
  // question may belong to several pieces. Nothing shares them today, but the
  // schema permits it and a guard that only holds while nobody uses a feature
  // is not a guard. All four cleanup paths are covered, not just the one that
  // was reported.

  async function shareQuestionAcross(pieceA: string, pieceB: string) {
    const ids = (await callRpc(pieceA, [mcqRow('shared')])).data as string[];
    const { error } = await admin
      .from('study_guide_piece_questions' as never)
      .insert({ piece_id: pieceB, question_id: ids[0], position: 0 });
    if (error) throw new Error(`shareQuestionAcross: ${error.message}`);
    return ids[0];
  }

  it('piece deletion keeps a question another piece still uses', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const doomed = await createStudyGuidePiece(admin, guideId, 0, { title: 'doomed' });
    const keeper = await createStudyGuidePiece(admin, guideId, 1, { title: 'keeper' });
    const sharedId = await shareQuestionAcross(doomed, keeper);

    const { error } = await creatorClient.rpc('delete_study_guide_piece' as never, {
      _piece_id: doomed,
    } as never);
    expect(error).toBeNull();

    expect(await questionExists(sharedId)).toBe(true);
    expect(await linkedQuestionIds(keeper)).toEqual([sharedId]);
  });

  it('replacing a piece\'s questions keeps one another piece still uses', async () => {
    const guideId = await createStudyGuide(admin, courseId);
    const target = await createStudyGuidePiece(admin, guideId, 0, { title: 'target' });
    const keeper = await createStudyGuidePiece(admin, guideId, 1, { title: 'keeper' });
    const sharedId = await shareQuestionAcross(target, keeper);

    const { error } = await callRpc(target, [mcqRow('replacement')]);
    expect(error).toBeNull();

    // Survives, and keeps its link to the other piece — but loses the link to
    // the piece whose questions were replaced.
    expect(await questionExists(sharedId)).toBe(true);
    expect(await linkedQuestionIds(keeper)).toEqual([sharedId]);
    expect(await linkedQuestionIds(target)).not.toContain(sharedId);
  });

  it('clearing a guide keeps a question a piece in another guide still uses', async () => {
    const guideA = await createStudyGuide(admin, courseId);
    const pieceA = await createStudyGuidePiece(admin, guideA, 0);
    const guideB = await createStudyGuide(admin, courseId);
    const pieceB = await createStudyGuidePiece(admin, guideB, 0);
    const sharedId = await shareQuestionAcross(pieceA, pieceB);

    const { error } = await admin.rpc('clear_study_guide_pieces' as never, {
      _study_guide_id: guideA,
    } as never);
    expect(error).toBeNull();

    expect(await questionExists(sharedId)).toBe(true);
    expect(await linkedQuestionIds(pieceB)).toEqual([sharedId]);
  });

  it('rebuilding an outline keeps a question a piece in another guide still uses', async () => {
    const guideA = await createStudyGuide(admin, courseId);
    const pieceA = await createStudyGuidePiece(admin, guideA, 0);
    const guideB = await createStudyGuide(admin, courseId);
    const pieceB = await createStudyGuidePiece(admin, guideB, 0);
    const sharedId = await shareQuestionAcross(pieceA, pieceB);

    const { error } = await admin.rpc('replace_study_guide_outline' as never, {
      _study_guide_id: guideA,
      _pieces: [{ title: 'fresh' }],
    } as never);
    expect(error).toBeNull();

    expect(await questionExists(sharedId)).toBe(true);
    expect(await linkedQuestionIds(pieceB)).toEqual([sharedId]);
  });

  // The one-active-job-per-guide index was dropped with the generation job
  // itself (#1004): generation is now three instructor-initiated calls, and
  // `clear_study_guide_pieces` — which refuses when a student has answered — is
  // what actually guards a concurrent rebuild. The tests that covered the index
  // went with it rather than being rewritten to assert nothing.
});
