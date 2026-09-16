-- Drop the existing constraint
ALTER TABLE public.course_materials
DROP CONSTRAINT IF EXISTS course_materials_type_check;

-- Add updated constraint with "images" type
ALTER TABLE public.course_materials
ADD CONSTRAINT course_materials_type_check 
CHECK (material_type IN ('textbook', 'teacher_companion', 'reference_exercises', 'images'));