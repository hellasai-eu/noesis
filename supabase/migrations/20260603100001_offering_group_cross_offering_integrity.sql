-- Enforce that group_id on assignment tables references a group that belongs to
-- the same offering as the row itself.
--
-- Strategy: add UNIQUE (id, offering_id) to offering_groups, then replace each
-- single-column FK on group_id with a composite FK (group_id, offering_id) so
-- PostgreSQL rejects cross-offering assignments at the constraint level.

-- ============================================================================
-- 1. Composite unique key on offering_groups (id is already PK, so the pair
--    (id, offering_id) is trivially unique — but we need an explicit constraint
--    target for the composite FK references below).
-- ============================================================================

ALTER TABLE public.offering_groups
  ADD CONSTRAINT offering_groups_id_offering_id_key UNIQUE (id, offering_id);

-- ============================================================================
-- 2. For each assignment table: drop the implicit single-column FK on group_id,
--    then add a composite FK (group_id, offering_id) that enforces both the
--    group exists AND it belongs to this offering.
--    ON DELETE CASCADE is preserved: deleting an offering_group row still
--    cascades to remove all scoped assignments.
-- ============================================================================

ALTER TABLE public.offering_questions
  DROP CONSTRAINT IF EXISTS offering_questions_group_id_fkey,
  ADD CONSTRAINT offering_questions_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

ALTER TABLE public.offering_open_questions
  DROP CONSTRAINT IF EXISTS offering_open_questions_group_id_fkey,
  ADD CONSTRAINT offering_open_questions_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

ALTER TABLE public.offering_quizzes
  DROP CONSTRAINT IF EXISTS offering_quizzes_group_id_fkey,
  ADD CONSTRAINT offering_quizzes_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

ALTER TABLE public.offering_tests
  DROP CONSTRAINT IF EXISTS offering_tests_group_id_fkey,
  ADD CONSTRAINT offering_tests_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

ALTER TABLE public.offering_study_sessions
  DROP CONSTRAINT IF EXISTS offering_study_sessions_group_id_fkey,
  ADD CONSTRAINT offering_study_sessions_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

ALTER TABLE public.offering_chapter_flashcards
  DROP CONSTRAINT IF EXISTS offering_chapter_flashcards_group_id_fkey,
  ADD CONSTRAINT offering_chapter_flashcards_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;

ALTER TABLE public.offering_chapter_cheatsheets
  DROP CONSTRAINT IF EXISTS offering_chapter_cheatsheets_group_id_fkey,
  ADD CONSTRAINT offering_chapter_cheatsheets_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE;
