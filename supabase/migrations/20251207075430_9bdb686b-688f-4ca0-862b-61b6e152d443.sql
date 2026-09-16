-- Allow users to create their own institution membership when accepting an invitation
-- This checks that there's a pending invitation for their email for this institution
CREATE POLICY "Users can join institution via invitation"
ON public.user_institutions
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid() AND
  EXISTS (
    SELECT 1 FROM public.invitations
    WHERE invitations.institution_id = user_institutions.institution_id
    AND invitations.email = (auth.jwt() ->> 'email')
    AND invitations.status = 'pending'
  )
);