-- Allow authenticated users to join public institutions as students
CREATE POLICY "Users can join public institutions"
ON public.user_institutions
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND role = 'student'
  AND EXISTS (
    SELECT 1 FROM institutions
    WHERE id = institution_id AND is_public = true
  )
);