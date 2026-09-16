-- Add tutor_state column to store AI tutor state for debugging
ALTER TABLE public.open_question_chats 
ADD COLUMN tutor_state JSONB;