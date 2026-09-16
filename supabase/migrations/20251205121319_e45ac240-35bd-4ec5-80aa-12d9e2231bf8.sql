-- Allow admins to delete invitations from their institution
CREATE POLICY "Admins can delete invitations"
ON public.invitations
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
    AND profiles.institution_id = invitations.institution_id
  )
);