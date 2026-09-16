-- Auto-enable horizontal competencies on newly-added grades whenever an
-- institution's school_levels array grows. Without this, adding a school
-- level (e.g. 'lykeio' to an institution that previously only offered
-- 'gymnasio') leaves every existing competency toggled off for the new
-- grades — the admin would have to visit the page and flip every switch
-- by hand. Default ON matches the seed behavior in
-- seed_default_horizontal_competencies().
--
-- Handles both INSERT (institution created with school_levels pre-populated)
-- and UPDATE (school_levels array grows).

CREATE OR REPLACE FUNCTION public.tg_auto_enable_horizontal_grades_on_school_levels()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  added_levels TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    added_levels := COALESCE(NEW.school_levels, ARRAY[]::TEXT[]);
  ELSE
    added_levels := ARRAY(
      SELECT unnest(NEW.school_levels)
      EXCEPT
      SELECT unnest(COALESCE(OLD.school_levels, ARRAY[]::TEXT[]))
    );
  END IF;

  IF array_length(added_levels, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.horizontal_competency_grades (competency_id, grade_level)
  SELECT hc.id, g.grade_level
  FROM public.horizontal_competencies hc
  CROSS JOIN (
    VALUES
      ('dimotiko', 'dimotiko_1'), ('dimotiko', 'dimotiko_2'),
      ('dimotiko', 'dimotiko_3'), ('dimotiko', 'dimotiko_4'),
      ('dimotiko', 'dimotiko_5'), ('dimotiko', 'dimotiko_6'),
      ('gymnasio', 'gymnasio_1'), ('gymnasio', 'gymnasio_2'),
      ('gymnasio', 'gymnasio_3'),
      ('lykeio', 'lykeio_1'), ('lykeio', 'lykeio_2'),
      ('lykeio', 'lykeio_3')
  ) AS g(school_level, grade_level)
  WHERE hc.institution_id = NEW.id
    AND g.school_level = ANY(added_levels)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_enable_horizontal_grades_on_school_levels
  ON public.institutions;
CREATE TRIGGER auto_enable_horizontal_grades_on_school_levels
AFTER UPDATE OF school_levels ON public.institutions
FOR EACH ROW
WHEN (NEW.school_levels IS DISTINCT FROM OLD.school_levels)
EXECUTE FUNCTION public.tg_auto_enable_horizontal_grades_on_school_levels();

DROP TRIGGER IF EXISTS auto_enable_horizontal_grades_on_insert
  ON public.institutions;
CREATE TRIGGER auto_enable_horizontal_grades_on_insert
AFTER INSERT ON public.institutions
FOR EACH ROW
EXECUTE FUNCTION public.tg_auto_enable_horizontal_grades_on_school_levels();
