-- Create login history table to track user IPs and login times
CREATE TABLE public.login_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  login_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster lookups by user
CREATE INDEX idx_login_history_user_id ON public.login_history(user_id);
CREATE INDEX idx_login_history_login_at ON public.login_history(login_at DESC);

-- Enable RLS
ALTER TABLE public.login_history ENABLE ROW LEVEL SECURITY;

-- Users can view their own login history
CREATE POLICY "Users can view their own login history"
ON public.login_history
FOR SELECT
USING (user_id = auth.uid());

-- Admins can view all login history in their institution
CREATE POLICY "Admins can view login history"
ON public.login_history
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM user_institutions ui1
    JOIN user_institutions ui2 ON ui1.institution_id = ui2.institution_id
    WHERE ui1.user_id = auth.uid() 
    AND ui1.role = 'admin'
    AND ui2.user_id = login_history.user_id
  )
);

-- Allow inserts from authenticated users (for their own records)
CREATE POLICY "Users can insert their own login history"
ON public.login_history
FOR INSERT
WITH CHECK (user_id = auth.uid());