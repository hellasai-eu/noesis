-- Create quiz_sessions table to track timed quiz attempts
CREATE TABLE public.quiz_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  expired_at timestamp with time zone,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned', 'expired')),
  UNIQUE (user_id, quiz_id)
);

-- Enable RLS
ALTER TABLE public.quiz_sessions ENABLE ROW LEVEL SECURITY;

-- Users can view their own sessions
CREATE POLICY "Users can view their own quiz sessions"
ON public.quiz_sessions FOR SELECT
USING (user_id = auth.uid());

-- Users can create their own sessions
CREATE POLICY "Users can create their own quiz sessions"
ON public.quiz_sessions FOR INSERT
WITH CHECK (user_id = auth.uid());

-- Users can update their own sessions
CREATE POLICY "Users can update their own quiz sessions"
ON public.quiz_sessions FOR UPDATE
USING (user_id = auth.uid());

-- Index for fast lookups
CREATE INDEX idx_quiz_sessions_user_quiz ON public.quiz_sessions(user_id, quiz_id);