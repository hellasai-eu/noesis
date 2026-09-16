-- Fix instructor course access: allow viewing courses with no tags
-- Previously, instructors could ONLY see courses where they had a matching tag.
-- Now they can also see courses that have NO tags assigned.

CREATE OR REPLACE FUNCTION public.user_has_course_tag_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Superadmins bypass all checks
    is_super_admin(_user_id)
    OR
    -- Admins bypass checks for their institution
    EXISTS (
      SELECT 1
      FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = _course_id
      AND ui.user_id = _user_id
      AND ui.role = 'admin'
    )
    OR
    -- Instructors with course access via tags OR courses with no tags
    EXISTS (
      SELECT 1
      FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = _course_id
      AND ui.user_id = _user_id
      AND ui.role = 'instructor'
      AND (
        -- Has matching tags
        EXISTS (
          SELECT 1
          FROM course_tags ct
          JOIN user_tags ut ON ut.tag_id = ct.tag_id
          WHERE ct.course_id = _course_id AND ut.user_id = _user_id
        )
        OR
        -- Course has no tags
        NOT EXISTS (
          SELECT 1 FROM course_tags WHERE course_id = _course_id
        )
      )
    )
    OR
    -- Students: Must have BOTH tag access AND enrollment access
    (
      -- Check student belongs to institution
      EXISTS (
        SELECT 1
        FROM courses c
        JOIN user_institutions ui ON ui.institution_id = c.institution_id
        WHERE c.id = _course_id
        AND ui.user_id = _user_id
        AND ui.role = 'student'
      )
      AND
      -- Check tag access (at least one matching tag OR course has no tags)
      (
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
      AND
      -- Check enrollment access (enrolled in ACTIVE class with active offering for this course)
      EXISTS (
        SELECT 1
        FROM class_enrollments ce
        JOIN classes cl ON ce.class_id = cl.id
        JOIN offerings o ON o.class_id = cl.id
        WHERE ce.user_id = _user_id
        AND o.course_id = _course_id
        AND o.is_active = true
        AND cl.is_active = true  -- Also require active class
      )
    )
$$;
