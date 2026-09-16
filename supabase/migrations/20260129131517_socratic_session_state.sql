-- Socratic Session State Management
-- Creates dedicated tables for tutor state instead of storing in each message row

-- =============================================================================
-- Phase 1: Create new state tables
-- =============================================================================

-- Table: socratic_session_state
-- Stores the current state for each user+question combination
CREATE TABLE public.socratic_session_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  open_question_id UUID NOT NULL REFERENCES public.open_questions(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  current_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_question UNIQUE (user_id, open_question_id)
);

-- Table: socratic_state_history
-- Logs all state transitions for analytics and debugging
CREATE TABLE public.socratic_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_state_id UUID NOT NULL REFERENCES public.socratic_session_state(id) ON DELETE CASCADE,
  state_before JSONB,
  state_after JSONB NOT NULL,
  trigger_message_id UUID REFERENCES public.open_question_chats(id) ON DELETE SET NULL,
  transition_type VARCHAR(50) NOT NULL,
  llm_decision VARCHAR(20),
  llm_judgement VARCHAR(20),
  llm_confidence DECIMAL(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes for performance
-- =============================================================================

-- Fast lookup by user and question
CREATE INDEX idx_socratic_session_state_user_question
  ON public.socratic_session_state(user_id, open_question_id);

-- Fast lookup by course for analytics
CREATE INDEX idx_socratic_session_state_course
  ON public.socratic_session_state(course_id);

-- History lookups by session
CREATE INDEX idx_socratic_state_history_session
  ON public.socratic_state_history(session_state_id);

-- History lookups by time for analytics
CREATE INDEX idx_socratic_state_history_created
  ON public.socratic_state_history(created_at);

-- =============================================================================
-- Row Level Security
-- =============================================================================

ALTER TABLE public.socratic_session_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.socratic_state_history ENABLE ROW LEVEL SECURITY;

-- Users can read their own session state
CREATE POLICY "Users can read own session state"
  ON public.socratic_session_state
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own session state
CREATE POLICY "Users can insert own session state"
  ON public.socratic_session_state
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own session state
CREATE POLICY "Users can update own session state"
  ON public.socratic_session_state
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role can do everything (for backend functions)
CREATE POLICY "Service role full access to session state"
  ON public.socratic_session_state
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Users can read history for their own sessions
CREATE POLICY "Users can read own state history"
  ON public.socratic_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.socratic_session_state s
      WHERE s.id = session_state_id AND s.user_id = auth.uid()
    )
  );

-- Service role can do everything on history (for backend functions)
CREATE POLICY "Service role full access to state history"
  ON public.socratic_state_history
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- =============================================================================
-- Instructors/Admins can view student states for their courses
-- =============================================================================

-- Instructors can read session states for courses they teach
CREATE POLICY "Instructors can read course session states"
  ON public.socratic_session_state
  FOR SELECT
  USING (
    public.is_course_instructor(course_id, auth.uid())
  );

-- Admins can read all session states in their institution
CREATE POLICY "Admins can read institution session states"
  ON public.socratic_session_state
  FOR SELECT
  USING (
    public.is_institution_admin(
      (SELECT institution_id FROM public.courses WHERE id = socratic_session_state.course_id),
      auth.uid()
    )
  );

-- Instructors can read state history for courses they teach
CREATE POLICY "Instructors can read course state history"
  ON public.socratic_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.socratic_session_state s
      WHERE s.id = session_state_id
        AND public.is_course_instructor(s.course_id, auth.uid())
    )
  );

-- Admins can read all state history in their institution
CREATE POLICY "Admins can read institution state history"
  ON public.socratic_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.socratic_session_state s
      JOIN public.courses c ON c.id = s.course_id
      WHERE s.id = session_state_id
        AND public.is_institution_admin(c.institution_id, auth.uid())
    )
  );

-- =============================================================================
-- Auto-update updated_at trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION update_socratic_session_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_socratic_session_state_updated_at
  BEFORE UPDATE ON public.socratic_session_state
  FOR EACH ROW
  EXECUTE FUNCTION update_socratic_session_state_updated_at();

-- =============================================================================
-- Phase 2: Data Migration - Populate from existing tutor_state
-- =============================================================================

-- Migrate existing state data from open_question_chats to new table
-- This takes the most recent tutor_state for each user+question combination
INSERT INTO public.socratic_session_state (user_id, open_question_id, course_id, current_state)
SELECT DISTINCT ON (user_id, open_question_id)
  user_id,
  open_question_id,
  course_id,
  tutor_state
FROM public.open_question_chats
WHERE tutor_state IS NOT NULL
  AND role = 'assistant'
  AND user_id IS NOT NULL
ORDER BY user_id, open_question_id, created_at DESC
ON CONFLICT (user_id, open_question_id) DO NOTHING;

-- =============================================================================
-- Phase 3: Drop legacy column
-- =============================================================================

-- Remove the tutor_state column from open_question_chats
ALTER TABLE public.open_question_chats DROP COLUMN IF EXISTS tutor_state;
