-- Add material_id to course_competencies to track which textbook the competency came from
ALTER TABLE public.course_competencies 
ADD COLUMN material_id uuid REFERENCES public.course_materials(id) ON DELETE SET NULL;

-- Add index for filtering by material
CREATE INDEX idx_course_competencies_material_id ON public.course_competencies(material_id);