-- Documentation only: restates what the "other" material type means.
--
-- `20260729120000_course_materials_other_type.sql` introduced it as a
-- study-guide-only source and said so on the column: "excluded from every other
-- AI generator". That is no longer true. The question generators (MCQ, open,
-- fill-the-gaps, ordering, classification) and tutoring sessions now take an
-- "other" material as a WHOLE DOCUMENT, attached via
-- `course_materials.openai_file_id` the way study guides always have —
-- questions generated from one simply carry no `question_chapters` rows,
-- because a document with no chapters has no chapter to point at.
--
-- Flashcards and cheat sheets still refuse it, but not because of this type:
-- both generate from `textbook` materials only, a stricter rule enforced in
-- `generate-flashcards` and `generate-cheatsheet`.
--
-- Nothing structural changes here. The vocabulary is unchanged, and the
-- chapterless invariant in `20260729130000_guard_chapterless_material_types.sql`
-- still holds — it is what makes "whole document" the only way to use one.

COMMENT ON COLUMN public.course_materials.material_type IS
  'textbook | teacher_companion | reference_exercises | images | other. '
  '"other" is a whole-document source: never split into chapters, so study '
  'guides, the question generators and tutoring sessions attach the entire '
  'file via openai_file_id. Flashcards and cheat sheets take textbooks only.';
