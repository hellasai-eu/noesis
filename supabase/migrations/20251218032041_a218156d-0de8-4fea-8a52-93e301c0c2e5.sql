-- Add vector_store_id to institutions table
ALTER TABLE public.institutions 
ADD COLUMN vector_store_id text;

-- Remove vector_store_id from courses table (no longer needed per-course)
ALTER TABLE public.courses 
DROP COLUMN IF EXISTS vector_store_id;