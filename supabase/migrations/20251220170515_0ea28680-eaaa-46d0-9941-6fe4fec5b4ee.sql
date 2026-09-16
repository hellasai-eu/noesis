-- Drop the existing policy
DROP POLICY IF EXISTS "Admins and instructors can manage study sessions" ON public.study_sessions;

-- Recreate with correct WITH CHECK clause
CREATE POLICY "Admins and instructors can manage study sessions" 
ON public.study_sessions 
FOR ALL 
USING (
  is_super_admin(auth.uid()) 
  OR is_institution_admin((SELECT institution_id FROM courses WHERE id = study_sessions.course_id), auth.uid()) 
  OR is_course_instructor(course_id, auth.uid())
)
WITH CHECK (
  is_super_admin(auth.uid()) 
  OR is_institution_admin((SELECT institution_id FROM courses WHERE id = study_sessions.course_id), auth.uid()) 
  OR is_course_instructor(study_sessions.course_id, auth.uid())
);