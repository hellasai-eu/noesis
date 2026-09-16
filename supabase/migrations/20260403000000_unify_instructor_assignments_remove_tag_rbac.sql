-- Migration: Unify instructor assignments & remove tag-based RBAC
--
-- 1. Clean up stale instructor rows in class_enrollments
-- 2. Prevent future instructor enrollments in class_enrollments
-- 3. Redefine user_has_course_tag_access() to remove all tag checks
--    (tags remain for UI filtering only, not access control)

-- ============================================================
-- Part 1: Clean up class_enrollments
-- ============================================================

-- Delete stale instructor rows (RBAC layer already ignores these)
DELETE FROM class_enrollments WHERE role = 'instructor';

-- Prevent future instructor enrollments
ALTER TABLE class_enrollments
  ADD CONSTRAINT chk_student_enrollments_only
  CHECK (role <> 'instructor');

-- ============================================================
-- Part 2: Redefine user_has_course_tag_access without tag logic
-- ============================================================

-- The function signature stays the same so all ~13 RLS policies
-- that call it continue to work without modification.
-- Tag checks are removed; access is now purely:
--   superadmin > admin (institution) > instructor (course_instructors) > student (enrollment)
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
      AND o.course_id = _course_id
      AND o.is_active = true
      AND cl.is_active = true
    )
$$;
