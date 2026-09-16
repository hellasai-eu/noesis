-- Drop the problematic policies
DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;
DROP POLICY IF EXISTS "Users can view course tags for accessible courses" ON public.course_tags;

-- Create a security definer function to check if user has tag access to a course
CREATE OR REPLACE FUNCTION public.user_has_course_tag_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    -- No tags on course = accessible
    NOT EXISTS (SELECT 1 FROM course_tags WHERE course_id = _course_id)
    OR
    -- User has at least one matching tag
    EXISTS (
      SELECT 1 
      FROM course_tags ct
      JOIN user_tags ut ON ut.tag_id = ct.tag_id
      WHERE ct.course_id = _course_id AND ut.user_id = _user_id
    )
$$;

-- Create new courses SELECT policy using the function
CREATE POLICY "Users can view courses in their institution" ON public.courses
FOR SELECT USING (
  institution_id = get_user_institution_id(auth.uid())
  AND (
    is_admin(auth.uid()) 
    OR user_has_course_tag_access(id, auth.uid())
  )
);

-- Create new course_tags SELECT policy that doesn't reference courses
CREATE POLICY "Users can view course tags for accessible courses" ON public.course_tags
FOR SELECT USING (
  user_has_tag_access(tag_id, auth.uid()) OR is_admin(auth.uid())
);