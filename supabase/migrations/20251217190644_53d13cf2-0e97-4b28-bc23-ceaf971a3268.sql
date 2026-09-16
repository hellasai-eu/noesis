-- Update is_course_instructor to use the new tag access logic consistently
CREATE OR REPLACE FUNCTION public.is_course_instructor(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM user_institutions ui
    JOIN courses c ON c.institution_id = ui.institution_id
    WHERE ui.user_id = _user_id 
      AND ui.role = 'instructor'
      AND c.id = _course_id
      AND user_has_course_tag_access(_course_id, _user_id)
  )
$$;

-- Drop existing policies
DROP POLICY IF EXISTS "Admins and instructors can manage study sessions" ON public.study_sessions;
DROP POLICY IF EXISTS "Users can view published study sessions for accessible courses" ON public.study_sessions;

-- Recreate with explicit WITH CHECK for INSERT/UPDATE
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
  OR is_institution_admin((SELECT institution_id FROM courses WHERE id = course_id), auth.uid()) 
  OR is_course_instructor(course_id, auth.uid())
);

CREATE POLICY "Users can view published study sessions for accessible courses" 
ON public.study_sessions 
FOR SELECT 
USING (
  is_super_admin(auth.uid()) 
  OR is_institution_admin((SELECT institution_id FROM courses WHERE id = study_sessions.course_id), auth.uid()) 
  OR is_course_instructor(course_id, auth.uid()) 
  OR (is_published = true AND user_has_course_tag_access(course_id, auth.uid()))
);