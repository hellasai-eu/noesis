-- Add reference_images column to store instructor-uploaded images
ALTER TABLE public.study_sessions 
ADD COLUMN reference_images jsonb DEFAULT '[]'::jsonb;

-- Create storage bucket for study session images
INSERT INTO storage.buckets (id, name, public)
VALUES ('study-session-images', 'study-session-images', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload images
CREATE POLICY "Authenticated users can upload study session images"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'study-session-images');

-- Allow anyone to view study session images
CREATE POLICY "Anyone can view study session images"
ON storage.objects FOR SELECT
USING (bucket_id = 'study-session-images');

-- Allow uploaders to delete their own images
CREATE POLICY "Users can delete their own study session images"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'study-session-images' AND auth.uid()::text = (storage.foldername(name))[1]);