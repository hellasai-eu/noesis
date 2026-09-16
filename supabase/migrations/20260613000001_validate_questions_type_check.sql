-- Validate the questions_type_check constraint added in the previous migration.
-- VALIDATE CONSTRAINT acquires only a SHARE UPDATE EXCLUSIVE lock, which
-- allows concurrent reads and writes while the full-table scan runs.
ALTER TABLE public.questions VALIDATE CONSTRAINT questions_type_check;
