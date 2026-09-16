-- Restore simpler tag access logic - all users need just ONE matching tag
-- Admins and superadmins still bypass the system

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
    -- All other users (instructors and students) need at least ONE matching tag
    -- or course has no tags (untagged courses are accessible)
    (
      EXISTS (
        SELECT 1 
        FROM courses c
        JOIN user_institutions ui ON ui.institution_id = c.institution_id
        WHERE c.id = _course_id 
        AND ui.user_id = _user_id
      )
      AND (
        EXISTS (
          SELECT 1 
          FROM course_tags ct
          JOIN user_tags ut ON ut.tag_id = ct.tag_id
          WHERE ct.course_id = _course_id AND ut.user_id = _user_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM course_tags WHERE course_id = _course_id
        )
      )
    )
$$;

-- Keep is_course_instructor using the any-tag helper
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