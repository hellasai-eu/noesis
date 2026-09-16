-- Migration: Add course_instructor_sections table for section-level publishing restrictions
-- Issue #59: Allow admins to restrict which sections an instructor can publish to.
-- Semantic: No rows for an instructor+course = full access (backward compatible).
-- If rows exist = restricted to listed sections only.

-- ============================================================
-- Step 1: Create the table
-- ============================================================
CREATE TABLE public.course_instructor_sections (
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (course_id, class_id, user_id)
);

ALTER TABLE public.course_instructor_sections ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Step 2: Helper function
-- ============================================================
CREATE OR REPLACE FUNCTION public.instructor_can_access_section(
  _course_id uuid, _class_id uuid, _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- No restriction rows = full access
    NOT EXISTS (
      SELECT 1 FROM course_instructor_sections
      WHERE course_id = _course_id AND user_id = _user_id
    )
    OR
    -- Specific section is in the allowed set
    EXISTS (
      SELECT 1 FROM course_instructor_sections
      WHERE course_id = _course_id AND class_id = _class_id AND user_id = _user_id
    )
$$;

-- ============================================================
-- Step 3: RLS policies on course_instructor_sections
-- ============================================================

-- SELECT: admins and the instructor themselves
CREATE POLICY "Users can view instructor section restrictions"
ON public.course_instructor_sections FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = course_instructor_sections.course_id
    AND is_institution_admin(auth.uid(), c.institution_id)
  )
  OR user_id = auth.uid()
);

-- INSERT/UPDATE/DELETE: admins only
CREATE POLICY "Admins can manage instructor section restrictions"
ON public.course_instructor_sections FOR ALL
USING (
  is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = course_instructor_sections.course_id
    AND is_institution_admin(auth.uid(), c.institution_id)
  )
)
WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = course_instructor_sections.course_id
    AND is_institution_admin(auth.uid(), c.institution_id)
  )
);

-- ============================================================
-- Step 4: Update is_class_instructor to respect section restrictions
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_class_instructor(_class_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid;
BEGIN
  _user_id := auth.uid();
  IF _user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM offerings o
    JOIN course_instructors ci ON ci.course_id = o.course_id
    WHERE o.class_id = _class_id
    AND ci.user_id = _user_id
    AND instructor_can_access_section(o.course_id, _class_id, _user_id)
  );
END;
$$;

-- ============================================================
-- Step 5: Update can_manage_offering to respect section restrictions
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_manage_offering(_offering_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM offerings o
    JOIN classes c ON o.class_id = c.id
    WHERE o.id = _offering_id
    AND (
      is_super_admin(auth.uid())
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR (
        is_course_instructor(o.course_id, auth.uid())
        AND instructor_can_access_section(o.course_id, o.class_id, auth.uid())
      )
    )
  )
$$;

-- ============================================================
-- Step 6: Update offerings RLS to respect section restrictions
-- ============================================================
DROP POLICY IF EXISTS "Managers can manage offerings" ON public.offerings;
CREATE POLICY "Managers can manage offerings" ON public.offerings FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = offerings.class_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR (
      is_course_instructor(offerings.course_id, auth.uid())
      AND instructor_can_access_section(offerings.course_id, offerings.class_id, auth.uid())
    )
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = offerings.class_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR (
      is_course_instructor(offerings.course_id, auth.uid())
      AND instructor_can_access_section(offerings.course_id, offerings.class_id, auth.uid())
    )
  );
