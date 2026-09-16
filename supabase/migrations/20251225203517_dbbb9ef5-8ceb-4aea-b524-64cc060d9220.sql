-- Add chapter_ids column to study_sessions table for multi-chapter support
ALTER TABLE public.study_sessions 
ADD COLUMN chapter_ids uuid[] DEFAULT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN public.study_sessions.chapter_ids IS 'Array of chapter IDs for multi-chapter study sessions. Replaces single chapter_id for new sessions.';