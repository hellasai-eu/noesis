-- Add instructions column to material_chapters for AI guidance
ALTER TABLE public.material_chapters 
ADD COLUMN instructions text;