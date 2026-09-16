-- Create table for tracking open question completion status
CREATE TABLE public.open_question_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  open_question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, open_question_id)
);

-- Enable RLS
ALTER TABLE public.open_question_progress ENABLE ROW LEVEL SECURITY;

-- Users can manage their own progress
CREATE POLICY "Users can manage their own progress"
ON public.open_question_progress
FOR ALL
USING (user_id = auth.uid());

-- Admins can view all progress
CREATE POLICY "Admins can view all progress"
ON public.open_question_progress
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_progress.course_id
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);

-- Create indexes for performance
CREATE INDEX idx_open_question_progress_user_id ON public.open_question_progress(user_id);
CREATE INDEX idx_open_question_progress_question_id ON public.open_question_progress(open_question_id);
CREATE INDEX idx_open_question_progress_course_id ON public.open_question_progress(course_id);