-- Add competency_id to questions table
ALTER TABLE public.questions ADD COLUMN competency_id uuid REFERENCES public.course_competencies(id) ON DELETE SET NULL;

-- Add competency_id to open_questions table
ALTER TABLE public.open_questions ADD COLUMN competency_id uuid REFERENCES public.course_competencies(id) ON DELETE SET NULL;

-- Create student competency mastery table
CREATE TABLE public.student_competency_mastery (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  competency_id uuid NOT NULL REFERENCES public.course_competencies(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  total_mcq_questions integer NOT NULL DEFAULT 0,
  correct_mcq_answers integer NOT NULL DEFAULT 0,
  total_open_questions integer NOT NULL DEFAULT 0,
  open_question_avg_grade numeric DEFAULT NULL,
  mastery_percentage numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(user_id, competency_id)
);

-- Enable RLS
ALTER TABLE public.student_competency_mastery ENABLE ROW LEVEL SECURITY;

-- Students can view their own mastery
CREATE POLICY "Users can view their own mastery"
ON public.student_competency_mastery
FOR SELECT
USING (user_id = auth.uid());

-- Students can manage their own mastery records
CREATE POLICY "Users can manage their own mastery"
ON public.student_competency_mastery
FOR ALL
USING (user_id = auth.uid());

-- Admins and instructors can view all mastery in their courses
CREATE POLICY "Admins and instructors can view all mastery"
ON public.student_competency_mastery
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = student_competency_mastery.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Create indexes
CREATE INDEX idx_student_competency_mastery_user ON public.student_competency_mastery(user_id);
CREATE INDEX idx_student_competency_mastery_competency ON public.student_competency_mastery(competency_id);
CREATE INDEX idx_student_competency_mastery_course ON public.student_competency_mastery(course_id);
CREATE INDEX idx_questions_competency ON public.questions(competency_id);
CREATE INDEX idx_open_questions_competency ON public.open_questions(competency_id);

-- Trigger for updated_at
CREATE TRIGGER update_student_competency_mastery_updated_at
BEFORE UPDATE ON public.student_competency_mastery
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();