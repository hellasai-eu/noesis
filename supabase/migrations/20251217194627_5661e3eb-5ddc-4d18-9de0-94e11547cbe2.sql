-- Fix the INSERT policy for open_questions - parameter order was wrong
DROP POLICY IF EXISTS "Admins and instructors can create open questions" ON public.open_questions;

CREATE POLICY "Admins and instructors can create open questions"
ON public.open_questions
FOR INSERT
WITH CHECK (
  public.is_course_instructor(course_id, auth.uid())
  OR public.is_institution_admin(auth.uid(), (SELECT institution_id FROM public.courses WHERE id = course_id))
  OR public.is_super_admin(auth.uid())
);