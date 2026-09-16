-- Delete a single study guide piece (#1005).
--
-- Reordering alone was not enough: an outline sometimes proposes a piece the
-- instructor does not want, and the only remedy was rebuilding the whole guide.
--
-- Not a plain DELETE from the client, for three reasons:
--
--   1. Deleting the piece does NOT delete its generated questions. The cascade
--      on study_guide_piece_questions.piece_id removes the JUNCTION rows —
--      cascade runs parent -> child, and `questions` is the junction's other
--      parent — so a client-side delete would strand them in the instructor's
--      Question Bank with nothing left to identify them by.
--
--   2. `study_guide_answers.piece_id` cascades, so a piece a student has
--      already worked through would take their immutable submissions with it.
--      Counted here as SECURITY DEFINER: under the caller's RLS a
--      section-restricted instructor sees zero for answers submitted in another
--      section, while the delete cascades across all of them.
--
--   3. Removing a piece leaves a gap in `position`. Students advance strictly
--      piece by piece (#980), so the remaining pieces are renumbered to stay
--      contiguous. The shift is a single UPDATE, which the DEFERRABLE
--      UNIQUE (study_guide_id, position) constraint tolerates because it is
--      checked at end of statement rather than per row.

CREATE OR REPLACE FUNCTION public.delete_study_guide_piece(_piece_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  guide_id         uuid;
  guide_course     uuid;
  removed_position int;
  answer_count     int;
BEGIN
  -- FOR UPDATE before counting: count-then-delete is not atomic under READ
  -- COMMITTED, and a study_guide_answers insert takes FOR KEY SHARE on this
  -- row via its FK, which conflicts.
  SELECT p.study_guide_id, p.position INTO guide_id, removed_position
    FROM public.study_guide_pieces p
   WHERE p.id = _piece_id
     FOR UPDATE;

  IF guide_id IS NULL THEN
    RAISE EXCEPTION 'study guide piece % not found', _piece_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT sg.course_id INTO guide_course
    FROM public.study_guides sg
   WHERE sg.id = guide_id;

  -- SECURITY DEFINER bypasses RLS, so the manager check has to be explicit.
  IF NOT (
    public.is_super_admin(auth.uid())
    OR public.is_institution_admin(
         auth.uid(),
         (SELECT c.institution_id FROM public.courses c WHERE c.id = guide_course)
       )
    OR public.is_course_instructor(guide_course, auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized to delete piece %', _piece_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT count(*) INTO answer_count
    FROM public.study_guide_answers
   WHERE piece_id = _piece_id;

  IF answer_count > 0 THEN
    RAISE EXCEPTION
      'study guide piece % has % student submission(s) and cannot be deleted',
      _piece_id, answer_count
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Questions first, or the junction rows that identify them vanish with the
  -- piece and leave them orphaned in the course.
  DELETE FROM public.questions
   WHERE id IN (
     SELECT pq.question_id
       FROM public.study_guide_piece_questions pq
      WHERE pq.piece_id = _piece_id
   );

  DELETE FROM public.study_guide_pieces WHERE id = _piece_id;

  UPDATE public.study_guide_pieces
     SET position = position - 1
   WHERE study_guide_id = guide_id
     AND position > removed_position;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_study_guide_piece(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_study_guide_piece(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_study_guide_piece(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_study_guide_piece(uuid) TO service_role;
