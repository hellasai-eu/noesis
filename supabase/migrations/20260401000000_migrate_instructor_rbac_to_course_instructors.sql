-- Migration: Migrate instructor RBAC from class_enrollments to course_instructors
-- Issue #52: Instructor access is now determined by the course_instructors table,
-- not by class_enrollments with role='instructor'.

-- ============================================================
-- Step 1: Data migration - seed course_instructors from existing
-- class_enrollments instructor rows (zero access disruption)
-- ============================================================
INSERT INTO course_instructors (course_id, user_id)
SELECT DISTINCT o.course_id, ce.user_id
FROM class_enrollments ce
JOIN offerings o ON o.class_id = ce.class_id
WHERE ce.role = 'instructor'
ON CONFLICT DO NOTHING;

-- ============================================================
-- Step 2: Rewrite functions
-- ============================================================

-- 2a. is_course_instructor() - check course_instructors table directly
CREATE OR REPLACE FUNCTION public.is_course_instructor(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM course_instructors
    WHERE course_id = _course_id AND user_id = _user_id
  )
$$;

-- 2b. is_class_instructor() - derive from course_instructors via offerings
-- Keeps backward compatibility for any remaining callers
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
    WHERE o.class_id = _class_id AND ci.user_id = _user_id
  );
END;
$$;

-- 2c. can_manage_offering() - use is_course_instructor instead of is_class_instructor
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
      OR is_course_instructor(o.course_id, auth.uid())
    )
  )
$$;

-- 2d. user_has_course_tag_access() - update instructor branch to use course_instructors
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
    -- Instructors: check course_instructors table
    EXISTS (
      SELECT 1 FROM course_instructors ci
      WHERE ci.course_id = _course_id AND ci.user_id = _user_id
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
        AND cl.is_active = true
      )
    )
$$;

-- ============================================================
-- Step 3: Update RLS policies
-- ============================================================

-- 3a. offerings: replace is_class_instructor with is_course_instructor
DROP POLICY IF EXISTS "Managers can manage offerings" ON public.offerings;
CREATE POLICY "Managers can manage offerings" ON public.offerings FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = offerings.class_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_course_instructor(offerings.course_id, auth.uid())
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM classes c
      WHERE c.id = offerings.class_id
      AND is_institution_admin(auth.uid(), c.institution_id)
    )
    OR is_course_instructor(offerings.course_id, auth.uid())
  );

-- 3b. courses: simplify instructor branch to use is_course_instructor
DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;
CREATE POLICY "Users can view courses in their institution"
ON public.courses FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR (
    institution_id = get_user_institution_id(auth.uid())
    AND (
      is_admin(auth.uid())
      OR
      is_course_instructor(id, auth.uid())
      OR
      user_has_class_course_access(id, auth.uid())
    )
  )
);

-- 3c. course_chapter_progress: update policies to use course_instructors
DROP POLICY IF EXISTS "Users can view chapter progress for their classes" ON course_chapter_progress;
CREATE POLICY "Users can view chapter progress for their classes"
ON course_chapter_progress
FOR SELECT
USING (
  -- Students enrolled in the class
  EXISTS (
    SELECT 1 FROM class_enrollments ce
    WHERE ce.class_id = course_chapter_progress.class_id
    AND ce.user_id = auth.uid()
    AND ce.role = 'student'
  )
  OR
  -- Course instructors (via offerings)
  EXISTS (
    SELECT 1 FROM offerings o
    JOIN course_instructors ci ON ci.course_id = o.course_id
    WHERE o.class_id = course_chapter_progress.class_id
    AND ci.user_id = auth.uid()
  )
  OR
  -- Institution admins
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = course_chapter_progress.class_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR
  is_super_admin(auth.uid())
);

DROP POLICY IF EXISTS "Instructors and admins can manage chapter progress" ON course_chapter_progress;
CREATE POLICY "Instructors and admins can manage chapter progress"
ON course_chapter_progress
FOR ALL
USING (
  -- Course instructors (via offerings)
  EXISTS (
    SELECT 1 FROM offerings o
    JOIN course_instructors ci ON ci.course_id = o.course_id
    WHERE o.class_id = course_chapter_progress.class_id
    AND ci.user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM classes c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = course_chapter_progress.class_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR
  is_super_admin(auth.uid())
);

-- 3d. student_study_progress: replace inline instructor checks with is_course_instructor
DROP POLICY IF EXISTS "Admins and instructors can update study progress in their courses" ON public.student_study_progress;
CREATE POLICY "Admins and instructors can update study progress in their courses"
ON public.student_study_progress
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = student_study_progress.course_id
    AND (
      c.created_by = auth.uid()
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

DROP POLICY IF EXISTS "Admins and instructors can delete study progress in their courses" ON public.student_study_progress;
CREATE POLICY "Admins and instructors can delete study progress in their courses"
ON public.student_study_progress
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = student_study_progress.course_id
    AND (
      c.created_by = auth.uid()
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);

-- 3e. study_session_messages: replace inline instructor checks with is_course_instructor
DROP POLICY IF EXISTS "Admins and instructors can delete study messages in their courses" ON public.study_session_messages;
CREATE POLICY "Admins and instructors can delete study messages in their courses"
ON public.study_session_messages
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM student_study_progress ssp
    JOIN courses c ON c.id = ssp.course_id
    WHERE ssp.id = study_session_messages.progress_id
    AND (
      c.created_by = auth.uid()
      OR is_institution_admin(auth.uid(), c.institution_id)
      OR is_course_instructor(c.id, auth.uid())
    )
  )
);
