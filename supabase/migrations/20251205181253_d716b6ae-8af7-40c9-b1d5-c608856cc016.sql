-- Add UPDATE policy for course_materials
CREATE POLICY "Admins can update course materials"
ON public.course_materials
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = course_materials.course_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);