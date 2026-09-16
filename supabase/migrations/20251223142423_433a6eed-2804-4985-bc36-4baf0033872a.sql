-- Drop existing SELECT policy for study-session-images
DROP POLICY IF EXISTS "Anyone can view study session images" ON storage.objects;

-- Create a new policy that allows true public access (no authentication required)
CREATE POLICY "Anyone can view study session images"
ON storage.objects FOR SELECT
USING (bucket_id = 'study-session-images');