-- Add RLS policies for course_tags table

-- Allow users in the institution to view course tags
CREATE POLICY "Users can view course tags for accessible courses"
ON public.course_tags
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_tags.course_id AND ui.user_id = auth.uid()
  )
);

-- Allow admins to insert course tags
CREATE POLICY "Admins can insert course tags"
ON public.course_tags
FOR INSERT
WITH CHECK (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_tags.course_id 
    AND ui.user_id = auth.uid() 
    AND ui.role = 'admin'
  )
);

-- Allow admins to delete course tags
CREATE POLICY "Admins can delete course tags"
ON public.course_tags
FOR DELETE
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_tags.course_id 
    AND ui.user_id = auth.uid() 
    AND ui.role = 'admin'
  )
);