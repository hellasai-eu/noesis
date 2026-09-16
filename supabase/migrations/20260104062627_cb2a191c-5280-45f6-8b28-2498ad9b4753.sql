-- Add country column to institutions table
ALTER TABLE public.institutions
ADD COLUMN country TEXT;