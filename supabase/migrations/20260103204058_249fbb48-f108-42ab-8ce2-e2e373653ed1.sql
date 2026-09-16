-- Add allow_self_enrollment to institutions table
ALTER TABLE public.institutions 
ADD COLUMN allow_self_enrollment boolean NOT NULL DEFAULT false;

-- Add allow_self_enrollment to classes table
ALTER TABLE public.classes 
ADD COLUMN allow_self_enrollment boolean NOT NULL DEFAULT true;

-- Add RLS policy for student self-enrollment
CREATE POLICY "Students can self-enroll in eligible classes"
ON public.class_enrollments
FOR INSERT
TO authenticated
WITH CHECK (
  -- User is enrolling themselves
  user_id = auth.uid()
  -- As a student role only
  AND role = 'student'
  -- Class must be active and allow self-enrollment, institution must allow it too
  AND EXISTS (
    SELECT 1 FROM classes c
    JOIN institutions i ON c.institution_id = i.id
    WHERE c.id = class_enrollments.class_id
    AND c.is_active = true
    AND c.allow_self_enrollment = true
    AND i.allow_self_enrollment = true
    -- User must be a member of this institution
    AND EXISTS (
      SELECT 1 FROM user_institutions ui
      WHERE ui.user_id = auth.uid()
      AND ui.institution_id = i.id
    )
  )
);