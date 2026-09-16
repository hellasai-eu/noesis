-- Fix all open_questions policies with correct parameter order for is_institution_admin

-- Fix DELETE policy
DROP POLICY IF EXISTS "Admins and instructors can delete open questions" ON public.open_questions;
CREATE POLICY "Admins and instructors can delete open questions"
ON public.open_questions
FOR DELETE
USING (
  public.is_course_instructor(course_id, auth.uid())
  OR public.is_institution_admin(auth.uid(), (SELECT institution_id FROM public.courses WHERE id = course_id))
  OR public.is_super_admin(auth.uid())
);

-- Fix UPDATE policy
DROP POLICY IF EXISTS "Admins and instructors can update open questions" ON public.open_questions;
CREATE POLICY "Admins and instructors can update open questions"
ON public.open_questions
FOR UPDATE
USING (
  public.is_course_instructor(course_id, auth.uid())
  OR public.is_institution_admin(auth.uid(), (SELECT institution_id FROM public.courses WHERE id = course_id))
  OR public.is_super_admin(auth.uid())
);

-- Fix SELECT policy
DROP POLICY IF EXISTS "Users can view open questions for courses they belong to" ON public.open_questions;
CREATE POLICY "Users can view open questions for courses they belong to"
ON public.open_questions
FOR SELECT
USING (
  public.user_has_course_tag_access(course_id, auth.uid())
  OR public.is_institution_admin(auth.uid(), (SELECT institution_id FROM public.courses WHERE id = course_id))
  OR public.is_super_admin(auth.uid())
);