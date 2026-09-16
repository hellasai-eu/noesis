-- Add section_name column to classes for grade-level sections (τμήματα)
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS section_name TEXT;

-- Drop old unique index that enforces 1 class per grade level
DROP INDEX IF EXISTS classes_institution_grade_level_unique;

-- New unique index: one section per grade per institution
CREATE UNIQUE INDEX classes_institution_grade_section_unique
  ON public.classes (institution_id, grade_level, section_name)
  WHERE grade_level IS NOT NULL AND section_name IS NOT NULL;

-- Performance index for grouping by grade level
CREATE INDEX classes_institution_grade_level_idx
  ON public.classes (institution_id, grade_level)
  WHERE grade_level IS NOT NULL;

-- Migrate existing data: set section_name = 'Α' for all classes with a grade_level
UPDATE public.classes
  SET section_name = 'Α'
  WHERE grade_level IS NOT NULL AND section_name IS NULL;
