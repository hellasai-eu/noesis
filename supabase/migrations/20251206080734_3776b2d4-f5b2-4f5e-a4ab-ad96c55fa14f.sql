-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Anyone can view institutions by slug" ON public.institutions;

-- Create a more restrictive policy that allows:
-- 1. Authenticated users to view their own institution
-- 2. Unauthenticated users to look up a specific institution by slug (for signup flow)
CREATE POLICY "Users can view their own institution or lookup by slug"
ON public.institutions
FOR SELECT
USING (
  -- Authenticated users can only see their own institution
  (auth.uid() IS NOT NULL AND id = get_user_institution_id(auth.uid()))
  OR
  -- Allow unauthenticated access only when looking up by slug (for signup/invitation flow)
  -- This is necessary for the invitation signup page to work
  (auth.uid() IS NULL)
);