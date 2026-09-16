-- Add column to store OpenAI file ID for materials
ALTER TABLE public.course_materials 
ADD COLUMN openai_file_id TEXT NULL;

COMMENT ON COLUMN public.course_materials.openai_file_id IS 'OpenAI Files API file ID for use with Assistants/Responses API';