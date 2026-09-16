-- Validate the question_reference constraint added in the previous migration.
-- VALIDATE CONSTRAINT acquires only a SHARE UPDATE EXCLUSIVE lock, which
-- allows concurrent reads and writes while the full-table scan runs.
ALTER TABLE public.test_questions VALIDATE CONSTRAINT question_reference;
