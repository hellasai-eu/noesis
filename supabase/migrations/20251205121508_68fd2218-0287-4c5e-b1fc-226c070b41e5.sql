-- Allow anyone to view institutions by slug (for the public institution page)
DROP POLICY IF EXISTS "Users can view their institution" ON public.institutions;

CREATE POLICY "Anyone can view institutions by slug" 
ON public.institutions 
FOR SELECT 
TO public
USING (true);