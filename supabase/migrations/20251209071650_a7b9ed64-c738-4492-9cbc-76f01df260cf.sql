-- Create table for exercise PDFs in AI Interactive Questions
CREATE TABLE public.course_exercise_pdfs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.course_exercise_pdfs ENABLE ROW LEVEL SECURITY;

-- Instructors and admins can manage exercise PDFs
CREATE POLICY "Admins and instructors can manage exercise PDFs"
ON public.course_exercise_pdfs
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = course_id 
      AND ui.user_id = auth.uid()
      AND (ui.role = 'admin' OR (ui.role = 'instructor' AND user_has_course_tag_access(course_id, auth.uid())))
  )
  OR is_super_admin(auth.uid())
);

-- Students with tag access can view exercise PDFs
CREATE POLICY "Students can view exercise PDFs"
ON public.course_exercise_pdfs
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = course_id 
      AND ui.user_id = auth.uid()
      AND user_has_course_tag_access(course_id, auth.uid())
  )
);