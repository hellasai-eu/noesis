-- Drop the existing policies that expose emails to all institution users
DROP POLICY IF EXISTS "Users can view profiles in their institution" ON public.profiles;
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;

-- Create policy: Users can only view their own profile
CREATE POLICY "Users can view their own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Create policy: Admins can view all profiles in their institution
CREATE POLICY "Admins can view all profiles in their institution"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid())
);

-- Create a secure function to get user display names for features like leaderboards
-- This returns only non-sensitive data (name) and can be used by non-admins
CREATE OR REPLACE FUNCTION public.get_user_display_name(_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(full_name, 'Anonymous')
  FROM public.profiles
  WHERE user_id = _user_id
  LIMIT 1
$$;