-- Add is_manual and updated_at columns to evaluation_competency_scores so that
-- instructor edits can be distinguished from AI-generated scores and so that
-- we track when a score was last modified.

ALTER TABLE public.evaluation_competency_scores
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.evaluation_competency_scores
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS set_evaluation_competency_scores_updated_at
  ON public.evaluation_competency_scores;

CREATE TRIGGER set_evaluation_competency_scores_updated_at
BEFORE UPDATE ON public.evaluation_competency_scores
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
