-- Create table for student evaluations
CREATE TABLE public.student_evaluations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  student_name TEXT,
  overall_assessment TEXT,
  strengths TEXT[],
  weaknesses TEXT[],
  recommendations TEXT[],
  stats JSONB,
  generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add unique constraint to allow one evaluation per student per course
CREATE UNIQUE INDEX idx_student_evaluations_unique ON public.student_evaluations(course_id, user_id);

-- Enable RLS
ALTER TABLE public.student_evaluations ENABLE ROW LEVEL SECURITY;

-- Admins and instructors can manage evaluations
CREATE POLICY "Admins and instructors can manage evaluations"
ON public.student_evaluations
FOR ALL
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = student_evaluations.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Students can view their own evaluations
CREATE POLICY "Students can view their own evaluations"
ON public.student_evaluations
FOR SELECT
USING (user_id = auth.uid());

-- Add trigger for updated_at
CREATE TRIGGER update_student_evaluations_updated_at
BEFORE UPDATE ON public.student_evaluations
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();