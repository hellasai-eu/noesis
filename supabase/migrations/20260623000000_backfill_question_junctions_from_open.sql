-- Backfill the canonical `question_chapters`, `question_competencies`, and
-- `question_votes` tables from their legacy `open_question_*` twins.
--
-- Context (issue #641, parent #640): the schema-unification arc merged
-- `open_questions` into `questions` (#577, #582) but left three junction /
-- satellite tables half-merged — their FK was repointed from
-- `open_questions(id)` to `questions(id)` (migration `20260614000000`) yet
-- they still live alongside the canonical `question_*` twins with no sync.
-- The unified bank reads `question_*`; the legacy AI-Interactive tab and the
-- pre-#639 non-MCQ writers wrote `open_question_*`. This backfill makes the
-- historical rows visible on the canonical side without touching code.
--
-- All three target tables already enjoy equivalent RLS via
-- `20251214120606` (competencies), `20260425000000` (chapters), and
-- `20251206101851` / `20251207072144` (votes) — no policy changes needed.
--
-- Idempotent: every INSERT uses `ON CONFLICT DO NOTHING` against the
-- natural composite key, so re-runs and rows already mirrored by PR #639's
-- dual-write are silently skipped.

-- 1. Chapters: PK on (question_id, chapter_id); copy preserves created_at.
INSERT INTO public.question_chapters (question_id, chapter_id, created_at)
SELECT open_question_id, chapter_id, created_at
FROM public.open_question_chapters
ON CONFLICT (question_id, chapter_id) DO NOTHING;

-- 2. Competencies: synthetic `id` PK plus UNIQUE (question_id, competency_id).
-- Let the target `id` default to gen_random_uuid(); conflict on the
-- natural key catches the dual-write / re-run cases.
INSERT INTO public.question_competencies (question_id, competency_id, created_at)
SELECT open_question_id, competency_id, created_at
FROM public.open_question_competencies
ON CONFLICT (question_id, competency_id) DO NOTHING;

-- 3. Votes: `open_question_votes.vote_type` is constrained to ('up','down');
-- `question_votes.vote_type` has no CHECK, so the copy is type-safe.
-- Let the target `id` default to gen_random_uuid() (same pattern as
-- competencies above) so the ON CONFLICT target fully covers all duplicates.
-- Conflict target is the natural UNIQUE (question_id, user_id) — if a user
-- already voted via the canonical UI, that vote wins.
INSERT INTO public.question_votes (created_at, question_id, user_id, vote_type)
SELECT created_at, question_id, user_id, vote_type
FROM public.open_question_votes
ON CONFLICT (question_id, user_id) DO NOTHING;
