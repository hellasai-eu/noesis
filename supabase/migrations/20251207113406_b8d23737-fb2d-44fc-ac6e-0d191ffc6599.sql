-- Add grading fields to open_question_chats for session-level grading
-- We'll add grade and feedback to track the AI assessment

-- Create a table to store session grades (one grade per question-user combination)
CREATE TABLE public.open_question_grades (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  open_question_id uuid NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  grade integer CHECK (grade >= 0 AND grade <= 100),
  feedback text,
  strengths text[],
  areas_for_improvement text[],
  graded_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(open_question_id, user_id)
);

-- Enable RLS
ALTER TABLE public.open_question_grades ENABLE ROW LEVEL SECURITY;

-- Admins and instructors can view grades for their courses
CREATE POLICY "Admins and instructors can view grades"
ON public.open_question_grades
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_grades.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role IN ('admin', 'instructor'))
  )
  OR is_super_admin(auth.uid())
);

-- Admins and instructors can insert grades
CREATE POLICY "Admins and instructors can insert grades"
ON public.open_question_grades
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_grades.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role IN ('admin', 'instructor'))
  )
  OR is_super_admin(auth.uid())
);

-- Admins and instructors can update grades
CREATE POLICY "Admins and instructors can update grades"
ON public.open_question_grades
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_grades.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role IN ('admin', 'instructor'))
  )
  OR is_super_admin(auth.uid())
);

-- Admins and instructors can delete grades
CREATE POLICY "Admins and instructors can delete grades"
ON public.open_question_grades
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_grades.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role IN ('admin', 'instructor'))
  )
  OR is_super_admin(auth.uid())
);

-- Users can view their own grades
CREATE POLICY "Users can view their own grades"
ON public.open_question_grades
FOR SELECT
USING (user_id = auth.uid());

-- Create update trigger for updated_at
CREATE TRIGGER update_open_question_grades_updated_at
BEFORE UPDATE ON public.open_question_grades
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();