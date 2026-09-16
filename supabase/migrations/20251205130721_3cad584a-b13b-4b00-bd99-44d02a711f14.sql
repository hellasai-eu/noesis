-- Update function so students only see courses where they have a matching tag
-- Courses with no tags will NOT be accessible to students (only admins)
CREATE OR REPLACE FUNCTION public.user_has_course_tag_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM course_tags ct
    JOIN user_tags ut ON ut.tag_id = ct.tag_id
    WHERE ct.course_id = _course_id AND ut.user_id = _user_id
  )
$$;