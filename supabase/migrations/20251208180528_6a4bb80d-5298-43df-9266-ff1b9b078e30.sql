-- Create table for textbook chat messages
CREATE TABLE public.textbook_chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  material_id UUID NOT NULL REFERENCES public.course_materials(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.textbook_chat_messages ENABLE ROW LEVEL SECURITY;

-- Users can insert their own messages
CREATE POLICY "Users can insert their own textbook chat messages"
ON public.textbook_chat_messages
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can view their own messages
CREATE POLICY "Users can view their own textbook chat messages"
ON public.textbook_chat_messages
FOR SELECT
USING (auth.uid() = user_id);

-- Admins and instructors can view all messages in their courses
CREATE POLICY "Admins can view textbook chat messages"
ON public.textbook_chat_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = textbook_chat_messages.course_id
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);

-- Index for efficient queries
CREATE INDEX idx_textbook_chat_messages_user_material 
ON public.textbook_chat_messages(user_id, material_id, created_at DESC);