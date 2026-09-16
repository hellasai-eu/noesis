-- Create table for storing open question chat interactions
CREATE TABLE public.open_question_chats (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  open_question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  flagged_offensive BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for efficient lookups
CREATE INDEX idx_open_question_chats_question ON public.open_question_chats(open_question_id);
CREATE INDEX idx_open_question_chats_user ON public.open_question_chats(user_id);
CREATE INDEX idx_open_question_chats_course ON public.open_question_chats(course_id);

-- Enable RLS
ALTER TABLE public.open_question_chats ENABLE ROW LEVEL SECURITY;

-- Students can view and insert their own chat messages
CREATE POLICY "Users can view their own chat messages"
ON public.open_question_chats
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own chat messages"
ON public.open_question_chats
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Admins and instructors can view all chats in their institution's courses
CREATE POLICY "Admins can view all chats in their courses"
ON public.open_question_chats
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_chats.course_id 
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);