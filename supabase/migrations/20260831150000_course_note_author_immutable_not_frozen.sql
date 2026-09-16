-- 20260831140000 stopped forged authorship by requiring `author_id` to be the
-- writer — and in doing so locked co-teachers out of each other's notes.
--
-- A WITH CHECK sees only the finished row, never the one it replaces, so
-- "author_id did not change" is not expressible there. What that policy could
-- express was "author_id equals me", which is the right rule for an INSERT and
-- the wrong one for an UPDATE: when a second manager of the same course edits a
-- colleague's note, the resulting row still carries the colleague's uuid, and
-- Postgres rejects the whole update. Retitling, re-targeting or replacing the
-- file of any note you did not personally upload was refused — on a table whose
-- entire purpose is shared course material.
--
-- The invariant that was actually wanted is the one 20260822140000 spells out
-- for student work: attribution is IMMUTABLE, not self-only. That needs a
-- comparison against OLD, so it lives in a trigger, and the policy goes back to
-- authorising by course.
--
--   * INSERT — `author_id` must be NULL or the writer. You may not create a
--     note in someone else's name.
--   * UPDATE — `author_id` may not change at all, by anyone. Nobody can hand a
--     note to a third party, and nobody can quietly claim a colleague's.
--
-- `FOR ALL` is replaced by explicit per-command policies because permissive
-- policies OR together: a `FOR ALL` WITH CHECK would keep admitting the very
-- inserts a separate INSERT policy was added to refuse.
--
-- The one legitimate way `author_id` becomes NULL is the FK's ON DELETE SET
-- NULL when the author's account is erased. That is allowed, and told apart by
-- the referenced row already being gone when the trigger fires — the same
-- escape 20260822140000 needs, for the same reason. Erasure relies on the FK
-- rather than an explicit UPDATE, so this is the only shape it takes.
--
-- A new migration rather than an edit to 20260831140000: that file is already
-- applied on this PR's preview branch, and a branch applies migrations
-- incrementally.

-- ============================================================
-- 1. Attribution is immutable
-- ============================================================
CREATE OR REPLACE FUNCTION public.course_note_author_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.author_id IS DISTINCT FROM OLD.author_id THEN
    -- The author's account was erased and the FK's ON DELETE SET NULL is
    -- writing that through. The referenced row is already gone by the time
    -- this fires, which is what separates the cascade from a caller clearing
    -- the column by hand. Without this branch, erasing a user who ever
    -- uploaded a note would be impossible.
    IF NEW.author_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.author_id) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'authorship of course_notes is immutable: % cannot become %',
      OLD.author_id, NEW.author_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.course_note_author_is_immutable() IS
  'Refuses any UPDATE that changes course_notes.author_id, except the FK''s '
  'ON DELETE SET NULL when the author is erased. The column is what the '
  'per-user GDPR export selects on, so a caller able to rewrite it could place '
  'a note in an unrelated user''s subject access request. RLS WITH CHECK '
  'cannot express "unchanged" — it sees only the resulting row — hence a '
  'trigger. Same shape as student_work_attribution_is_immutable() (#1097).';

-- `OF author_id` so the trigger costs nothing on the ordinary edit, which does
-- not name the column at all.
DROP TRIGGER IF EXISTS trg_course_notes_author_immutable ON public.course_notes;
CREATE TRIGGER trg_course_notes_author_immutable
  BEFORE UPDATE OF author_id ON public.course_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.course_note_author_is_immutable();

-- ============================================================
-- 2. Policies: per-command, so the INSERT rule cannot be OR'd away
-- ============================================================
DROP POLICY IF EXISTS "Managers manage course notes" ON public.course_notes;

CREATE POLICY "Managers read course notes"
  ON public.course_notes
  FOR SELECT
  USING (public.can_manage_course_notes(course_id));

CREATE POLICY "Managers create course notes"
  ON public.course_notes
  FOR INSERT
  WITH CHECK (
    public.can_manage_course_notes(course_id)
    AND (author_id IS NULL OR author_id = auth.uid())
  );

CREATE POLICY "Managers update course notes"
  ON public.course_notes
  FOR UPDATE
  USING (public.can_manage_course_notes(course_id))
  WITH CHECK (public.can_manage_course_notes(course_id));

CREATE POLICY "Managers delete course notes"
  ON public.course_notes
  FOR DELETE
  USING (public.can_manage_course_notes(course_id));
