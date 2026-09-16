-- Horizontal (cross-grade) competencies: transferable skills tracked across
-- all courses a student takes. Distinct from course_competencies, which are
-- subject-specific. Scores persist across grade rollovers and course lifecycles.

CREATE TABLE public.horizontal_competencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  order_num INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX horizontal_competencies_institution_title_unique
  ON public.horizontal_competencies (institution_id, lower(btrim(title)));

CREATE INDEX idx_horizontal_competencies_institution_id
  ON public.horizontal_competencies (institution_id);

CREATE TABLE public.horizontal_competency_grades (
  competency_id UUID NOT NULL REFERENCES public.horizontal_competencies(id) ON DELETE CASCADE,
  grade_level TEXT NOT NULL CHECK (grade_level IN (
    'dimotiko_1','dimotiko_2','dimotiko_3','dimotiko_4','dimotiko_5','dimotiko_6',
    'gymnasio_1','gymnasio_2','gymnasio_3',
    'lykeio_1','lykeio_2','lykeio_3'
  )),
  PRIMARY KEY (competency_id, grade_level)
);

CREATE INDEX idx_horizontal_competency_grades_grade_level
  ON public.horizontal_competency_grades (grade_level);

CREATE TABLE public.student_horizontal_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  competency_id UUID NOT NULL REFERENCES public.horizontal_competencies(id) ON DELETE RESTRICT,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE RESTRICT,
  evaluation_id UUID REFERENCES public.student_evaluations(id) ON DELETE SET NULL,
  score NUMERIC CHECK (score >= 0 AND score <= 4),
  confidence NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
  evidence TEXT,
  notes TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_student_horizontal_scores_student_competency
  ON public.student_horizontal_scores (student_id, competency_id, evaluated_at DESC);
CREATE INDEX idx_student_horizontal_scores_competency
  ON public.student_horizontal_scores (competency_id);
CREATE INDEX idx_student_horizontal_scores_course
  ON public.student_horizontal_scores (course_id);
CREATE INDEX idx_student_horizontal_scores_evaluation
  ON public.student_horizontal_scores (evaluation_id);

ALTER TABLE public.horizontal_competencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.horizontal_competency_grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_horizontal_scores ENABLE ROW LEVEL SECURITY;

-- horizontal_competencies: admins/super-admins manage; everyone in the
-- institution (instructors/students) can read so UIs can render titles.
CREATE POLICY "Admins manage horizontal competencies"
ON public.horizontal_competencies
FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM public.user_institutions ui
    WHERE ui.user_id = auth.uid()
      AND ui.institution_id = horizontal_competencies.institution_id
      AND ui.role = 'admin'
  )
);

CREATE POLICY "Institution members view horizontal competencies"
ON public.horizontal_competencies
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1 FROM public.user_institutions ui
    WHERE ui.user_id = auth.uid()
      AND ui.institution_id = horizontal_competencies.institution_id
  )
);

-- horizontal_competency_grades: mirrors parent permissions
CREATE POLICY "Admins manage horizontal competency grades"
ON public.horizontal_competency_grades
FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1
    FROM public.horizontal_competencies hc
    JOIN public.user_institutions ui ON ui.institution_id = hc.institution_id
    WHERE hc.id = horizontal_competency_grades.competency_id
      AND ui.user_id = auth.uid()
      AND ui.role = 'admin'
  )
);

CREATE POLICY "Institution members view horizontal competency grades"
ON public.horizontal_competency_grades
FOR SELECT
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1
    FROM public.horizontal_competencies hc
    JOIN public.user_institutions ui ON ui.institution_id = hc.institution_id
    WHERE hc.id = horizontal_competency_grades.competency_id
      AND ui.user_id = auth.uid()
  )
);

-- student_horizontal_scores: admins/instructors manage; students read own.
-- Write access is course-scoped (instructors can only write scores for their own course).
CREATE POLICY "Admins and instructors manage student horizontal scores"
ON public.student_horizontal_scores
FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1
    FROM public.courses c
    JOIN public.user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = student_horizontal_scores.course_id
      AND ui.user_id = auth.uid()
      AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Read access is institution-scoped: any instructor at the institution can see cross-grade scores.
-- This is intentionally broader than the write policy to support the cross-grade history view.
-- Super-admins and institution admins already have SELECT access via the FOR ALL policy above,
-- so this policy only needs to add the net-new institution-scoped instructor branch.
CREATE POLICY "Institution instructors view student horizontal scores"
ON public.student_horizontal_scores
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.course_instructors ci
    JOIN public.courses c ON c.id = ci.course_id
    WHERE ci.user_id = auth.uid()
      AND c.institution_id = (
        SELECT c2.institution_id FROM public.courses c2
        WHERE c2.id = student_horizontal_scores.course_id
      )
  )
);

CREATE POLICY "Students view their own horizontal scores"
ON public.student_horizontal_scores
FOR SELECT
USING (student_id = auth.uid());

-- Seed the 4 default competencies for every existing institution, then
-- enable them on every grade level (apply everywhere by default).

WITH defaults AS (
  SELECT * FROM (VALUES
    ('Problem Solving',
     'Ability to approach problems in a structured and effective way, breaking them into steps and progressing logically toward a solution',
     0),
    ('Reasoning',
     'Ability to draw correct conclusions from given information, applying logic consistently and avoiding invalid assumptions',
     1),
    ('Conceptual Understanding',
     'Depth of understanding of underlying ideas, shown by applying knowledge to new situations rather than relying on memorized patterns',
     2),
    ('Error Detection & Correction',
     'Ability to recognize mistakes, understand why they occurred, and improve or correct them effectively',
     3)
  ) AS t(title, description, order_num)
)
INSERT INTO public.horizontal_competencies (institution_id, title, description, is_default, order_num)
SELECT i.id, d.title, d.description, true, d.order_num
FROM public.institutions i
CROSS JOIN defaults d
ON CONFLICT (institution_id, lower(btrim(title))) DO NOTHING;

-- Enable the freshly-seeded defaults on every grade level.
INSERT INTO public.horizontal_competency_grades (competency_id, grade_level)
SELECT hc.id, g.grade_level
FROM public.horizontal_competencies hc
CROSS JOIN (
  VALUES
    ('dimotiko_1'),('dimotiko_2'),('dimotiko_3'),('dimotiko_4'),('dimotiko_5'),('dimotiko_6'),
    ('gymnasio_1'),('gymnasio_2'),('gymnasio_3'),
    ('lykeio_1'),('lykeio_2'),('lykeio_3')
) AS g(grade_level)
WHERE hc.is_default = true
ON CONFLICT DO NOTHING;
