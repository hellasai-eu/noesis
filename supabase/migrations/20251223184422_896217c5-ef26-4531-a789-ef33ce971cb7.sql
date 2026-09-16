-- Fix study_sessions RLS policies - arguments to is_institution_admin were reversed

-- Drop existing policies
DROP POLICY IF EXISTS "Admins and instructors can manage study sessions" ON public.study_sessions;
DROP POLICY IF EXISTS "Users can view published study sessions for accessible courses" ON public.study_sessions;

-- Recreate with correct argument order (user_id first, then institution_id)
CREATE POLICY "Admins and instructors can manage study sessions" 
ON public.study_sessions 
FOR ALL 
USING (
  is_super_admin(auth.uid()) 
  OR is_institution_admin(auth.uid(), (SELECT courses.institution_id FROM courses WHERE courses.id = study_sessions.course_id))
  OR is_course_instructor(course_id, auth.uid())
)
WITH CHECK (
  is_super_admin(auth.uid()) 
  OR is_institution_admin(auth.uid(), (SELECT courses.institution_id FROM courses WHERE courses.id = study_sessions.course_id))
  OR is_course_instructor(course_id, auth.uid())
);

CREATE POLICY "Users can view published study sessions for accessible courses" 
ON public.study_sessions 
FOR SELECT 
USING (
  is_super_admin(auth.uid()) 
  OR is_institution_admin(auth.uid(), (SELECT courses.institution_id FROM courses WHERE courses.id = study_sessions.course_id))
  OR is_course_instructor(course_id, auth.uid()) 
  OR (is_published = true AND user_has_course_tag_access(course_id, auth.uid()))
);