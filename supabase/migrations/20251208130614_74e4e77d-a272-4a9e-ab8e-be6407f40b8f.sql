-- Add is_public column to institutions
ALTER TABLE public.institutions 
ADD COLUMN is_public boolean NOT NULL DEFAULT false;

-- Drop existing SELECT policy
DROP POLICY IF EXISTS "Users can view accessible institutions" ON public.institutions;

-- Create new SELECT policy that includes public institutions
CREATE POLICY "Users can view accessible institutions" 
ON public.institutions 
FOR SELECT 
USING (
  user_belongs_to_institution(auth.uid(), id) 
  OR is_super_admin(auth.uid())
  OR is_public = true
);