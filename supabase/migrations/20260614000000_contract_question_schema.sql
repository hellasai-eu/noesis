-- Contract the question schema onto the unified `public.questions` table.
--
-- Final migration of the schema-unification epic (parent #575, this PR #582).
-- Prior migrations (#576, #577) added the unified `type` / `payload` / `answer_key`
-- columns to `public.questions` and absorbed every legacy `public.open_questions`
-- row into it under the same UUID. Writers (#578) and readers (#579, #580, #581)
-- now dual-write / read from the unified shape exclusively.
--
-- This migration:
--   1. Backfills `offering_open_questions` rows into `offering_questions`
--      (the only places diverged after #577).
--   2. Re-points every foreign key on dependent tables from
--      `open_questions(id)` to `questions(id)`. The shared UUIDs make this safe.
--   3. Drops the polymorphic columns on `test_questions`
--      (`open_question_id`, `question_type`) and tightens `question_id` to
--      NOT NULL.
--   4. Drops the legacy MCQ-only columns on `questions`
--      (`options`, `correct_answer`). Unified `payload.options` /
--      `answer_key.correct_index` are the sole source of truth.
--   5. Drops the legacy `offering_open_questions` and `open_questions` tables.
--
-- This migration is non-reversible. Operators must take a final snapshot of
-- `open_questions` and `offering_open_questions` before running it.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Backfill offering_open_questions → offering_questions
-- ──────────────────────────────────────────────────────────────────────────
-- Both tables share the same shape (offering_id, question column, group_id,
-- published_at, created_at, updated_at). Absorbed UUIDs guarantee every
-- `open_question_id` already exists in `public.questions`, so the FK on
-- `offering_questions.question_id` is satisfied.
INSERT INTO public.offering_questions (
  offering_id,
  question_id,
  group_id,
  published_at,
  created_at,
  updated_at
)
SELECT
  offering_id,
  open_question_id,
  group_id,
  published_at,
  created_at,
  updated_at
FROM public.offering_open_questions
ON CONFLICT (offering_id, question_id, group_id) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Re-point dependent foreign keys from open_questions(id) → questions(id)
-- ──────────────────────────────────────────────────────────────────────────
-- Column names stay (`open_question_id` / `question_id` on votes) so callers
-- in src/ and supabase/functions/ continue to compile unchanged. Renaming the
-- columns is explicitly out of scope per the issue.

ALTER TABLE public.open_question_chats
  DROP CONSTRAINT IF EXISTS open_question_chats_open_question_id_fkey,
  ADD CONSTRAINT open_question_chats_open_question_id_fkey
    FOREIGN KEY (open_question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

ALTER TABLE public.open_question_competencies
  DROP CONSTRAINT IF EXISTS open_question_competencies_open_question_id_fkey,
  ADD CONSTRAINT open_question_competencies_open_question_id_fkey
    FOREIGN KEY (open_question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

ALTER TABLE public.open_question_chapters
  DROP CONSTRAINT IF EXISTS open_question_chapters_open_question_id_fkey,
  ADD CONSTRAINT open_question_chapters_open_question_id_fkey
    FOREIGN KEY (open_question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

ALTER TABLE public.open_question_grades
  DROP CONSTRAINT IF EXISTS open_question_grades_open_question_id_fkey,
  ADD CONSTRAINT open_question_grades_open_question_id_fkey
    FOREIGN KEY (open_question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

ALTER TABLE public.open_question_progress
  DROP CONSTRAINT IF EXISTS open_question_progress_open_question_id_fkey,
  ADD CONSTRAINT open_question_progress_open_question_id_fkey
    FOREIGN KEY (open_question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

-- open_question_votes uses `question_id` (not `open_question_id`) as its FK column.
ALTER TABLE public.open_question_votes
  DROP CONSTRAINT IF EXISTS open_question_votes_question_id_fkey,
  ADD CONSTRAINT open_question_votes_question_id_fkey
    FOREIGN KEY (question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

ALTER TABLE public.socratic_session_state
  DROP CONSTRAINT IF EXISTS socratic_session_state_open_question_id_fkey,
  ADD CONSTRAINT socratic_session_state_open_question_id_fkey
    FOREIGN KEY (open_question_id) REFERENCES public.questions(id) ON DELETE CASCADE;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Drop polymorphic columns on test_questions
-- ──────────────────────────────────────────────────────────────────────────
-- The absorb migration (20260613000002) backfilled `question_id` for every
-- `question_type='open'` row, so NOT NULL is safe.
ALTER TABLE public.test_questions
  DROP CONSTRAINT IF EXISTS question_reference,
  DROP CONSTRAINT IF EXISTS valid_question_type;

ALTER TABLE public.test_questions
  DROP COLUMN IF EXISTS open_question_id,
  DROP COLUMN IF EXISTS question_type;

ALTER TABLE public.test_questions
  ALTER COLUMN question_id SET NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Drop legacy MCQ-only columns on questions
-- ──────────────────────────────────────────────────────────────────────────
-- The unified shape (#576) carries `payload.options` and
-- `answer_key.correct_index`; readers (#580, #581) and writers (#578) already
-- prefer them. Backfilled open rows have placeholder values ([], 0) here that
-- this drop removes.
ALTER TABLE public.questions
  DROP COLUMN IF EXISTS options,
  DROP COLUMN IF EXISTS correct_answer;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Re-point RLS policies that referenced open_questions in their USING
--    clauses (see migrations 20251214120606 and 20260425000000).
-- ──────────────────────────────────────────────────────────────────────────
-- Step 2 covered foreign keys; policy bodies are not constraints, so they
-- need to be dropped and recreated against the unified `public.questions`
-- table. The new policies are byte-for-byte the legacy ones with
-- `public.open_questions oq` swapped for `public.questions q` — `questions`
-- already has the same `id` / `course_id` shape post-absorb.

DROP POLICY IF EXISTS "Users can view open question competencies for accessible courses"
  ON public.open_question_competencies;
DROP POLICY IF EXISTS "Admins and instructors can manage open question competencies"
  ON public.open_question_competencies;

CREATE POLICY "Users can view open question competencies for accessible courses"
ON public.open_question_competencies
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = open_question_competencies.open_question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage open question competencies"
ON public.open_question_competencies
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = open_question_competencies.open_question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

DROP POLICY IF EXISTS "Users can view open question chapters for accessible courses"
  ON public.open_question_chapters;
DROP POLICY IF EXISTS "Admins and instructors can manage open question chapters"
  ON public.open_question_chapters;

CREATE POLICY "Users can view open question chapters for accessible courses"
ON public.open_question_chapters
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = open_question_chapters.open_question_id
    AND ui.user_id = auth.uid()
  )
  OR is_super_admin(auth.uid())
);

CREATE POLICY "Admins and instructors can manage open question chapters"
ON public.open_question_chapters
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.questions q
    JOIN public.courses c ON q.course_id = c.id
    JOIN public.user_institutions ui ON c.institution_id = ui.institution_id
    WHERE q.id = open_question_chapters.open_question_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
  OR is_super_admin(auth.uid())
);

-- ──────────────────────────────────────────────────────────────────────────
-- 6. Drop legacy tables
-- ──────────────────────────────────────────────────────────────────────────
-- Step 1 backfilled offering_open_questions, step 2 re-pointed every FK on
-- the open_question_* dependent tables, step 5 re-pointed the four RLS
-- policies that joined against open_questions. Neither legacy table has any
-- remaining inbound dependency, so plain DROP suffices.
DROP TABLE IF EXISTS public.offering_open_questions;
DROP TABLE IF EXISTS public.open_questions;
