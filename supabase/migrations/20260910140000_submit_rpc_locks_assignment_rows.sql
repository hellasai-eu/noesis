-- Serialize the submit RPC's closure backstop against a concurrent close
-- (PR #1350 review, round 2).
--
-- 20260910120000 added a closure check to `submit_study_guide_piece_answers`
-- that READ the assignment rows without locking them: an instructor's
-- Mark-as-done could commit between that check and the answer insert, letting
-- a submission persist against an assignment that was already closed. The
-- check now takes FOR SHARE locks on the assignment rows first, so a
-- concurrent `UPDATE ... SET closed_at` blocks until this transaction
-- commits (the submission wins, having genuinely started first) or, having
-- committed first, is seen by the check (the submission is refused).
--
-- The backstop's row scope is unchanged and deliberately conservative: it
-- refuses only when EVERY published row for the (guide, offering) pair is
-- closed. Per-student scoping (which group row authorizes THIS student) is
-- the edge function's job — `verify-study-guide-enrollment` does it with the
-- student's memberships in hand; doing it here would need those memberships
-- re-derived under the service role for no additional safety, since a student
-- whose own route is closed is already refused there.

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
  v_published     int;
  v_open          int;
BEGIN
  IF jsonb_typeof(_answers) IS DISTINCT FROM 'array' OR jsonb_array_length(_answers) = 0 THEN
    RAISE EXCEPTION 'answers must be a non-empty json array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Closure backstop (see header). FOR SHARE in the subquery locks the rows
  -- before counting, serializing with a concurrent Mark-as-done.
  SELECT count(*), count(*) FILTER (WHERE t.closed_at IS NULL)
    INTO v_published, v_open
    FROM (
      SELECT osg.closed_at
      FROM public.offering_study_guides osg
      WHERE osg.study_guide_id = _study_guide_id
        AND osg.offering_id = _offering_id
        AND osg.published_at IS NOT NULL
      FOR SHARE
    ) t;

  IF v_published > 0 AND v_open = 0 THEN
    RAISE EXCEPTION 'study guide is closed for this offering'
      USING ERRCODE = 'raise_exception';
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
