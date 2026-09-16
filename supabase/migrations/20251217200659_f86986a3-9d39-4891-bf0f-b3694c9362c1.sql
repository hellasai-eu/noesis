-- Add vector_store_id column to courses table
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS vector_store_id text;