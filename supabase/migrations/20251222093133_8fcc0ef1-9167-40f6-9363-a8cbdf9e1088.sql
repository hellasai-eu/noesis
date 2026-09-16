-- Create table to store flagged content for review
CREATE TABLE public.flagged_content (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  data jsonb NOT NULL,
  description text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.flagged_content ENABLE ROW LEVEL SECURITY;

-- Only super admins can view flagged content (not exposed to regular users)
CREATE POLICY "Super admins can view flagged content"
ON public.flagged_content
FOR SELECT
USING (is_super_admin(auth.uid()));

-- Only super admins can delete flagged content
CREATE POLICY "Super admins can delete flagged content"
ON public.flagged_content
FOR DELETE
USING (is_super_admin(auth.uid()));