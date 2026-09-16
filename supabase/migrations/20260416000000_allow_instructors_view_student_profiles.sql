-- Migration: Allow instructors to view profiles of students in their sections
-- Issue #207: Instructors see "Unnamed User" because RLS on profiles only
-- grants SELECT to the user themselves or admins. This adds a policy so
-- instructors can see profiles of users enrolled in classes linked to
-- courses they teach.

CREATE POLICY "Instructors can view profiles of students in their sections"
ON public.profiles FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM class_enrollments ce
    JOIN offerings o ON o.class_id = ce.class_id AND o.is_active = true
    JOIN classes cl ON cl.id = ce.class_id AND cl.is_active = true
    JOIN course_instructors ci ON ci.course_id = o.course_id
    WHERE ce.user_id = profiles.user_id
      AND ci.user_id = auth.uid()
      AND instructor_can_access_section(o.course_id, o.class_id, auth.uid())
  )
);
