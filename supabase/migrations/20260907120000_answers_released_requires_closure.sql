-- Answers may only be released to a class once the assignment is marked as done.
-- Until then students can still be taking the quiz, and releasing the answers
-- hands them the answer key mid-attempt.
--
-- The rule was only enforced in the instructor UI, which leaves it to any stale
-- tab or alternate client to write `answers_released = true` on an open
-- assignment, and made reopening a two-step client-side dance that could leave a
-- reopened assignment with its answers still released. This makes it a database
-- invariant instead.

-- Legacy rows: the previous UI allowed releasing answers on an open assignment,
-- so retract those releases before the constraint is validated. Instructors can
-- release them again once they mark the assignment as done.
UPDATE public.offering_quizzes
   SET answers_released = false
 WHERE answers_released
   AND closed_at IS NULL;

ALTER TABLE public.offering_quizzes
  ADD CONSTRAINT offering_quizzes_answers_released_requires_closure
  CHECK (NOT answers_released OR closed_at IS NOT NULL);

-- Reopening now retracts the release in the same statement, so an assignment is
-- never simultaneously open and released — and the constraint above would reject
-- the reopen if it tried.
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
    SET closed_at = NULL, answers_released = false, updated_at = now()
    WHERE id = p_offering_quiz_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_offering_quiz(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reopen_offering_quiz(uuid) TO authenticated;
