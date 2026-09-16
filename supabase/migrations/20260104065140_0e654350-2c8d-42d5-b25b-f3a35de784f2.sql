-- Drop the existing super-admin-only policy
DROP POLICY IF EXISTS "Super admins can create institutions" ON public.institutions;

-- Create new policy allowing any authenticated user to create institutions
CREATE POLICY "Authenticated users can create institutions" 
ON public.institutions 
FOR INSERT 
TO authenticated
WITH CHECK (true);