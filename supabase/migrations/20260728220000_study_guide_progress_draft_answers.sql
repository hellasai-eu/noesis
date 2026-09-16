-- Persisted study-guide drafts (#980).
--
-- The sequential player collects a student's per-piece answers before the
-- single per-piece submit. Holding those selections only in the browser loses
-- them on an accidental navigation away. This column persists the unsubmitted
-- selections so the player can restore them — the study-guide analogue of
-- `quiz_sessions.draft_answers` (20260714000000).
--
-- Shape: { [pieceId]: { [questionId]: submission } } where `submission` is the
-- same per-type jsonb the graded answer stores (`{ selected_indices }`,
-- `{ fill_gaps }`, `{ ordering }`, `{ classification }`, `{ open_text }`).
-- Selections ONLY — never any grading. Correctness is computed exclusively
-- server-side and written to `study_guide_answers`, so nothing here can leak an
-- answer key or skew instructor analytics (which read the answer rows, not this
-- column). A piece's entry is cleared once that piece is submitted.
--
-- No new RLS: students already own their progress row via
-- "Students manage their own study guide progress"
-- (FOR ALL USING user_id = auth.uid()), which covers reading and writing this
-- column.
ALTER TABLE public.study_guide_progress
  ADD COLUMN IF NOT EXISTS draft_answers jsonb;

COMMENT ON COLUMN public.study_guide_progress.draft_answers IS
  'Unsubmitted study-guide player drafts (#980): { [pieceId]: { [questionId]: submission } }. Selections only, no grading. A piece''s entry is cleared on submit.';
