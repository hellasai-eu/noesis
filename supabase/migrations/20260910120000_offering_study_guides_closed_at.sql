-- Study guide assignments can be marked as done (#offering_study_guides v2).
--
-- The v1 junction (20260727120000) shipped `due_date` as advisory only, with
-- an explicit "no closed_at in v1" note. This is v2: instructors get a
-- "Mark as done" action, and the instructor surfaces additionally treat a
-- passed `due_date` as done automatically.
--
-- Two distinct notions, on purpose (mirroring quizzes):
--   * DONE (derived, instructor surfaces): `closed_at IS NOT NULL` OR the
--     `due_date` has passed. Purely presentational — computed in the frontend
--     and never stored, so it needs no cron to flip rows at the deadline.
--   * CLOSED (stored, enforced): `closed_at IS NOT NULL`. Only the explicit
--     instructor action locks students out of submitting. A passed due date
--     alone does NOT block a mid-guide student — the same rule quizzes follow,
--     where a started attempt stays resumable past its deadline and only
--     `offering_quizzes.closed_at` hard-stops new work.
--
-- Closure is per-assignment (offering_study_guides row), matching
-- 20260605000000_offering_quizzes_closed_at.sql. No RPC is needed here:
-- unlike quizzes there are no in-progress sessions to force-finalize, so the
-- instructor UI updates the rows directly under the existing
-- "Managers can manage offering study guides" policy.

ALTER TABLE public.offering_study_guides
  ADD COLUMN closed_at TIMESTAMP WITH TIME ZONE;

-- Enforcement: `study_guide_assigned_in_offering` is the WITH CHECK behind
-- both student write paths (`study_guide_progress` and `study_guide_answers`),
-- so requiring an open row here closes both at once. Visibility deliberately
-- keeps using `study_guide_published_to_user`, which is untouched: students
-- still see a closed guide's content, their answers and their results — they
-- just cannot submit new work or advance progress against it.
CREATE OR REPLACE FUNCTION public.study_guide_assigned_in_offering(
  _study_guide_id UUID,
  _offering_id UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.offering_study_guides osg
    WHERE osg.study_guide_id = _study_guide_id
      AND osg.offering_id = _offering_id
      AND osg.published_at IS NOT NULL
      AND osg.closed_at IS NULL
      AND public.has_offering_access(osg.offering_id)
      AND (osg.group_id IS NULL OR public.is_offering_group_member(osg.group_id))
  )
$$;

-- Defense in depth for the service-role submission path: the edge function
-- (`submit-study-guide-piece`) checks closure per student, including group
-- scoping; this backstop only refuses when EVERY published row for the
-- (guide, offering) pair is closed, so a student whose own group row is open
-- is never wrongly blocked. Body otherwise identical to 20260728230000.
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

  -- Closure backstop (see header). Published-but-all-closed refuses; a pair
  -- with no published row at all is left to the caller's enrollment check,
  -- which produces the accurate "not authorized" answer.
  IF EXISTS (
       SELECT 1 FROM public.offering_study_guides osg
       WHERE osg.study_guide_id = _study_guide_id
         AND osg.offering_id = _offering_id
         AND osg.published_at IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.offering_study_guides osg
       WHERE osg.study_guide_id = _study_guide_id
         AND osg.offering_id = _offering_id
         AND osg.published_at IS NOT NULL
         AND osg.closed_at IS NULL
     )
  THEN
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
