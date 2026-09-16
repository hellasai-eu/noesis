-- Fix: Add explicit ce.role = 'student' filter in student access check
-- of user_has_course_tag_access() for defense-in-depth against future
-- non-student roles in class_enrollments.

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
    -- Admins see all courses in their institution
    EXISTS (
      SELECT 1
      FROM courses c
      JOIN user_institutions ui ON ui.institution_id = c.institution_id
      WHERE c.id = _course_id
      AND ui.user_id = _user_id
      AND ui.role = 'admin'
    )
    OR
    -- Instructors: check course_instructors table
    EXISTS (
      SELECT 1 FROM course_instructors ci
      WHERE ci.course_id = _course_id AND ci.user_id = _user_id
    )
    OR
    -- Students: enrolled in active class with active offering for this course
    EXISTS (
      SELECT 1
      FROM class_enrollments ce
      JOIN classes cl ON ce.class_id = cl.id
      JOIN offerings o ON o.class_id = cl.id
      WHERE ce.user_id = _user_id
      AND ce.role = 'student'
      AND o.course_id = _course_id
      AND o.is_active = true
      AND cl.is_active = true
    )
$$;
