-- Create a security definer function to get user's institution_id without recursion
CREATE OR REPLACE FUNCTION public.get_user_institution_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT institution_id
  FROM public.profiles
  WHERE user_id = _user_id
  LIMIT 1
$$;

-- Drop the problematic policy
DROP POLICY IF EXISTS "Users can view profiles in their institution" ON public.profiles;

-- Recreate the policy using the security definer function
CREATE POLICY "Users can view profiles in their institution" 
ON public.profiles 
FOR SELECT 
USING (
  institution_id = public.get_user_institution_id(auth.uid())
  OR user_id = auth.uid()
);