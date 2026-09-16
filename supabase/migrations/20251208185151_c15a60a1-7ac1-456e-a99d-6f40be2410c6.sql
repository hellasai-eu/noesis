-- Add column to store Google AI file URI for uploaded PDFs
ALTER TABLE public.course_materials 
ADD COLUMN IF NOT EXISTS google_file_uri TEXT,
ADD COLUMN IF NOT EXISTS google_file_uploaded_at TIMESTAMP WITH TIME ZONE;