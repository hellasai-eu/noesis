-- Study Tutor Session State Management
-- Creates dedicated tables for study tutor state (follows socratic_session_state pattern)

-- =============================================================================
-- Phase 1: Create new state tables
-- =============================================================================

-- Table: study_tutor_session_state
-- Stores the current state for each user+progress combination
CREATE TABLE public.study_tutor_session_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  progress_id UUID NOT NULL REFERENCES public.student_study_progress(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  current_state JSONB NOT NULL DEFAULT '{
    "subject": "",
    "current_topic": "",
    "learning_goal": "",
    "progress_level": "intro",
    "known": [],
    "gaps": [],
    "misconceptions": [],
    "difficulty": "same",
    "frustration": 0,
    "image_enabled": false
  }'::jsonb,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_progress UNIQUE (user_id, progress_id)
);

-- Table: study_tutor_state_history
-- Logs all state transitions for analytics and debugging
CREATE TABLE public.study_tutor_state_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_state_id UUID NOT NULL REFERENCES public.study_tutor_session_state(id) ON DELETE CASCADE,
  state_before JSONB,
  state_after JSONB NOT NULL,
  message_id UUID REFERENCES public.study_session_messages(id) ON DELETE SET NULL,
  transition_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- Indexes for performance
-- =============================================================================

-- Fast lookup by user and progress
CREATE INDEX idx_study_tutor_state_user_progress
  ON public.study_tutor_session_state(user_id, progress_id);

-- Fast lookup by course for analytics
CREATE INDEX idx_study_tutor_state_course
  ON public.study_tutor_session_state(course_id);

-- History lookups by session
CREATE INDEX idx_study_tutor_state_history_session
  ON public.study_tutor_state_history(session_state_id);

-- History lookups by time for analytics
CREATE INDEX idx_study_tutor_state_history_created
  ON public.study_tutor_state_history(created_at);

-- =============================================================================
-- Row Level Security
-- =============================================================================

ALTER TABLE public.study_tutor_session_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.study_tutor_state_history ENABLE ROW LEVEL SECURITY;

-- Users can read their own session state
CREATE POLICY "Users can read own session state"
  ON public.study_tutor_session_state
  FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own session state
CREATE POLICY "Users can insert own session state"
  ON public.study_tutor_session_state
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own session state
CREATE POLICY "Users can update own session state"
  ON public.study_tutor_session_state
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role can do everything (for backend functions)
CREATE POLICY "Service role full access to session state"
  ON public.study_tutor_session_state
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- Users can read history for their own sessions
CREATE POLICY "Users can read own state history"
  ON public.study_tutor_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.study_tutor_session_state s
      WHERE s.id = session_state_id AND s.user_id = auth.uid()
    )
  );

-- Service role can do everything on history (for backend functions)
CREATE POLICY "Service role full access to state history"
  ON public.study_tutor_state_history
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- =============================================================================
-- Instructors/Admins can view student states for their courses
-- =============================================================================

-- Instructors can read session states for courses they teach
CREATE POLICY "Instructors can read course session states"
  ON public.study_tutor_session_state
  FOR SELECT
  USING (
    public.is_course_instructor(course_id, auth.uid())
  );

-- Admins can read all session states in their institution
CREATE POLICY "Admins can read institution session states"
  ON public.study_tutor_session_state
  FOR SELECT
  USING (
    public.is_institution_admin(
      (SELECT institution_id FROM public.courses WHERE id = study_tutor_session_state.course_id),
      auth.uid()
    )
  );

-- Instructors can read state history for courses they teach
CREATE POLICY "Instructors can read course state history"
  ON public.study_tutor_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.study_tutor_session_state s
      WHERE s.id = session_state_id
        AND public.is_course_instructor(s.course_id, auth.uid())
    )
  );

-- Admins can read all state history in their institution
CREATE POLICY "Admins can read institution state history"
  ON public.study_tutor_state_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.study_tutor_session_state s
      JOIN public.courses c ON c.id = s.course_id
      WHERE s.id = session_state_id
        AND public.is_institution_admin(c.institution_id, auth.uid())
    )
  );

-- =============================================================================
-- Auto-update updated_at trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION update_study_tutor_session_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_study_tutor_session_state_updated_at
  BEFORE UPDATE ON public.study_tutor_session_state
  FOR EACH ROW
  EXECUTE FUNCTION update_study_tutor_session_state_updated_at();
