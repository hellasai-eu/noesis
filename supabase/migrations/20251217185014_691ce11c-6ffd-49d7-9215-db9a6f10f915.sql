-- Update user_has_course_tag_access to require tags for non-admin access
-- Untagged courses should only be visible to admins, not all users

CREATE OR REPLACE FUNCTION public.user_has_course_tag_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
    -- Instructors with course access can view
    EXISTS (
      SELECT 1 
      FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = _course_id 
      AND ui.user_id = _user_id 
      AND ui.role = 'instructor'
      AND EXISTS (
        SELECT 1 
        FROM course_tags ct
        JOIN user_tags ut ON ut.tag_id = ct.tag_id
        WHERE ct.course_id = _course_id AND ut.user_id = _user_id
      )
    )
    OR
    -- Students need at least ONE matching tag (no tag = no access)
    (
      EXISTS (
        SELECT 1 
        FROM courses c
        JOIN user_institutions ui ON ui.institution_id = c.institution_id
        WHERE c.id = _course_id 
        AND ui.user_id = _user_id
        AND ui.role = 'student'
      )
      AND EXISTS (
        SELECT 1 
        FROM course_tags ct
        JOIN user_tags ut ON ut.tag_id = ct.tag_id
        WHERE ct.course_id = _course_id AND ut.user_id = _user_id
      )
    )
$$;