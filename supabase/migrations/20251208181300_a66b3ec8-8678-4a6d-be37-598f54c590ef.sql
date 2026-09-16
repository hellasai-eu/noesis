-- Add session_id to track different chat sessions
ALTER TABLE public.textbook_chat_messages 
ADD COLUMN session_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Add session name/title for display
ALTER TABLE public.textbook_chat_messages 
ADD COLUMN session_name TEXT;

-- Create index for efficient session queries
CREATE INDEX idx_textbook_chat_sessions 
ON public.textbook_chat_messages(user_id, material_id, session_id, created_at DESC);