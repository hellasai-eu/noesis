-- Allow anyone to verify an invitation exists by email and institution_id
-- This is needed for the invitation signup flow to validate the invitation
CREATE POLICY "Anyone can verify invitation by email"
ON public.invitations
FOR SELECT
USING (true);

-- Drop the admin-only select policy since we now have a public one
DROP POLICY IF EXISTS "Admins can view invitations for their institution" ON public.invitations;