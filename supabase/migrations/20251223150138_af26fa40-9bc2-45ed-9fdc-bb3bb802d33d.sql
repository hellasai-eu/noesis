-- Drop and recreate the SELECT policy to ensure it works for truly anonymous access
DROP POLICY IF EXISTS "Anyone can view study session images" ON storage.objects;

-- Recreate with explicit public access - using TO public and anon
CREATE POLICY "Anyone can view study session images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'study-session-images');

-- Also ensure the bucket is properly set to public
UPDATE storage.buckets
SET public = true
WHERE id = 'study-session-images';