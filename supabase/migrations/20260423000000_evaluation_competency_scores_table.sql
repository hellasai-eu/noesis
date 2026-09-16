-- Replace the student_evaluations.competency_scores JSONB column with a
-- dedicated relational table keyed by competency_id so analytics don't have to
-- match competencies by title.

CREATE TABLE public.evaluation_competency_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id UUID NOT NULL REFERENCES public.student_evaluations(id) ON DELETE CASCADE,
  competency_id UUID NOT NULL REFERENCES public.course_competencies(id) ON DELETE RESTRICT,
  score NUMERIC CHECK (score >= 0 AND score <= 100),
  rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, competency_id)
);

CREATE INDEX idx_evaluation_competency_scores_evaluation_id
  ON public.evaluation_competency_scores (evaluation_id);
CREATE INDEX idx_evaluation_competency_scores_competency_id
  ON public.evaluation_competency_scores (competency_id);

ALTER TABLE public.evaluation_competency_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and instructors can manage evaluation competency scores"
ON public.evaluation_competency_scores
FOR ALL
USING (
  is_super_admin(auth.uid()) OR
  EXISTS (
    SELECT 1
    FROM public.student_evaluations se
    JOIN public.courses c ON c.id = se.course_id
    JOIN public.user_institutions ui ON ui.institution_id = c.institution_id
    WHERE se.id = evaluation_competency_scores.evaluation_id
      AND ui.user_id = auth.uid()
      AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

CREATE POLICY "Students can view their own evaluation competency scores"
ON public.evaluation_competency_scores
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.student_evaluations se
    WHERE se.id = evaluation_competency_scores.evaluation_id
      AND se.user_id = auth.uid()
  )
);

-- Best-effort backfill from the JSONB column. Titles that don't match an
-- existing course_competencies.title (case/whitespace-insensitive) are dropped.
-- Out-of-range numeric scores are coerced to NULL to respect the CHECK.
INSERT INTO public.evaluation_competency_scores (evaluation_id, competency_id, score, rationale)
SELECT DISTINCT ON (se.id, cc.id)
  se.id,
  cc.id,
  CASE
    WHEN jsonb_typeof(elem->'score') = 'number'
      AND (elem->>'score')::numeric BETWEEN 0 AND 100
      THEN (elem->>'score')::numeric
    ELSE NULL
  END,
  elem->>'rationale'
FROM public.student_evaluations se
CROSS JOIN LATERAL jsonb_array_elements(se.competency_scores) AS elem
JOIN public.course_competencies cc
  ON cc.course_id = se.course_id
 AND lower(btrim(cc.title)) = lower(btrim(elem->>'competencyTitle'))
WHERE se.competency_scores IS NOT NULL
  AND jsonb_typeof(se.competency_scores) = 'array'
ORDER BY se.id, cc.id, elem->>'rationale' NULLS LAST
ON CONFLICT (evaluation_id, competency_id) DO NOTHING;

ALTER TABLE public.student_evaluations DROP COLUMN IF EXISTS competency_scores;
