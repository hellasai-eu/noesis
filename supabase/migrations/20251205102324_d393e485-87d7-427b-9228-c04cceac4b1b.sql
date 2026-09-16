-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Authenticated users can upload course materials" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read course materials" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete course materials" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated reads" ON storage.objects;
DROP POLICY IF EXISTS "Allow authenticated deletes" ON storage.objects;

-- Create new storage policies for course-materials bucket
CREATE POLICY "Allow authenticated uploads"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'course-materials');

CREATE POLICY "Allow authenticated reads"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'course-materials');

CREATE POLICY "Allow authenticated deletes"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'course-materials');