-- Enforces the invariant behind the "Other" material type (#1019):
-- a chapterless material never has chapters.
--
-- "images" and "other" are never split, so the UI hides every chapter control
-- for them. A material that carries chapters into one of those types strands
-- them: the `material_chapters` rows and their uploaded split PDFs stay in
-- place, costing storage, reachable by nothing that could delete them.
--
-- The client checks this before writing, but a check followed by a separate
-- update is not atomic: one session can split a material while another
-- reclassifies it after observing zero chapters, and both commit. Only the
-- database can rule that interleaving out, so the invariant lives here and the
-- client check stays purely as a way to produce a friendlier message first.
--
-- Deliberately NOT a cleanup. A chapter owns its cheat sheet and flashcards and
-- is referenced by `question_chapters`, so deleting chapters as a side effect of
-- a type change would destroy generated content nobody agreed to lose. The write
-- is rejected instead.

-- Kept in one place so the two triggers below cannot drift apart.
CREATE OR REPLACE FUNCTION public.is_chapterless_material_type(_material_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT _material_type IN ('images', 'other');
$$;

COMMENT ON FUNCTION public.is_chapterless_material_type(text) IS
  'Material types that are never split into chapters. Mirrors CHAPTERLESS_MATERIAL_TYPES in src/components/MaterialUploadDialog.tsx.';

-- Direction 1: reclassifying a material that already has chapters.
CREATE OR REPLACE FUNCTION public.reject_chapterless_reclassification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chapter_count integer;
BEGIN
  -- Only an actual move INTO a chapterless type can strand anything. Editing
  -- other columns, or moving out of one, is always fine.
  IF NEW.material_type IS DISTINCT FROM OLD.material_type
     AND public.is_chapterless_material_type(NEW.material_type)
  THEN
    SELECT count(*) INTO chapter_count
    FROM public.material_chapters
    WHERE material_id = NEW.id;

    IF chapter_count > 0 THEN
      RAISE EXCEPTION
        '% materials are never split into chapters, and this one has %. Delete its chapters before changing the type.',
        NEW.material_type, chapter_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_chapterless_reclassification ON public.course_materials;
CREATE TRIGGER trg_reject_chapterless_reclassification
  BEFORE UPDATE ON public.course_materials
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_chapterless_reclassification();

-- Direction 2: adding a chapter to a material that is already chapterless.
-- Without this the same race just runs the other way — chapters inserted while
-- a concurrent transaction commits the type change.
CREATE OR REPLACE FUNCTION public.reject_chapter_on_chapterless_material()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parent_type text;
BEGIN
  -- FOR UPDATE is what makes the pair of triggers actually airtight, and is not
  -- an optimisation. Under READ COMMITTED, two transactions reading only the
  -- sibling table both see the old committed state and both pass: one commits
  -- the type change while the other commits a chapter, and the invariant is
  -- broken by an interleaving neither transaction could observe.
  --
  -- Locking the parent row here serialises both directions through it, because
  -- the reclassifying UPDATE takes a row lock on that same row:
  --   * reclassify first  -> this INSERT blocks, then re-reads the committed
  --                          'other' and rejects;
  --   * insert first      -> the UPDATE blocks, then its own trigger counts the
  --                          committed chapter and rejects.
  SELECT material_type INTO parent_type
  FROM public.course_materials
  WHERE id = NEW.material_id
  FOR UPDATE;

  IF parent_type IS NOT NULL AND public.is_chapterless_material_type(parent_type) THEN
    RAISE EXCEPTION
      '% materials are never split into chapters.', parent_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_chapter_on_chapterless_material ON public.material_chapters;
CREATE TRIGGER trg_reject_chapter_on_chapterless_material
  BEFORE INSERT OR UPDATE OF material_id ON public.material_chapters
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_chapter_on_chapterless_material();
