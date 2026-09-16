-- Drop existing restrictive policies on institutions
DROP POLICY IF EXISTS "Authenticated users can create institutions" ON public.institutions;
DROP POLICY IF EXISTS "Users can view their institution" ON public.institutions;

-- Create PERMISSIVE policies for institutions
CREATE POLICY "Authenticated users can create institutions" 
ON public.institutions 
FOR INSERT 
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Users can view their institution" 
ON public.institutions 
FOR SELECT 
TO authenticated
USING (
  id = public.get_user_institution_id(auth.uid())
  OR NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE institution_id = institutions.id
  )
);