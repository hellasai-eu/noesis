-- Create super_admins table to track super admin users
CREATE TABLE public.super_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS on super_admins
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

-- Only super admins can view the super_admins table
CREATE POLICY "Super admins can view super_admins"
ON public.super_admins
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.super_admins sa
    WHERE sa.email = (SELECT email FROM auth.users WHERE id = auth.uid())
  )
);

-- Insert initial super admin
INSERT INTO public.super_admins (email) VALUES ('alexandrosb@gmail.com');

-- Create a security definer function to check if user is super admin
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins sa
    JOIN auth.users u ON u.email = sa.email
    WHERE u.id = _user_id
  )
$$;

-- Drop the existing overly permissive institution creation policy
DROP POLICY IF EXISTS "Authenticated users can create institutions" ON public.institutions;

-- Create new policy: Only super admins can create institutions
CREATE POLICY "Super admins can create institutions"
ON public.institutions
FOR INSERT
TO authenticated
WITH CHECK (is_super_admin(auth.uid()));

-- Allow super admins to view all institutions
CREATE POLICY "Super admins can view all institutions"
ON public.institutions
FOR SELECT
TO authenticated
USING (is_super_admin(auth.uid()));

-- Allow super admins to update any institution
CREATE POLICY "Super admins can update all institutions"
ON public.institutions
FOR UPDATE
TO authenticated
USING (is_super_admin(auth.uid()));

-- Allow super admins to delete institutions
CREATE POLICY "Super admins can delete institutions"
ON public.institutions
FOR DELETE
TO authenticated
USING (is_super_admin(auth.uid()));