-- Add tutor_state column to store AI tutor metadata (state_update and meta)
ALTER TABLE public.open_question_chats 
ADD COLUMN IF NOT EXISTS tutor_state jsonb DEFAULT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN public.open_question_chats.tutor_state IS 'Stores AI tutor state_update and meta fields for instructor visibility';