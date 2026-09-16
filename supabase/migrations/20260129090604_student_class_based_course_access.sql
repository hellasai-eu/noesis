-- Migration: Student Class-Based Course Access
-- Changes course access model:
-- - Students: can only see courses attached to classes they're enrolled in (class-based via offerings)
-- - Instructors: can access any course they have tags for (tag-based)

-- 1. Create helper function for student class-based access
CREATE OR REPLACE FUNCTION public.user_has_class_course_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM class_enrollments ce
    JOIN offerings o ON o.class_id = ce.class_id
    JOIN classes cl ON cl.id = ce.class_id
    WHERE ce.user_id = _user_id
      AND o.course_id = _course_id
      AND o.is_active = true
      AND cl.is_active = true
  )
$$;

-- 2. Create helper function to check if user is instructor in their institution
CREATE OR REPLACE FUNCTION public.is_institution_instructor(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_institutions
    WHERE user_id = _user_id AND role = 'instructor'
  )
$$;

-- 3. Update courses RLS policy with explicit role-based access
DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;

CREATE POLICY "Users can view courses in their institution"
ON public.courses FOR SELECT
USING (
  -- Super admins see all
  is_super_admin(auth.uid())
  OR (
    institution_id = get_user_institution_id(auth.uid())
    AND (
      -- Admins see all courses in institution
      is_admin(auth.uid())
      OR
      -- Instructors: tag-based access (existing behavior)
      (is_institution_instructor(auth.uid()) AND user_has_course_tag_access(id, auth.uid()))
      OR
      -- Students: class-based access (enrolled in a class that offers this course)
      user_has_class_course_access(id, auth.uid())
    )
  )
);
