-- Add policy to allow reading pending invitations without authentication
-- This is needed because users haven't signed up yet when clicking the invitation link
CREATE POLICY "Pending invitations can be viewed by email" 
ON public.invitations 
FOR SELECT 
USING (
  status = 'pending'
);