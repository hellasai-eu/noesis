-- Drop the existing SELECT policy
DROP POLICY IF EXISTS "Users can view accessible institutions" ON public.institutions;

-- Create new policy requiring authentication
CREATE POLICY "Authenticated users can view accessible institutions"
  ON public.institutions
  FOR SELECT
  USING (
    auth.role() = 'authenticated' AND (
      user_belongs_to_institution(auth.uid(), id) 
      OR is_super_admin(auth.uid()) 
      OR (is_public = true)
    )
  );