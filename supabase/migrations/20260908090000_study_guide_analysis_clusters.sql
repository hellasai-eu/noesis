-- Misconception-based student clusters on the study-guide assessment.
--
-- `quiz_analyses` has carried a `clusters` column since 20260715000000; this
-- brings its study-guide sibling to the same shape so the instructor can act on
-- a live guide the way they already act on a closed quiz — see which students
-- share a conceptual struggle, and turn that reading into real offering groups.
--
-- Same JSON shape as quiz_analyses.clusters:
--   [{ label, rationale, summary, member_user_ids }]
--
-- DEFAULT '[]' rather than NULL so every reader — the panel, the analyze
-- function's upsert, anything downstream — sees a list. Rows written before
-- this migration were produced by a handler that had no clusters to write, so
-- backfilling them with an empty list is the truth, not a placeholder.
ALTER TABLE public.study_guide_analyses
  ADD COLUMN clusters JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.study_guide_analyses.clusters IS
  'Misconception-based student clusters: [{ label, rationale, summary, member_user_ids }]. Scoped, like the rest of the row, to (study_guide_id, offering_id, group_id).';
