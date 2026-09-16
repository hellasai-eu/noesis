-- Add policy for public access to exercise PDFs
CREATE POLICY "Public can view exercise PDFs"
ON storage.objects
FOR SELECT
USING (bucket_id = 'course-materials' AND (storage.foldername(name))[1] = 'exercise-pdfs');