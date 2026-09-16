-- Add cheat sheet columns to material_chapters
ALTER TABLE public.material_chapters
ADD COLUMN cheat_sheet text,
ADD COLUMN cheat_sheet_visible boolean NOT NULL DEFAULT false;