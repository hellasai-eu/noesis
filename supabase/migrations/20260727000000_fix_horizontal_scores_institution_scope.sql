-- Fix the institution-scoped read on student_horizontal_scores.
--
-- 20260426000000_horizontal_competencies.sql intended (per its own comment)
-- "any instructor at the institution can see cross-grade scores", and
-- StudentEvaluations.tsx relies on exactly that: it queries
-- student_horizontal_scores with NO course_id filter and lets RLS scope the
-- result to the institution.
--
-- The policy resolved the score's institution with a nested lookup:
--
--   c.institution_id = (SELECT c2.institution_id FROM courses c2
--                        WHERE c2.id = student_horizontal_scores.course_id)
--
-- A subquery inside a policy is NOT security-definer — it is evaluated with
-- the caller's own RLS applied. `courses` SELECT only exposes a course to its
-- own instructor / an admin / a student with class access, so for any
-- instructor who does not personally teach the scored course the subquery
-- returns NULL, the comparison is NULL, and the row is filtered out. The
-- cross-grade history therefore silently collapsed to "courses I teach".
--
-- Fix: resolve the institution through a SECURITY DEFINER helper (the pattern
-- every other helper in this schema already uses), so the lookup is not
-- re-filtered by the caller's own visibility. No widening of `courses` and no
-- change to who may read scores as designed — institution instructors only.

CREATE OR REPLACE FUNCTION public.is_institution_instructor_for_course(
  _user_id uuid,
  _course_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.course_instructors ci
    JOIN public.courses taught ON taught.id = ci.course_id
    JOIN public.courses target ON target.id = _course_id
    WHERE ci.user_id = _user_id
      AND taught.institution_id = target.institution_id
  )
$$;

REVOKE ALL ON FUNCTION public.is_institution_instructor_for_course(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_institution_instructor_for_course(uuid, uuid)
  TO authenticated, service_role;

DROP POLICY IF EXISTS "Institution instructors view student horizontal scores"
  ON public.student_horizontal_scores;

CREATE POLICY "Institution instructors view student horizontal scores"
ON public.student_horizontal_scores
FOR SELECT
USING (public.is_institution_instructor_for_course(auth.uid(), course_id));
