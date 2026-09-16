-- Add column to control AI image generation during tutoring
ALTER TABLE public.study_sessions 
ADD COLUMN allow_image_generation boolean DEFAULT false;