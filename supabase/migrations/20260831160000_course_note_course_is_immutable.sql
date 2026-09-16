-- A note's course is fixed, like its author.
--
-- 20260831150000 made `author_id` immutable and left `course_id` writable. A
-- manager of two courses can therefore move a note between them — the UPDATE
-- policy checks `can_manage_course_notes` against the old row and the new one,
-- and both pass — and moving it breaks the note in two ways at once.
--
-- The integrity half is the one that bites first, with no adversary involved.
-- `can_read_course_note` requires the targeted offering to belong to the note's
-- own course (`o.course_id = n.course_id`), so every existing
-- `course_note_offerings` row still points at offerings of the OLD course and
-- matches nothing. The note silently disappears for every student it was
-- distributed to, while the instructor's list keeps rendering the section
-- badges from those same rows — the UI says "Section A, Section B" about a note
-- nobody can open.
--
-- The disclosure half is narrower but real. The per-user GDPR export reaches a
-- note's institution through its course, so moving a colleague-authored note
-- across an institution boundary re-files that author's attributed row under a
-- tenant they may have no relationship with. Less severe than the forged
-- authorship 20260831140000 closed — the subject receives their own note's
-- metadata, not someone else's — but it is the same column, mis-stated.
--
-- Neither is a supported operation: nothing in the app writes `course_id` on
-- update. Making that explicit costs one branch in a trigger that already
-- exists, and is the same rule 20260822140000 applies to student work, for the
-- same stated reason — a move is a transfer of visibility.
--
-- A new migration rather than an edit to 20260831150000: that file is already
-- applied on this PR's preview branch, and a branch applies migrations
-- incrementally.

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

  -- No cascade escape here: course_id is ON DELETE CASCADE, so a deleted
  -- course takes the note with it rather than rewriting the column.
  IF NEW.course_id IS DISTINCT FROM OLD.course_id THEN
    RAISE EXCEPTION
      'a course note belongs to the course it was uploaded to: % cannot become %',
      OLD.course_id, NEW.course_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.course_note_author_is_immutable() IS
  'Refuses any UPDATE that changes course_notes.author_id or course_id. '
  'author_id is what the per-user GDPR export selects on and course_id is how '
  'that export resolves the institution, so both are security-relevant; '
  'course_id additionally orphans every course_note_offerings row, silently '
  'hiding the note from every student it was distributed to. RLS WITH CHECK '
  'cannot express "unchanged" — it sees only the resulting row — hence a '
  'trigger. Same shape as student_work_attribution_is_immutable() (#1097).';

-- The trigger has to fire when EITHER column is in the UPDATE's target list,
-- so the column list widens with the function.
DROP TRIGGER IF EXISTS trg_course_notes_author_immutable ON public.course_notes;
CREATE TRIGGER trg_course_notes_author_immutable
  BEFORE UPDATE OF author_id, course_id ON public.course_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.course_note_author_is_immutable();
