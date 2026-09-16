-- Create table for AI usage logging
CREATE TABLE public.ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Request context
  function_name TEXT NOT NULL,
  prompt_key TEXT,
  trace_id TEXT,
  -- AI details
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  response_id TEXT,
  -- Token usage
  input_tokens INTEGER NOT NULL DEFAULT 0,
  input_tokens_cached INTEGER DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens_reasoning INTEGER DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  -- Response metadata
  response_time_ms INTEGER,
  -- Context (for aggregation)
  institution_id UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  user_id UUID,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for efficient querying
CREATE INDEX idx_ai_usage_institution ON public.ai_usage_logs(institution_id, created_at DESC);
CREATE INDEX idx_ai_usage_course ON public.ai_usage_logs(course_id, created_at DESC);
CREATE INDEX idx_ai_usage_function ON public.ai_usage_logs(function_name, created_at DESC);
CREATE INDEX idx_ai_usage_model ON public.ai_usage_logs(model, created_at DESC);
CREATE INDEX idx_ai_usage_created ON public.ai_usage_logs(created_at DESC);

-- Enable RLS
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;

-- Super admins can view all usage
CREATE POLICY "Super admins can view all AI usage" ON public.ai_usage_logs
  FOR SELECT USING (is_super_admin(auth.uid()));

-- Institution admins can view their institution's usage
CREATE POLICY "Admins can view institution AI usage" ON public.ai_usage_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.user_institutions ui
      WHERE ui.user_id = auth.uid()
      AND ui.institution_id = ai_usage_logs.institution_id
      AND ui.role = 'admin'
    )
  );