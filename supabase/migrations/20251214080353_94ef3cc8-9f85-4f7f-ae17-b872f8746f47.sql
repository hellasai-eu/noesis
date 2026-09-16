-- Create table for course competencies
CREATE TABLE public.course_competencies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  chapter_id UUID REFERENCES public.material_chapters(id) ON DELETE SET NULL,
  order_num INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.course_competencies ENABLE ROW LEVEL SECURITY;

-- Admins and instructors can manage competencies
CREATE POLICY "Admins and instructors can manage competencies"
ON public.course_competencies
FOR ALL
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_competencies.course_id 
    AND ui.user_id = auth.uid() 
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Students can view competencies
CREATE POLICY "Students can view competencies"
ON public.course_competencies
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = course_competencies.course_id 
    AND ui.user_id = auth.uid()
    AND user_has_course_tag_access(c.id, auth.uid())
  )
);

-- Create trigger for updated_at
CREATE TRIGGER update_course_competencies_updated_at
BEFORE UPDATE ON public.course_competencies
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();