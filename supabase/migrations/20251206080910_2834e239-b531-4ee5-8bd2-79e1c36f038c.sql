-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Anyone can verify invitation by email" ON public.invitations;

-- Create a restrictive policy that allows:
-- 1. Authenticated admins to view invitations in their institution
-- 2. Users to view invitations matching their own email (for signup verification)
CREATE POLICY "Users can view invitations for their email or admins can view all"
ON public.invitations
FOR SELECT
USING (
  -- Admins can view all invitations in their institution
  (EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
      AND profiles.role = 'admin'
      AND profiles.institution_id = invitations.institution_id
  ))
  OR
  -- Users can only see invitations for their own email
  (auth.jwt() ->> 'email' = email)
);