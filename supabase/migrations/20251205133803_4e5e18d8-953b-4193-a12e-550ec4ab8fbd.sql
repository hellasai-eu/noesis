-- Create quiz_answers table to track student answers
CREATE TABLE public.quiz_answers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  selected_answer INTEGER NOT NULL,
  is_correct BOOLEAN NOT NULL,
  answered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, question_id)
);

-- Enable RLS
ALTER TABLE public.quiz_answers ENABLE ROW LEVEL SECURITY;

-- Users can view their own answers
CREATE POLICY "Users can view their own quiz answers"
ON public.quiz_answers
FOR SELECT
USING (user_id = auth.uid());

-- Users can insert their own answers
CREATE POLICY "Users can submit quiz answers"
ON public.quiz_answers
FOR INSERT
WITH CHECK (user_id = auth.uid());

-- Admins can view all answers in their institution
CREATE POLICY "Admins can view all quiz answers"
ON public.quiz_answers
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = quiz_answers.course_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
  )
);

-- Create index for faster lookups
CREATE INDEX idx_quiz_answers_user_question ON public.quiz_answers(user_id, question_id);
CREATE INDEX idx_quiz_answers_course ON public.quiz_answers(course_id);