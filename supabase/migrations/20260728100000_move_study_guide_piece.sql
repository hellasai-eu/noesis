-- Atomic reorder of a study guide piece (#979).
--
-- `study_guide_pieces` has UNIQUE (study_guide_id, position), so swapping two
-- pieces cannot be done as two sequential UPDATEs from the client: the first
-- would collide with the neighbour it is trying to swap with. Doing it as ONE
-- statement works because the constraint is DEFERRABLE, so uniqueness is
-- checked at end of statement rather than per row — but PostgREST cannot
-- express a CASE-based update, hence this function.
--
-- Runs as the caller (SECURITY INVOKER) so the existing RLS on
-- `study_guide_pieces` decides who may reorder. There is deliberately no
-- separate permission check here: a manager can already UPDATE these rows, and
-- a student cannot.

CREATE OR REPLACE FUNCTION public.move_study_guide_piece(
  _piece_id uuid,
  _direction text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  guide_id       uuid;
  current_pos    int;
  neighbour_id   uuid;
  neighbour_pos  int;
BEGIN
  IF _direction NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'direction must be "up" or "down", got %', _direction
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT study_guide_id, position INTO guide_id, current_pos
    FROM public.study_guide_pieces
   WHERE id = _piece_id;

  IF guide_id IS NULL THEN
    RAISE EXCEPTION 'study guide piece % not found', _piece_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The adjacent piece in the requested direction. Selecting the nearest
  -- neighbour rather than position ± 1 keeps this correct even if positions
  -- ever end up non-contiguous.
  IF _direction = 'up' THEN
    SELECT id, position INTO neighbour_id, neighbour_pos
      FROM public.study_guide_pieces
     WHERE study_guide_id = guide_id AND position < current_pos
     ORDER BY position DESC
     LIMIT 1;
  ELSE
    SELECT id, position INTO neighbour_id, neighbour_pos
      FROM public.study_guide_pieces
     WHERE study_guide_id = guide_id AND position > current_pos
     ORDER BY position ASC
     LIMIT 1;
  END IF;

  -- Already at the end: a no-op rather than an error, so the UI can leave the
  -- button enabled without having to know the bounds.
  IF neighbour_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.study_guide_pieces
     SET position = CASE id
                      WHEN _piece_id THEN neighbour_pos
                      ELSE current_pos
                    END
   WHERE id IN (_piece_id, neighbour_id);
END;
$$;

REVOKE ALL ON FUNCTION public.move_study_guide_piece(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.move_study_guide_piece(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.move_study_guide_piece(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.move_study_guide_piece(uuid, text) TO service_role;

-- ============================================================================
-- Deleting a single generated question (#979).
--
-- A plain `DELETE FROM questions` from the editor would look harmless and
-- silently destroy student work: `study_guide_answers.question_id` is
-- ON DELETE CASCADE, so any submission on that question goes with it. Same
-- hazard the regeneration paths already guard against (#978 review rounds
-- 4-6), so it gets the same treatment — lock the row, re-check in the same
-- transaction, refuse rather than cascade.
--
-- Not solved with ON DELETE RESTRICT for the reason recorded in
-- 20260727190000: `questions.course_id` is ON DELETE CASCADE, so RESTRICT
-- would make deleting a course fail whenever any answer existed.
--
-- SECURITY DEFINER, NOT invoker. A guard function that counts rows the caller
-- may not be allowed to SEE must define away RLS, or its count is RLS-scoped
-- while the write it guards is not: a section-restricted instructor would get
-- zero for a question answered only in another section, and the delete would
-- cascade those answers away regardless. Same reason `delete_study_guide`
-- below is a definer. The authorization check therefore has to be explicit,
-- since defining away RLS also defines away the policy that would have
-- enforced it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_study_guide_question(_question_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  answer_count    int;
  question_course uuid;
BEGIN
  -- Lock first: count-then-delete is not atomic under READ COMMITTED, and an
  -- answer INSERT takes a conflicting FOR KEY SHARE lock on this row via the FK.
  SELECT course_id INTO question_course
    FROM public.questions
   WHERE id = _question_id
     FOR UPDATE;

  IF question_course IS NULL THEN
    RAISE EXCEPTION 'question % not found', _question_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = question_course)
       )
    OR public.is_course_instructor(question_course, auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized to delete question %', _question_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Counted across every offering, which is the whole point of the definer.
  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE question_id = _question_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'question % has % student submission(s) and cannot be removed',
      _question_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  DELETE FROM public.questions WHERE id = _question_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_study_guide_question(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_study_guide_question(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_study_guide_question(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_study_guide_question(uuid) TO service_role;

-- ============================================================================
-- Deleting a whole study guide (#979, review of #997).
--
-- A client-side `DELETE FROM study_guides` cannot be trusted to warn the
-- instructor accurately. The manager computed "does this guide have
-- submissions?" from a browser query, which RLS scopes to the offerings the
-- caller can manage — but the delete itself cascades across EVERY offering.
-- An instructor restricted by `course_instructor_sections` would therefore be
-- shown "no submissions" while irreversibly destroying another section's
-- answers.
--
-- SECURITY DEFINER so the count sees all offerings, with the manager check
-- done explicitly since defining away RLS also defines away the policy that
-- would otherwise have enforced it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_study_guide(_study_guide_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  guide_course uuid;
  answer_count int;
BEGIN
  -- FOR UPDATE, not a bare SELECT. Counting and then deleting is not atomic
  -- under READ COMMITTED, so a student submitting between the two would be
  -- invisible to the count and cascaded away by the delete.
  --
  -- Locking the `study_guides` row is what closes it: every
  -- `study_guide_answers` insert takes a FOR KEY SHARE lock on this row via
  -- `study_guide_answers.study_guide_id`, which conflicts with FOR UPDATE. So
  -- a concurrent submission blocks until this transaction ends, and one that
  -- got in first is visible to the count below.
  --
  -- Same rule as clear_study_guide_pieces and
  -- replace_study_guide_piece_questions in 20260727190000.
  SELECT course_id INTO guide_course
    FROM public.study_guides
   WHERE id = _study_guide_id
     FOR UPDATE;

  IF guide_course IS NULL THEN
    RAISE EXCEPTION 'study guide % not found', _study_guide_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = guide_course)
       )
    OR public.is_course_instructor(guide_course, auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized to delete study guide %', _study_guide_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Counted across every offering, which is the whole point of the definer.
  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE study_guide_id = _study_guide_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide % has % student submission(s) and cannot be deleted',
      _study_guide_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  DELETE FROM public.study_guides WHERE id = _study_guide_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_study_guide(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_study_guide(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_study_guide(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_study_guide(uuid) TO service_role;
