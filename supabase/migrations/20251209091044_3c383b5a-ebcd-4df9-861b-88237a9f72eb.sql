-- Add default language to institutions
ALTER TABLE public.institutions 
ADD COLUMN default_language text NOT NULL DEFAULT 'en';

-- Add language override to courses (null means use institution default)
ALTER TABLE public.courses 
ADD COLUMN language text DEFAULT NULL;

-- Add comment for clarity
COMMENT ON COLUMN public.institutions.default_language IS 'Default language code for all courses in this institution (e.g., en, el, es)';
COMMENT ON COLUMN public.courses.language IS 'Language override for this course. If null, uses institution default_language';