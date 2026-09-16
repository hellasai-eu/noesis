-- Allow course instructors to update courses they teach.
--
-- Before this migration, only admins (and super-admins) could UPDATE rows in
-- public.courses. Instructors assigned via public.course_instructors had no
-- UPDATE policy, so toggles in the Course Progress settings panel (e.g.
-- student_questions_enabled, restrict_to_completed_chapters) silently failed
-- under RLS: the request returned no error but affected zero rows, and the
-- optimistic UI state briefly showed success before the next fetch reverted
-- to the stale DB value. On the student course page, that meant the
-- Community Questions section never appeared even when the instructor
-- thought they had enabled it.

DROP POLICY IF EXISTS "Admins can update courses" ON public.courses;
DROP POLICY IF EXISTS "Admins and instructors can update courses" ON public.courses;

CREATE POLICY "Admins and instructors can update courses" ON public.courses
FOR UPDATE USING (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1
    FROM public.user_institutions ui
    WHERE ui.user_id = auth.uid()
      AND ui.institution_id = courses.institution_id
      AND ui.role = 'admin'
  )
  OR public.is_course_instructor(id, auth.uid())
)
WITH CHECK (
  public.is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1
    FROM public.user_institutions ui
    WHERE ui.user_id = auth.uid()
      AND ui.institution_id = courses.institution_id
      AND ui.role = 'admin'
  )
  OR public.is_course_instructor(id, auth.uid())
);
