-- Allow users to update their own invitation (by matching email) to mark it as accepted
CREATE POLICY "Users can accept their own invitation"
ON public.invitations
FOR UPDATE
TO authenticated
USING ((auth.jwt() ->> 'email') = email AND status = 'pending')
WITH CHECK ((auth.jwt() ->> 'email') = email AND status = 'accepted');