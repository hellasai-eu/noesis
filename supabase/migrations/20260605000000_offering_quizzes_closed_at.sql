-- Lets instructors close an assigned quiz: students can no longer start fresh
-- attempts or submit answers, but existing answers and scores remain visible.
-- Closure is per-assignment (offering_quiz), not per-quiz-template — closing in
-- one class does not affect any other class the quiz is assigned to.
ALTER TABLE public.offering_quizzes
  ADD COLUMN closed_at timestamptz NULL;

-- Replace the quiz_sessions INSERT policy with one that also rejects new sessions
-- for closed assignments. SELECT/UPDATE stay open so students can still review
-- prior attempts and instructors can still force-complete sessions.
DROP POLICY IF EXISTS "Users can create their own quiz sessions" ON public.quiz_sessions;
CREATE POLICY "Users can create their own quiz sessions"
ON public.quiz_sessions
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND NOT EXISTS (
    SELECT 1
    FROM public.offering_quizzes oq
    WHERE oq.quiz_id = quiz_sessions.quiz_id
      AND oq.offering_id = quiz_sessions.offering_id
      AND oq.closed_at IS NOT NULL
  )
);

-- Same gate for quiz_answers: a student with an existing in-progress session
-- cannot insert new answers after closure. We match against the answer's own
-- (quiz_id, offering_id) — both columns are populated by the client on insert.
-- Rows where offering_id is NULL (legacy / practice-mode) are unaffected.
DROP POLICY IF EXISTS "Users can submit quiz answers" ON public.quiz_answers;
CREATE POLICY "Users can submit quiz answers"
ON public.quiz_answers
FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND NOT EXISTS (
    SELECT 1
    FROM public.offering_quizzes oq
    WHERE oq.quiz_id = quiz_answers.quiz_id
      AND oq.offering_id = quiz_answers.offering_id
      AND oq.closed_at IS NOT NULL
  )
);

-- Marks an assignment as done and force-finalizes any in-progress attempts.
-- Auto-finalize: each in-progress session for this offering_quiz becomes
-- status='completed', completed_at=now(); the score is whatever quiz_answers
-- rows the student already has. Caller must be an instructor of the course
-- (or institution/super admin).
CREATE OR REPLACE FUNCTION public.mark_offering_quiz_done(p_offering_quiz_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quiz_id uuid;
  v_offering_id uuid;
  v_course_id uuid;
  v_institution_id uuid;
  v_closed_at timestamptz;
BEGIN
  SELECT oq.quiz_id, oq.offering_id, q.course_id, c.institution_id
    INTO v_quiz_id, v_offering_id, v_course_id, v_institution_id
  FROM public.offering_quizzes oq
  JOIN public.quizzes q ON q.id = oq.quiz_id
  JOIN public.courses c ON c.id = q.course_id
  WHERE oq.id = p_offering_quiz_id;

  IF v_quiz_id IS NULL THEN
    RAISE EXCEPTION 'Assignment not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_course_instructor(v_course_id, auth.uid())
    OR public.is_institution_admin(auth.uid(), v_institution_id)
  ) THEN
    RAISE EXCEPTION 'Not authorized to close this assignment' USING ERRCODE = '42501';
  END IF;

  v_closed_at := now();

  UPDATE public.offering_quizzes
    SET closed_at = v_closed_at, updated_at = v_closed_at
    WHERE id = p_offering_quiz_id;

  -- Force-finalize any in-progress attempts. Scores already exist in
  -- quiz_answers; instructors see them immediately under the new completed
  -- status. We intentionally do not touch already-completed/expired rows.
  UPDATE public.quiz_sessions
    SET status = 'completed', completed_at = v_closed_at
    WHERE quiz_id = v_quiz_id
      AND offering_id = v_offering_id
      AND status = 'in_progress';

  RETURN v_closed_at;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_offering_quiz_done(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_offering_quiz_done(uuid) TO authenticated;

-- Reopens a closed assignment. Sessions auto-finalized at closure stay
-- completed (no data loss); students simply regain the ability to start new
-- attempts where they hadn't completed one yet.
CREATE OR REPLACE FUNCTION public.reopen_offering_quiz(p_offering_quiz_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_id uuid;
  v_institution_id uuid;
BEGIN
  SELECT q.course_id, c.institution_id
    INTO v_course_id, v_institution_id
  FROM public.offering_quizzes oq
  JOIN public.quizzes q ON q.id = oq.quiz_id
  JOIN public.courses c ON c.id = q.course_id
  WHERE oq.id = p_offering_quiz_id;

  IF v_course_id IS NULL THEN
    RAISE EXCEPTION 'Assignment not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_course_instructor(v_course_id, auth.uid())
    OR public.is_institution_admin(auth.uid(), v_institution_id)
  ) THEN
    RAISE EXCEPTION 'Not authorized to reopen this assignment' USING ERRCODE = '42501';
  END IF;

  UPDATE public.offering_quizzes
    SET closed_at = NULL, updated_at = now()
    WHERE id = p_offering_quiz_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_offering_quiz(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_offering_quiz(uuid) TO authenticated;
