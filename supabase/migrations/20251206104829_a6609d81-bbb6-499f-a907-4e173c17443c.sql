-- Remove institution_id and role columns from profiles table
-- These should be managed via user_institutions table instead

-- First, drop any policies that reference these columns
DROP POLICY IF EXISTS "Admins can view profiles" ON public.profiles;

-- Create new policy for viewing profiles
CREATE POLICY "Admins can view profiles"
ON public.profiles
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR 
  EXISTS (
    SELECT 1 FROM user_institutions ui 
    WHERE ui.user_id = auth.uid() AND ui.role = 'admin'
  )
);

-- Drop the columns
ALTER TABLE public.profiles DROP COLUMN IF EXISTS institution_id;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS role;