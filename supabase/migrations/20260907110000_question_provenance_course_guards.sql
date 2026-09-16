-- Course-consistency guards for the provenance added in
-- 20260907090000_question_generation_provenance.sql (PR #1299 review).
--
-- Both links were authorized only through the QUESTION's course, so an
-- instructor managing two courses could file a question under another
-- course's material, or stamp it with another course's group — false
-- provenance the Book / "Generated for" filters would then trust.
--
-- Triggers rather than RLS or composite FKs:
--   * the edge functions write with the service role, which bypasses RLS
--     but not triggers;
--   * the group invariant spans a join (offering_groups → offerings →
--     course), which a foreign key cannot express.
-- SECURITY DEFINER so the existence checks see the referenced rows even
-- when the caller's RLS does not, mirroring is_offering_group_member().

CREATE OR REPLACE FUNCTION public.enforce_question_material_same_course()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.questions q
    JOIN public.course_materials m ON m.id = NEW.material_id
    WHERE q.id = NEW.question_id
      AND m.course_id = q.course_id
  ) THEN
    RAISE EXCEPTION 'question_materials: material % does not belong to the course of question %',
      NEW.material_id, NEW.question_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER question_materials_same_course
  BEFORE INSERT OR UPDATE ON public.question_materials
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_question_material_same_course();

CREATE OR REPLACE FUNCTION public.enforce_question_generated_for_group_same_course()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- NULL is always fine — including the FK's ON DELETE SET NULL update.
  IF NEW.generated_for_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.offering_groups g
    JOIN public.offerings o ON o.id = g.offering_id
    WHERE g.id = NEW.generated_for_group_id
      AND o.course_id = NEW.course_id
  ) THEN
    RAISE EXCEPTION 'questions: group % does not belong to course %',
      NEW.generated_for_group_id, NEW.course_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Fires on INSERT, and on UPDATE only when the provenance or the course
-- itself changes — every other questions UPDATE skips the check.
CREATE TRIGGER questions_generated_for_group_same_course
  BEFORE INSERT OR UPDATE OF generated_for_group_id, course_id ON public.questions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_question_generated_for_group_same_course();
