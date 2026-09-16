
-- Drop existing institution SELECT policies
DROP POLICY IF EXISTS "Users can view their institutions" ON public.institutions;
DROP POLICY IF EXISTS "Super admins can view all institutions" ON public.institutions;

-- Create a single unified SELECT policy for institutions
CREATE POLICY "Users can view accessible institutions" ON public.institutions 
FOR SELECT USING (
  user_belongs_to_institution(auth.uid(), id) 
  OR is_super_admin(auth.uid())
);
