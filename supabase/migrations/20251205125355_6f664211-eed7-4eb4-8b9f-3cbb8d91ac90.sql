-- Allow admins to update their own institution
CREATE POLICY "Admins can update their institution"
ON public.institutions FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM profiles
    WHERE profiles.user_id = auth.uid()
    AND profiles.role = 'admin'
    AND profiles.institution_id = institutions.id
  )
);