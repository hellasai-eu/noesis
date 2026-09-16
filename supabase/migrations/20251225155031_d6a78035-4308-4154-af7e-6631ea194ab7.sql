-- Add openai_file_id column to material_chapters for storing OpenAI file references
ALTER TABLE public.material_chapters 
ADD COLUMN openai_file_id text;