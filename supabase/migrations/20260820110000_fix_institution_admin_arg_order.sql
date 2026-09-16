-- Fix #1128: is_institution_admin() called with its arguments reversed.
--
-- The helper is
--
--   is_institution_admin(_user_id uuid, _institution_id uuid)
--
-- and every other policy in the schema calls it that way round. Four policies
-- on the tutor-state tables pass (institution_id, auth.uid()) instead. Both
-- parameters are uuid, so it type-checks and fails silently: the predicate
-- looks for a user_institutions row whose user_id is an institution id and
-- whose institution_id is a user id, which can never match. It is constant
-- false.
--
-- It fails closed, so this was a functional bug rather than a leak — the
-- institution-admin visibility these policies were written to grant has never
-- worked. Because these four are the only admin path on those tables (none of
-- them calls is_super_admin), super admins were shut out too. Instructors were
-- unaffected: the sibling policies use is_course_instructor(course_id,
-- auth.uid()), which is correct.
--
-- An audit of every two-argument auth helper (is_institution_admin,
-- user_belongs_to_institution, is_institution_instructor_for_course,
-- is_course_instructor, is_course_evaluator, user_can_access_course,
-- user_has_class_course_access, user_has_any_course_tag) against every policy
-- expression found these four and nothing else.
--
-- Each policy below is recreated verbatim apart from the argument order.

-- ---------------------------------------------------------------------------
-- socratic_session_state
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read institution session states"
  ON public.socratic_session_state;

CREATE POLICY "Admins can read institution session states"
  ON public.socratic_session_state FOR SELECT
  USING (
    is_institution_admin(
      auth.uid(),
      (SELECT courses.institution_id FROM courses
        WHERE courses.id = socratic_session_state.course_id)
    )
  );

-- ---------------------------------------------------------------------------
-- study_tutor_session_state
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read institution session states"
  ON public.study_tutor_session_state;

CREATE POLICY "Admins can read institution session states"
  ON public.study_tutor_session_state FOR SELECT
  USING (
    is_institution_admin(
      auth.uid(),
      (SELECT courses.institution_id FROM courses
        WHERE courses.id = study_tutor_session_state.course_id)
    )
  );

-- ---------------------------------------------------------------------------
-- socratic_state_history
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read institution state history"
  ON public.socratic_state_history;

CREATE POLICY "Admins can read institution state history"
  ON public.socratic_state_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM socratic_session_state s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = socratic_state_history.session_state_id
        AND is_institution_admin(auth.uid(), c.institution_id)
    )
  );

-- ---------------------------------------------------------------------------
-- study_tutor_state_history
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can read institution state history"
  ON public.study_tutor_state_history;

CREATE POLICY "Admins can read institution state history"
  ON public.study_tutor_state_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM study_tutor_session_state s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = study_tutor_state_history.session_state_id
        AND is_institution_admin(auth.uid(), c.institution_id)
    )
  );
