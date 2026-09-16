-- Unified per-type question editor (#1001)
--
-- Adds a SECURITY DEFINER RPC that edits a question's *content* columns
-- (stem, payload, answer_key, explanation, difficulty) in place, refusing the
-- edit when any student has already answered the question.
--
-- Why a definer function rather than a client-side `.from('questions').update`:
-- the refuse-if-answered check must count every answer, including answers in
-- sections/offerings the calling instructor cannot see under RLS. An
-- RLS-scoped count would under-report and let an edit through that silently
-- invalidates a submitted answer (study-guide and quiz answers are immutable —
-- one row per (student, question), no resubmit). This mirrors exactly why
-- `delete_study_guide_question` (20260728100000_move_study_guide_piece.sql) is a
-- definer. Unlike that delete guard, this one also counts `quiz_answers`,
-- because a Question Bank row can be used in quizzes as well as study guides.
--
-- Deliberately does NOT change `questions.type` — changing a question's type is
-- a delete-and-recreate, out of scope for this editor (#1001).

CREATE OR REPLACE FUNCTION public.update_question_content(
  _question_id uuid,
  _question    text,
  _payload     jsonb,
  _answer_key  jsonb,
  _explanation text,
  _difficulty  text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  answer_count    int;
  question_course uuid;
BEGIN
  -- Lock first: count-then-update is not atomic under READ COMMITTED, and an
  -- answer INSERT takes a conflicting FOR KEY SHARE lock on this row via the FK.
  -- Locking here closes the "count says zero, then the answer row lands, then we
  -- overwrite the key it was answered against" race for the INSERT itself.
  --
  -- Residual window (NOT closed here): a submission grades the answer_key in one
  -- (already-committed) transaction and INSERTs the graded row in a *later* one
  -- (submit_study_guide_piece_answers / client-side quiz grading). This lock
  -- only serializes against that INSERT, so an edit can still slip in after the
  -- grading read but before the insert, persisting a grade computed against the
  -- OLD key under a question that now shows the NEW key. Fully closing it means
  -- re-grading/verifying under a FOR KEY SHARE lock inside the inserting
  -- transaction — a change to the submission path, tracked separately (#1094).
  SELECT course_id INTO question_course
    FROM public.questions
   WHERE id = _question_id
     FOR UPDATE;

  IF question_course IS NULL THEN
    RAISE EXCEPTION 'question % not found', _question_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- DEFINER bypasses RLS, so authorize explicitly. Same predicate as the
  -- delete guard: super-admin, this course's institution admin, or an
  -- instructor on the course.
  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = question_course)
       )
    OR public.is_course_instructor(question_course, auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized to edit question %', _question_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Counted across every offering (the point of the definer), and across BOTH
  -- answer surfaces a question can appear in.
  SELECT
    (SELECT count(*) FROM public.study_guide_answers WHERE question_id = _question_id)
    + (SELECT count(*) FROM public.quiz_answers WHERE question_id = _question_id)
  INTO answer_count;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'question % has % student submission(s) and cannot be edited',
      _question_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE public.questions
     SET question    = _question,
         payload     = _payload,
         answer_key  = _answer_key,
         explanation = _explanation,
         difficulty  = _difficulty,
         updated_at  = now()
   WHERE id = _question_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_question_content(uuid, text, jsonb, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_question_content(uuid, text, jsonb, jsonb, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_question_content(uuid, text, jsonb, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_question_content(uuid, text, jsonb, jsonb, text, text) TO service_role;
