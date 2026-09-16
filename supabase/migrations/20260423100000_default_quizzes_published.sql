-- Default quizzes to always published, drop instructor publish workflow.
--
-- Quiz visibility for students is now gated solely by class assignment via
-- public.offering_quizzes. The is_published / published_at flags are kept for
-- backward compatibility with existing RLS policies and student-side filters
-- (e.g. .not('published_at', 'is', null)), but they should be true / non-null
-- on every row going forward.

-- Backfill any existing draft quizzes so they remain visible after the
-- publish toggle is removed from the instructor UI.
UPDATE public.quizzes
SET is_published = true
WHERE is_published = false;

-- Backfill any existing class assignments that were left unpublished. Without
-- this, students would lose visibility on assignments that are silently
-- "draft" once the per-class publish toggle is gone.
UPDATE public.offering_quizzes
SET published_at = now()
WHERE published_at IS NULL;

-- New quizzes should default to published so any insertion path that omits
-- the column (API routes, seed scripts, direct inserts) doesn't silently hide
-- the quiz from students under existing RLS policies.
ALTER TABLE public.quizzes
  ALTER COLUMN is_published SET DEFAULT true;

-- New offering_quizzes rows should default to published so the assign-to-class
-- dialog no longer needs a "Publish immediately" switch.
ALTER TABLE public.offering_quizzes
  ALTER COLUMN published_at SET DEFAULT now();
