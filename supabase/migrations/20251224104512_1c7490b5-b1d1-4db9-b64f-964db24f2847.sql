-- Create flashcard_sessions table for student-created review sessions
CREATE TABLE public.flashcard_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  chapter_ids UUID[] NOT NULL,
  cards_per_session INT NOT NULL DEFAULT 20,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.flashcard_sessions ENABLE ROW LEVEL SECURITY;

-- RLS policies - users can only manage their own sessions
CREATE POLICY "Users can view their own flashcard sessions"
ON public.flashcard_sessions
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own flashcard sessions"
ON public.flashcard_sessions
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own flashcard sessions"
ON public.flashcard_sessions
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own flashcard sessions"
ON public.flashcard_sessions
FOR DELETE
USING (auth.uid() = user_id);

-- Add trigger for automatic timestamp updates
CREATE TRIGGER update_flashcard_sessions_updated_at
BEFORE UPDATE ON public.flashcard_sessions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();