-- Allow unauthenticated users to verify pending invitations by email and institution
-- This is needed for the signup flow where users need to verify their invitation before creating an account
CREATE POLICY "Anyone can verify pending invitations by email"
ON public.invitations
FOR SELECT
TO anon
USING (status = 'pending');