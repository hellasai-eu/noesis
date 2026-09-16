-- Create storage bucket for institution logos
INSERT INTO storage.buckets (id, name, public)
VALUES ('institution-logos', 'institution-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload to their institution folder
CREATE POLICY "Users can upload institution logos"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'institution-logos' 
  AND auth.uid() IS NOT NULL
);

-- Allow anyone to view institution logos (public bucket)
CREATE POLICY "Anyone can view institution logos"
ON storage.objects FOR SELECT
USING (bucket_id = 'institution-logos');

-- Allow admins to update/delete their institution logos
CREATE POLICY "Admins can update institution logos"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'institution-logos'
  AND auth.uid() IS NOT NULL
);

CREATE POLICY "Admins can delete institution logos"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'institution-logos'
  AND auth.uid() IS NOT NULL
);