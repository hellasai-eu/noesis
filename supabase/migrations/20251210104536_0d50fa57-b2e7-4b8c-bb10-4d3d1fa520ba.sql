-- Create table for instructor copilot sessions
CREATE TABLE public.copilot_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.copilot_sessions ENABLE ROW LEVEL SECURITY;

-- Admins and instructors can manage their own sessions
CREATE POLICY "Users can manage their own copilot sessions"
ON public.copilot_sessions
FOR ALL
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Admins can view all sessions in their courses
CREATE POLICY "Admins can view all copilot sessions"
ON public.copilot_sessions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = copilot_sessions.course_id
    AND ui.user_id = auth.uid()
    AND ui.role = 'admin'
  )
  OR is_super_admin(auth.uid())
);

-- Create index for performance
CREATE INDEX idx_copilot_sessions_course_user ON public.copilot_sessions(course_id, user_id);
CREATE INDEX idx_copilot_sessions_updated ON public.copilot_sessions(updated_at DESC);

-- Trigger for updated_at
CREATE TRIGGER update_copilot_sessions_updated_at
BEFORE UPDATE ON public.copilot_sessions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();