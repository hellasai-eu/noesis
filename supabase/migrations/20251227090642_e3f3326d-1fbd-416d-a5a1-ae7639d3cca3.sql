-- Audit log table for prompt changes
CREATE TABLE public.prompt_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL, -- 'create', 'update', 'delete'
  target_type TEXT NOT NULL, -- 'default' or 'institution_override'
  target_id UUID NOT NULL,
  prompt_key TEXT NOT NULL,
  institution_id UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
  old_values JSONB,
  new_values JSONB,
  changed_by UUID REFERENCES auth.users(id),
  changed_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.prompt_audit_log ENABLE ROW LEVEL SECURITY;

-- Only super admins can view audit logs
CREATE POLICY "Super admins can view prompt audit logs"
ON public.prompt_audit_log FOR SELECT
USING (is_super_admin(auth.uid()));

-- Only super admins can insert audit logs
CREATE POLICY "Super admins can insert prompt audit logs"
ON public.prompt_audit_log FOR INSERT
WITH CHECK (is_super_admin(auth.uid()));

-- Create index for faster queries
CREATE INDEX idx_prompt_audit_log_prompt_key ON public.prompt_audit_log(prompt_key);
CREATE INDEX idx_prompt_audit_log_created_at ON public.prompt_audit_log(created_at DESC);