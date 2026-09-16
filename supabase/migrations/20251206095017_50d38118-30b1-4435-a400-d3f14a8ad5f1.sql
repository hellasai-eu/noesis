-- Add flashcards fields to material_chapters table
ALTER TABLE public.material_chapters
ADD COLUMN flashcards jsonb DEFAULT '[]'::jsonb,
ADD COLUMN flashcards_visible boolean NOT NULL DEFAULT false;