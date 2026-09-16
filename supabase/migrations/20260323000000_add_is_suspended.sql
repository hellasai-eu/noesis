-- Add is_suspended flag to user_institutions, preserving role information
ALTER TABLE public.user_institutions
  ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false;

-- Migrate existing suspended users: set flag and restore role to 'student'
-- (original role was lost when suspension overwrote it)
UPDATE public.user_institutions
  SET is_suspended = true
  WHERE role = 'suspended';

UPDATE public.user_institutions
  SET role = 'student'
  WHERE role = 'suspended';

-- Update core RLS helper functions to exclude suspended users.
-- These functions are used by most RLS policies, so adding the
-- is_suspended check here cascades to all dependent policies.

CREATE OR REPLACE FUNCTION public.is_institution_admin(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id
      AND institution_id = _institution_id
      AND role = 'admin'
      AND NOT is_suspended
  ) OR is_super_admin(_user_id)
$$;

CREATE OR REPLACE FUNCTION public.user_belongs_to_institution(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id
      AND institution_id = _institution_id
      AND NOT is_suspended
  )
$$;

CREATE OR REPLACE FUNCTION public.get_user_role_in_institution(_user_id uuid, _institution_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_institutions
  WHERE user_id = _user_id
    AND institution_id = _institution_id
    AND NOT is_suspended
  LIMIT 1
$$;
