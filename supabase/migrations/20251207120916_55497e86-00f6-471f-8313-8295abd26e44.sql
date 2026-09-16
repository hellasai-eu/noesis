-- Add thumbnail_url column to course_materials
ALTER TABLE public.course_materials 
ADD COLUMN thumbnail_url text;