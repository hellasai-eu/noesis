-- Drop existing foreign key if it exists and recreate with CASCADE
ALTER TABLE public.material_chapters
DROP CONSTRAINT IF EXISTS material_chapters_material_id_fkey;

ALTER TABLE public.material_chapters
ADD CONSTRAINT material_chapters_material_id_fkey
FOREIGN KEY (material_id) REFERENCES public.course_materials(id) ON DELETE CASCADE;