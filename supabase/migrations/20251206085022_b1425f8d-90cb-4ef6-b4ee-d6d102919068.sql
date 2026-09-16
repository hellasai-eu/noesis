-- Drop the existing policy that allows unauthenticated access
DROP POLICY IF EXISTS "Users can view their own institution or lookup by slug" ON public.institutions;

-- Create a new policy that only allows authenticated users to view their own institution
CREATE POLICY "Users can view their own institution"
ON public.institutions
FOR SELECT
TO authenticated
USING (id = get_user_institution_id(auth.uid()));