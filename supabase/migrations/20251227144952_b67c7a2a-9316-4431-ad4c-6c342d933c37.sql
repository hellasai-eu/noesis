-- Create a public bucket for course thumbnails
INSERT INTO storage.buckets (id, name, public)
VALUES ('course-thumbnails', 'course-thumbnails', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public read access to thumbnails
CREATE POLICY "Anyone can view course thumbnails"
ON storage.objects FOR SELECT
USING (bucket_id = 'course-thumbnails');

-- Allow authenticated users to upload thumbnails (service role will bypass this anyway)
CREATE POLICY "Authenticated users can upload thumbnails"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'course-thumbnails');

-- Allow service role to manage thumbnails (for edge functions)
CREATE POLICY "Service role can manage thumbnails"
ON storage.objects FOR ALL
USING (bucket_id = 'course-thumbnails');