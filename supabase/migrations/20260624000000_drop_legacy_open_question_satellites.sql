-- Drop the three legacy `open_question_*` junction/satellite tables. They
-- have been kept in lock-step with their canonical `question_*` twins by
-- the dual-write of #639 and the historical backfill of #641
-- (`20260623000000_backfill_question_junctions_from_open.sql`); after #642
-- the AI-Interactive surface reads `question_*` exclusively and after #643
-- no UI component touches the legacy names. This is the final, irreversible
-- step: drop the duplicate state so no future writer can desync the two
-- sources of truth.
--
-- The four open-only satellites (`open_question_chats`,
-- `open_question_grades`, `open_question_mode_changes`,
-- `open_question_progress`) are intentionally left intact — they have no
-- canonical twin and are still in use. Renaming them is out of scope.
--
-- Inbound FKs were re-pointed to `public.questions(id)` in the contract
-- migration (`20260614000000_contract_question_schema.sql`), so none of the
-- three tables has an inbound dependency at this point and a plain DROP
-- suffices.
--
-- This migration is irreversible. Operators should take a final snapshot of
-- `open_question_chapters`, `open_question_competencies`, and
-- `open_question_votes` before running it.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Drop RLS policies. DROP TABLE drops the policies automatically; the
--    explicit DROP POLICY block here makes the diff self-documenting and
--    lets a reviewer audit policy coverage without grepping prior migrations.
-- ──────────────────────────────────────────────────────────────────────────

-- open_question_chapters (created in 20260425000000_question_chapters_junction.sql,
-- recreated against `questions` in 20260614000000_contract_question_schema.sql)
DROP POLICY IF EXISTS "Users can view open question chapters for accessible courses"
  ON public.open_question_chapters;
DROP POLICY IF EXISTS "Admins and instructors can manage open question chapters"
  ON public.open_question_chapters;

-- open_question_competencies (created in 20251214120606, recreated in 20260614000000)
DROP POLICY IF EXISTS "Users can view open question competencies for accessible courses"
  ON public.open_question_competencies;
DROP POLICY IF EXISTS "Admins and instructors can manage open question competencies"
  ON public.open_question_competencies;

-- open_question_votes (created in 20251207072144)
DROP POLICY IF EXISTS "Users can view votes on open questions"
  ON public.open_question_votes;
DROP POLICY IF EXISTS "Users can insert their own votes"
  ON public.open_question_votes;
DROP POLICY IF EXISTS "Users can update their own votes"
  ON public.open_question_votes;
DROP POLICY IF EXISTS "Users can delete their own votes"
  ON public.open_question_votes;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Drop named indexes. As with policies, DROP TABLE would handle this,
--    but explicit drops keep the diff auditable.
-- ──────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS public.idx_open_question_chapters_open_question_id;
DROP INDEX IF EXISTS public.idx_open_question_chapters_chapter_id;
DROP INDEX IF EXISTS public.idx_open_question_competencies_open_question_id;
DROP INDEX IF EXISTS public.idx_open_question_competencies_competency_id;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Drop the tables.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.open_question_chapters;
DROP TABLE IF EXISTS public.open_question_competencies;
DROP TABLE IF EXISTS public.open_question_votes;
