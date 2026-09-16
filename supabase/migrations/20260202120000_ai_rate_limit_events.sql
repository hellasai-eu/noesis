-- AI Rate Limit Events Table
-- Tracks rate limiting events (429 errors and low-capacity warnings) from OpenAI API

-- Create enum for event types
CREATE TYPE public.rate_limit_event_type AS ENUM ('warning', 'throttled', 'exhausted');

-- Create the main table
CREATE TABLE public.ai_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type rate_limit_event_type NOT NULL,

  -- Request context
  function_name TEXT NOT NULL,
  prompt_key TEXT,
  trace_id TEXT,
  model TEXT,

  -- Rate limit headers from OpenAI
  limit_requests INTEGER,
  remaining_requests INTEGER,
  reset_requests TEXT,
  limit_tokens INTEGER,
  remaining_tokens INTEGER,
  reset_tokens TEXT,

  -- Retry tracking
  retry_attempt INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  delay_before_retry_ms INTEGER,
  eventual_success BOOLEAN,
  total_retry_time_ms INTEGER,
  error_message TEXT,
  http_status INTEGER,

  -- Context
  institution_id UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_rate_limit_events_created ON public.ai_rate_limit_events(created_at DESC);

CREATE INDEX idx_rate_limit_events_type ON public.ai_rate_limit_events(event_type, created_at DESC);

CREATE INDEX idx_rate_limit_events_function ON public.ai_rate_limit_events(function_name, created_at DESC);

-- Enable RLS
ALTER TABLE public.ai_rate_limit_events ENABLE ROW LEVEL SECURITY;

-- Service role has full access (edge functions use service role)
CREATE POLICY "Service role full access" ON public.ai_rate_limit_events
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Add comment for documentation
COMMENT ON TABLE public.ai_rate_limit_events IS 'Tracks AI API rate limiting events for monitoring and alerting';
