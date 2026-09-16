-- Add textbook chat toggle to courses table
ALTER TABLE public.courses 
ADD COLUMN textbook_chat_enabled boolean NOT NULL DEFAULT true;