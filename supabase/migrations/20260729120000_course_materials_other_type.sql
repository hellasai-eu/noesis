-- Adds the "other" material type: a standalone PDF an instructor can upload to
-- Course Materials that is usable ONLY as a study guide source.
--
-- Unlike a textbook, an "other" material is not split into chapters and is not
-- offered to any of the question/flashcard/cheat-sheet generators or the
-- tutoring sessions — the study guide flow attaches the whole document via
-- `course_materials.openai_file_id`. Those exclusions are enforced in the app
-- (client queries + the generation edge functions); this migration only widens
-- the allowed vocabulary.

ALTER TABLE public.course_materials
  DROP CONSTRAINT IF EXISTS course_materials_type_check;

ALTER TABLE public.course_materials
  ADD CONSTRAINT course_materials_type_check
  CHECK (material_type IN (
    'textbook',
    'teacher_companion',
    'reference_exercises',
    'images',
    'other'
  ));

COMMENT ON COLUMN public.course_materials.material_type IS
  'textbook | teacher_companion | reference_exercises | images | other. '
  '"other" is a study-guide-only source: no chapters, excluded from every other AI generator.';
