-- Atomic write of a study guide piece's questions (#978, review of #991).
--
-- Previously `processItem` inserted questions row-by-row through
-- `insertGeneratedQuestions` and then inserted the piece links in a second
-- statement. Two failure modes followed from that:
--
--   1. If the link insert failed, the question rows stayed committed with
--      nothing pointing at them. They were then invisible to any study-guide
--      cleanup AND — because the Question Bank filter added in #977 excludes
--      questions *present in* `study_guide_piece_questions` — they leaked
--      into the instructor's bank as orphans.
--   2. Retrying the item (max_attempts is 3) re-ran generation and inserted a
--      second full set, so a partial failure duplicated content and model
--      spend.
--
-- A plpgsql function runs in a single implicit transaction, so questions,
-- their chapter/competency junctions and the piece links now all commit or
-- all roll back. It also deletes the piece's previous content first, which
-- makes a retry idempotent instead of additive.
--
-- Per-row error tolerance is deliberately dropped here: study guides are
-- all-or-nothing (#978), so a piece that cannot write every question should
-- fail the item rather than silently ship a short piece.

CREATE OR REPLACE FUNCTION public.replace_study_guide_piece_questions(
  _piece_id uuid,
  _course_id uuid,
  _created_by uuid,
  _questions jsonb
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q               jsonb;
  new_question_id uuid;
  inserted_ids    uuid[] := ARRAY[]::uuid[];
  chapter         uuid;
  competency      uuid;
  position_index  int := 0;
  guide_id        uuid;
  answer_count    int;
BEGIN
  SELECT study_guide_id INTO guide_id
    FROM public.study_guide_pieces
   WHERE id = _piece_id;
  IF guide_id IS NULL THEN
    RAISE EXCEPTION 'study guide piece % not found', _piece_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF jsonb_typeof(_questions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'questions must be a json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF jsonb_array_length(_questions) = 0 THEN
    RAISE EXCEPTION 'questions must not be empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Refuse if a student has already answered one of this piece's questions.
  --
  -- Reachable on a retry: the RPC commits, the worker then dies before
  -- `markItemCompleted`, the item lease expires, and another worker re-runs
  -- the item. If a student answered in that window, deleting the previous
  -- questions would cascade their immutable submission away
  -- (`study_guide_answers.question_id` ON DELETE CASCADE).
  --
  -- `clear_study_guide_pieces` makes the same check guide-wide; this one is
  -- piece-scoped because a retry only ever replaces its own piece.
  --
  -- Lock the target questions BEFORE counting. Counting and then deleting is
  -- not atomic on its own under READ COMMITTED: the count takes one snapshot
  -- and the delete another, so an answer committing between them is invisible
  -- to the count and destroyed by the cascade. Inserting a
  -- `study_guide_answers` row takes a FOR KEY SHARE lock on the referenced
  -- `questions` row (the FK), which conflicts with FOR UPDATE — so holding
  -- FOR UPDATE here blocks any concurrent submission on these questions until
  -- this transaction ends, and any submission that got in first is visible to
  -- the count below.
  --
  -- Deliberately NOT solved by making `study_guide_answers.question_id`
  -- ON DELETE RESTRICT: `questions.course_id` is ON DELETE CASCADE, so
  -- RESTRICT would abort that cascade and make deleting a course (and the
  -- GDPR erasure paths that rely on it) fail whenever any study guide answer
  -- existed.
  PERFORM 1
     FROM public.questions
    WHERE id IN (
      SELECT pq.question_id
        FROM public.study_guide_piece_questions pq
       WHERE pq.piece_id = _piece_id
    )
      FOR UPDATE;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers a
    JOIN public.study_guide_piece_questions pq ON pq.question_id = a.question_id
   WHERE pq.piece_id = _piece_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide piece % has % student submission(s); replacing its questions would delete them',
      _piece_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Discard a previous attempt's content. Deleting the question rows cascades
  -- to study_guide_piece_questions, so the links go with them.
  DELETE FROM public.questions
   WHERE id IN (
     SELECT question_id
       FROM public.study_guide_piece_questions
      WHERE piece_id = _piece_id
   );

  FOR q IN SELECT * FROM jsonb_array_elements(_questions)
  LOOP
    INSERT INTO public.questions (
      course_id, question, type, payload, answer_key, explanation,
      difficulty, hidden, is_user_generated, competency_id,
      generation_rationale, created_by
    )
    VALUES (
      _course_id,
      q ->> 'question',
      q ->> 'type',
      COALESCE(q -> 'payload', '{}'::jsonb),
      COALESCE(q -> 'answer_key', '{}'::jsonb),
      COALESCE(q ->> 'explanation', ''),
      COALESCE(q ->> 'difficulty', 'medium'),
      false,
      false,
      NULLIF(q ->> 'competency_id', '')::uuid,
      NULLIF(q ->> 'generation_rationale', ''),
      _created_by
    )
    RETURNING id INTO new_question_id;

    inserted_ids := inserted_ids || new_question_id;

    IF jsonb_typeof(q -> 'chapter_ids') = 'array' THEN
      FOR chapter IN
        SELECT value::text::uuid FROM jsonb_array_elements_text(q -> 'chapter_ids') AS value
      LOOP
        INSERT INTO public.question_chapters (question_id, chapter_id)
        VALUES (new_question_id, chapter)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    IF jsonb_typeof(q -> 'competency_ids') = 'array' THEN
      FOR competency IN
        SELECT value::text::uuid FROM jsonb_array_elements_text(q -> 'competency_ids') AS value
      LOOP
        INSERT INTO public.question_competencies (question_id, competency_id)
        VALUES (new_question_id, competency)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    INSERT INTO public.study_guide_piece_questions (piece_id, question_id, position)
    VALUES (_piece_id, new_question_id, position_index);

    position_index := position_index + 1;
  END LOOP;

  RETURN inserted_ids;
END;
$$;

-- Service-role workers only. The job runner is the sole caller; instructors
-- edit pieces through ordinary RLS-checked statements.
REVOKE ALL ON FUNCTION public.replace_study_guide_piece_questions(uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_study_guide_piece_questions(uuid, uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.replace_study_guide_piece_questions(uuid, uuid, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_study_guide_piece_questions(uuid, uuid, uuid, jsonb) TO service_role;

-- ============================================================================
-- Clearing a previous attempt (#991 review, round 2).
--
-- Deleting `study_guide_pieces` does NOT delete the generated questions. The
-- ON DELETE CASCADE on `study_guide_piece_questions.piece_id` removes the
-- JUNCTION rows — cascade runs parent -> child, and `questions` is the
-- junction's other parent, not its child. So a naive
-- `DELETE FROM study_guide_pieces WHERE study_guide_id = ...` destroys exactly
-- the links that identify which questions belonged to the guide, stranding
-- them: invisible to `replace_study_guide_piece_questions` (which finds
-- questions through those links) and visible in the instructor's Question
-- Bank, whose #977 filter excludes only questions still linked to a piece.
--
-- The questions must therefore be deleted BEFORE the pieces, in one
-- transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.clear_study_guide_pieces(_study_guide_id uuid)
RETURNS TABLE (deleted_questions int, deleted_pieces int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q_count int;
  p_count int;
  answer_count int;
BEGIN
  -- Refuse when students have submitted. `study_guide_answers.question_id`
  -- cascades, so deleting the questions would take immutable, unreconstructable
  -- submissions with them (#977).
  --
  -- The enqueue function checks this too, but that check is a
  -- time-of-check/time-of-use race: a student can submit between it and this
  -- cleanup, which the background job may run a cron tick or more later. This
  -- is the authoritative check because it runs in the same transaction as the
  -- delete — same reason the one-active-job rule is a unique index rather than
  -- a SELECT. The enqueue check stays purely as the friendly early 409.
  --
  -- Raising leaves the guide's existing content intact (the transaction rolls
  -- back) and fails the job loudly, which is strictly better than silently
  -- destroying student work.
  -- Lock the target questions before counting, for the same reason as in
  -- `replace_study_guide_piece_questions`: count-then-delete is not atomic
  -- under READ COMMITTED, and an answer INSERT takes a conflicting
  -- FOR KEY SHARE lock on the referenced `questions` row.
  PERFORM 1
     FROM public.questions
    WHERE id IN (
      SELECT pq.question_id
        FROM public.study_guide_piece_questions pq
        JOIN public.study_guide_pieces p ON p.id = pq.piece_id
       WHERE p.study_guide_id = _study_guide_id
    )
      FOR UPDATE;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE study_guide_id = _study_guide_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide % has % student submission(s); regenerating would delete them',
      _study_guide_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  DELETE FROM public.questions
   WHERE id IN (
     SELECT pq.question_id
       FROM public.study_guide_piece_questions pq
       JOIN public.study_guide_pieces p ON p.id = pq.piece_id
      WHERE p.study_guide_id = _study_guide_id
   );
  GET DIAGNOSTICS q_count = ROW_COUNT;

  DELETE FROM public.study_guide_pieces
   WHERE study_guide_id = _study_guide_id;
  GET DIAGNOSTICS p_count = ROW_COUNT;

  RETURN QUERY SELECT q_count, p_count;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_study_guide_pieces(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_study_guide_pieces(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.clear_study_guide_pieces(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_study_guide_pieces(uuid) TO service_role;

-- ============================================================================
-- One active generation job per study guide (#991 review).
--
-- The enqueue function's "is a job already running?" SELECT is a
-- time-of-check/time-of-use race: two concurrent authorized requests can both
-- pass it before either inserts, then both reset the guide's pieces and
-- enqueue. The loser can later mark the guide failed while the winner is
-- still generating. A partial unique index makes the database the arbiter;
-- the handler catches the violation and returns the same 409 it always did.
-- ============================================================================

CREATE UNIQUE INDEX idx_jobs_one_active_study_guide_generation
  ON public.jobs ((params ->> 'studyGuideId'))
  WHERE type = 'study_guide_generation'
    AND status IN ('pending', 'processing');
