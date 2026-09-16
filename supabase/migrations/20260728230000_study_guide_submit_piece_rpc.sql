-- Atomic study-guide piece submission (#980 review).
--
-- `submit-study-guide-piece` previously inserted the graded
-- `study_guide_answers` rows and then, in a SEPARATE statement, upserted
-- `study_guide_progress` to advance `current_piece_position`. If the second
-- statement failed (a dropped connection, a transient DB error), the answers
-- were already committed but progress stayed on the just-submitted piece.
-- The one-shot-per-question unique constraint then makes every retry return
-- `already_submitted`, permanently stranding the student on a piece they
-- can never re-submit and whose progress can never advance.
--
-- A single plpgsql function runs both writes in one implicit transaction, so
-- they commit or roll back together. It also re-checks that the piece is the
-- student's CURRENT piece (defense in depth alongside the same check the
-- edge function makes before grading) — the sole DB-level guard against a
-- direct RPC call skipping ahead to a future, not-yet-unlocked piece.
CREATE OR REPLACE FUNCTION public.submit_study_guide_piece_answers(
  _user_id uuid,
  _study_guide_id uuid,
  _offering_id uuid,
  _piece_id uuid,
  _piece_position int,
  _is_final boolean,
  _answers jsonb
)
RETURNS TABLE (current_piece_position int, completed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a               jsonb;
  now_ts          timestamptz := now();
  existing_pos    int;
  existing_done   timestamptz;
  existing_draft  jsonb;
  next_pos        int;
  next_done       timestamptz;
BEGIN
  IF jsonb_typeof(_answers) IS DISTINCT FROM 'array' OR jsonb_array_length(_answers) = 0 THEN
    RAISE EXCEPTION 'answers must be a non-empty json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock the progress row (if any) so two concurrent submits for the same
  -- student/guide/offering serialize instead of racing on the check below.
  SELECT p.current_piece_position, p.completed_at, p.draft_answers
    INTO existing_pos, existing_done, existing_draft
    FROM public.study_guide_progress p
   WHERE p.user_id = _user_id
     AND p.study_guide_id = _study_guide_id
     AND p.offering_id = _offering_id
     FOR UPDATE;

  IF existing_pos IS NULL THEN
    existing_pos := 0;
  END IF;

  IF existing_pos IS DISTINCT FROM _piece_position THEN
    RAISE EXCEPTION
      'piece at position % is not the current piece (progress is at position %)',
      _piece_position, existing_pos
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.study_guide_answers (
    user_id, study_guide_id, offering_id, piece_id, question_id,
    submission, is_correct, grade, feedback, strengths, areas_for_improvement,
    graded_at
  )
  SELECT
    _user_id, _study_guide_id, _offering_id, _piece_id,
    (elem ->> 'question_id')::uuid,
    COALESCE(elem -> 'submission', '{}'::jsonb),
    (elem ->> 'is_correct')::boolean,
    (elem ->> 'grade')::numeric,
    elem ->> 'feedback',
    CASE WHEN jsonb_typeof(elem -> 'strengths') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(elem -> 'strengths'))
      ELSE NULL END,
    CASE WHEN jsonb_typeof(elem -> 'areas_for_improvement') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(elem -> 'areas_for_improvement'))
      ELSE NULL END,
    now_ts
  FROM jsonb_array_elements(_answers) elem;

  next_pos := GREATEST(existing_pos, _piece_position + 1);
  next_done := CASE WHEN _is_final THEN COALESCE(existing_done, now_ts) ELSE existing_done END;

  -- Clear this piece's draft; leave any other pieces' drafts intact.
  IF existing_draft IS NOT NULL AND jsonb_typeof(existing_draft) = 'object' THEN
    existing_draft := existing_draft - _piece_id::text;
  END IF;

  INSERT INTO public.study_guide_progress (
    user_id, study_guide_id, offering_id, current_piece_position, completed_at,
    draft_answers, updated_at
  )
  VALUES (
    _user_id, _study_guide_id, _offering_id, next_pos, next_done,
    existing_draft, now_ts
  )
  ON CONFLICT (user_id, study_guide_id, offering_id) DO UPDATE SET
    current_piece_position = EXCLUDED.current_piece_position,
    completed_at = EXCLUDED.completed_at,
    draft_answers = EXCLUDED.draft_answers,
    updated_at = EXCLUDED.updated_at;

  RETURN QUERY SELECT next_pos, next_done;
END;
$$;

-- Service-role only. The edge function authenticates the student via their
-- JWT and passes `_user_id` explicitly, so nothing here should be callable
-- directly by `authenticated`/`anon` (that would let a caller pass an
-- arbitrary `_user_id`).
REVOKE ALL ON FUNCTION public.submit_study_guide_piece_answers(
  uuid, uuid, uuid, uuid, int, boolean, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_study_guide_piece_answers(
  uuid, uuid, uuid, uuid, int, boolean, jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.submit_study_guide_piece_answers(
  uuid, uuid, uuid, uuid, int, boolean, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.submit_study_guide_piece_answers(
  uuid, uuid, uuid, uuid, int, boolean, jsonb
) TO service_role;
