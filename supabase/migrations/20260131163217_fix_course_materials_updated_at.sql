-- Fix course_materials table: add missing updated_at column
-- A trigger was added that expects this column but it doesn't exist
ALTER TABLE public.course_materials
ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Create the trigger if it doesn't exist (idempotent)
DROP TRIGGER IF EXISTS update_course_materials_updated_at ON public.course_materials;
CREATE TRIGGER update_course_materials_updated_at
  BEFORE UPDATE ON public.course_materials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
