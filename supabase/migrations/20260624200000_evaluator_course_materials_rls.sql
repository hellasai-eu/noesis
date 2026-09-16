-- Evaluator SELECT on course_materials (gap-fill for #667 / epic #663).
--
-- #664 added evaluator SELECT policies on every table the unified question
-- bank reads EXCEPT `course_materials`. The bank's chapter loader joins
-- `material_chapters!inner(... course_materials!inner(...))`, so the
-- !inner join silently filters out chapter context when an evaluator runs
-- it. Add the missing additive policy here.
--
-- Same shape as the other evaluator policies in 20260624100000: SELECT-only,
-- gated on is_course_evaluator(course_id, auth.uid()). No INSERT/UPDATE/
-- DELETE branch — RLS default-deny continues to block writes for evaluators.

CREATE POLICY "Evaluators can view course materials for assigned courses"
  ON public.course_materials FOR SELECT
  USING (is_course_evaluator(course_materials.course_id, auth.uid()));
