-- #827 — Auto-save deferred-mode quiz drafts.
--
-- In a formal quiz with released answers hidden (deferred mode), the student's
-- in-progress selections previously lived only in the browser's memory and were
-- written to `quiz_answers` once, at final submit. Leaving before submitting lost
-- everything. We now persist those unsubmitted selections here so the existing
-- Resume flow can restore them.
--
-- This column holds ONLY the raw selections (MCQ option indices + the per-type
-- non-MCQ answer shapes) — never any grading. Correctness is still computed and
-- written to `quiz_answers` exclusively at final submit, so nothing here leaks
-- answers to the student (who can read their own rows via RLS) or skews the
-- instructor's score aggregation (which reads `quiz_answers`, not this column).
--
-- Only meaningful while the session is `in_progress`; it is cleared to NULL
-- when the attempt is finalized (completed) via the application submit flow.
-- Force-closing a session (`mark_offering_quiz_done`) does not clear it —
-- that's harmless since a completed session is never resumed, but this
-- column can hold stale data for force-closed attempts. Students already have
-- `FOR UPDATE USING (user_id = auth.uid())` on quiz_sessions, so no new policy
-- is required to write it.
ALTER TABLE public.quiz_sessions
  ADD COLUMN IF NOT EXISTS draft_answers jsonb;

COMMENT ON COLUMN public.quiz_sessions.draft_answers IS
  'Unsubmitted deferred-mode quiz drafts (#827): { v, mcq: {questionId: number[]}, nonMcq: {questionId: NonMcqAnswer} }. Selections only, no grading. Cleared to NULL on finalize (not on force-close).';
