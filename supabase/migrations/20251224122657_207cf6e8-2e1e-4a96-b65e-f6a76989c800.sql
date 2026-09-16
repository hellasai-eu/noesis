-- Add page_count column to course_materials table
ALTER TABLE public.course_materials
ADD COLUMN page_count integer;