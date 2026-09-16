-- Add institution type and school levels to institutions
ALTER TABLE public.institutions
  ADD COLUMN IF NOT EXISTS institution_type TEXT NOT NULL DEFAULT 'generic'
    CHECK (institution_type IN ('generic', 'greek_school')),
  ADD COLUMN IF NOT EXISTS school_levels TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.institutions
  ADD CONSTRAINT institutions_school_levels_check
    CHECK (school_levels <@ ARRAY['dimotiko','gymnasio','lykeio']::text[]);

-- Add grade_level to courses (nullable; only relevant for greek_school institutions)
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS grade_level TEXT;

ALTER TABLE public.courses
  ADD CONSTRAINT courses_grade_level_check
    CHECK (grade_level IS NULL OR grade_level IN (
      'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
      'gymnasio_1','gymnasio_2','gymnasio_3',
      'lykeio_1','lykeio_2','lykeio_3'
    ));

-- Add grade_level to classes (used to match classes when auto-attaching offerings)
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS grade_level TEXT;

ALTER TABLE public.classes
  ADD CONSTRAINT classes_grade_level_check
    CHECK (grade_level IS NULL OR grade_level IN (
      'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
      'gymnasio_1','gymnasio_2','gymnasio_3',
      'lykeio_1','lykeio_2','lykeio_3'
    ));

-- One class per grade level per institution
CREATE UNIQUE INDEX classes_institution_grade_level_unique
  ON public.classes (institution_id, grade_level)
  WHERE grade_level IS NOT NULL;
