-- Create helper function to check if user has ALL course tags (for students)
CREATE OR REPLACE FUNCTION public.user_has_all_course_tags(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT NOT EXISTS (
    -- Check if there are any course tags that the user doesn't have
    SELECT 1 
    FROM course_tags ct
    WHERE ct.course_id = _course_id
    AND NOT EXISTS (
      SELECT 1 
      FROM user_tags ut 
      WHERE ut.tag_id = ct.tag_id 
      AND ut.user_id = _user_id
    )
  )
  -- Also return true if course has no tags (untagged courses are accessible)
  OR NOT EXISTS (
    SELECT 1 FROM course_tags WHERE course_id = _course_id
  )
$$;

-- Create helper function to check if user has at least ONE course tag (for instructors)
CREATE OR REPLACE FUNCTION public.user_has_any_course_tag(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM course_tags ct
    JOIN user_tags ut ON ut.tag_id = ct.tag_id
    WHERE ct.course_id = _course_id AND ut.user_id = _user_id
  )
  -- Also return true if course has no tags (untagged courses are accessible)
  OR NOT EXISTS (
    SELECT 1 FROM course_tags WHERE course_id = _course_id
  )
$$;

-- Update main access function with role-based logic
CREATE OR REPLACE FUNCTION public.user_has_course_tag_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT 
    -- Superadmins bypass all tag checks
    is_super_admin(_user_id)
    OR
    -- Admins bypass tag checks for their institution
    EXISTS (
      SELECT 1 
      FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = _course_id 
      AND ui.user_id = _user_id 
      AND ui.role = 'admin'
    )
    OR
    -- Instructors need at least ONE matching tag
    (
      EXISTS (
        SELECT 1 
        FROM courses c
        JOIN user_institutions ui ON ui.institution_id = c.institution_id
        WHERE c.id = _course_id 
        AND ui.user_id = _user_id 
        AND ui.role = 'instructor'
      )
      AND user_has_any_course_tag(_course_id, _user_id)
    )
    OR
    -- Students need ALL matching tags
    (
      EXISTS (
        SELECT 1 
        FROM courses c
        JOIN user_institutions ui ON ui.institution_id = c.institution_id
        WHERE c.id = _course_id 
        AND ui.user_id = _user_id 
        AND ui.role = 'student'
      )
      AND user_has_all_course_tags(_course_id, _user_id)
    )
$$;

-- Update is_course_instructor to use the new any-tag function
CREATE OR REPLACE FUNCTION public.is_course_instructor(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM user_institutions ui
    JOIN courses c ON c.institution_id = ui.institution_id
    WHERE ui.user_id = _user_id 
      AND ui.role = 'instructor'
      AND c.id = _course_id
      AND user_has_any_course_tag(_course_id, _user_id)
  )
$$;