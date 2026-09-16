-- Add description and moderated columns for image uploads
ALTER TABLE public.course_materials 
ADD COLUMN IF NOT EXISTS ai_description TEXT,
ADD COLUMN IF NOT EXISTS is_moderated BOOLEAN DEFAULT false;