-- Add material_type column to course_materials
ALTER TABLE public.course_materials
ADD COLUMN material_type text NOT NULL DEFAULT 'textbook';

-- Update existing materials to have 'textbook' type (they already have it from default, but be explicit)
UPDATE public.course_materials SET material_type = 'textbook' WHERE material_type IS NULL;

-- Add check constraint for valid material types
ALTER TABLE public.course_materials
ADD CONSTRAINT course_materials_type_check 
CHECK (material_type IN ('textbook', 'teacher_companion', 'reference_exercises'));