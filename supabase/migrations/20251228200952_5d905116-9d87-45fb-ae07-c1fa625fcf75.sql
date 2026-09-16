-- Create system_config table for feature flags
CREATE TABLE public.system_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb NOT NULL DEFAULT '{}',
  description text,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on system_config
ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY;

-- Super admins can view system config
CREATE POLICY "Super admins can view system config"
ON public.system_config
FOR SELECT
USING (is_super_admin(auth.uid()));

-- Super admins can insert system config
CREATE POLICY "Super admins can insert system config"
ON public.system_config
FOR INSERT
WITH CHECK (is_super_admin(auth.uid()));

-- Super admins can update system config
CREATE POLICY "Super admins can update system config"
ON public.system_config
FOR UPDATE
USING (is_super_admin(auth.uid()));

-- Super admins can delete system config
CREATE POLICY "Super admins can delete system config"
ON public.system_config
FOR DELETE
USING (is_super_admin(auth.uid()));

-- Create agent_interaction_logs table for storing LLM outputs
CREATE TABLE public.agent_interaction_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text NOT NULL,
  trace_id text,
  question_id uuid,
  course_id uuid,
  user_id uuid,
  
  -- Input data
  user_message text,
  incoming_state jsonb,
  
  -- Stage outputs
  evaluator_output jsonb,
  planner_output jsonb,
  presenter_output text,
  
  -- Final response
  final_response jsonb,
  
  -- Metadata
  language text,
  is_first_message boolean DEFAULT false,
  response_time_ms integer,
  
  created_at timestamp with time zone DEFAULT now()
);

-- Enable RLS on agent_interaction_logs
ALTER TABLE public.agent_interaction_logs ENABLE ROW LEVEL SECURITY;

-- Super admins can view all agent interaction logs
CREATE POLICY "Super admins can view agent interaction logs"
ON public.agent_interaction_logs
FOR SELECT
USING (is_super_admin(auth.uid()));

-- Super admins can delete agent interaction logs
CREATE POLICY "Super admins can delete agent interaction logs"
ON public.agent_interaction_logs
FOR DELETE
USING (is_super_admin(auth.uid()));

-- Create updated_at trigger for system_config
CREATE TRIGGER update_system_config_updated_at
BEFORE UPDATE ON public.system_config
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for efficient querying
CREATE INDEX idx_agent_interaction_logs_created_at ON public.agent_interaction_logs(created_at DESC);
CREATE INDEX idx_agent_interaction_logs_function_name ON public.agent_interaction_logs(function_name);
CREATE INDEX idx_agent_interaction_logs_course_id ON public.agent_interaction_logs(course_id);
CREATE INDEX idx_agent_interaction_logs_user_id ON public.agent_interaction_logs(user_id);

-- Insert the default logging config (disabled by default)
INSERT INTO public.system_config (key, value, description)
VALUES ('ta_agent_verbose_logging', '{"enabled": false}', 'Enable verbose logging of TA Agent QA interactions');