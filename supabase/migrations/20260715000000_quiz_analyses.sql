-- Stores the AI-generated diagnosis for a closed quiz assignment (offering_quiz).
-- One analysis per (quiz_id, offering_id); the analyze-quiz edge function upserts
-- this row so "Regenerate" overwrites the stored report + clusters in place.
CREATE TABLE public.quiz_analyses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quiz_id UUID NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  -- Structured report: overall understanding, ranked misconceptions, knowledge
  -- gaps, per-question difficulty signals, and a short summary.
  report JSONB NOT NULL,
  -- Misconception-based student clusters: [{ label, rationale, summary, member_user_ids }].
  clusters JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT,
  submission_count INTEGER NOT NULL DEFAULT 0,
  -- Set when the analysis is based on thin data (few submissions) so the UI can
  -- surface a caveat.
  low_confidence BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- One analysis per assigned quiz (offering_quiz). Doubles as the upsert target.
CREATE UNIQUE INDEX idx_quiz_analyses_unique ON public.quiz_analyses(quiz_id, offering_id);
CREATE INDEX idx_quiz_analyses_offering ON public.quiz_analyses(offering_id);

ALTER TABLE public.quiz_analyses ENABLE ROW LEVEL SECURITY;

-- Reads: anyone with access to the offering (instructors, admins, and — for the
-- sibling insight-panel feature — potentially other offering members).
CREATE POLICY "Offering members can read quiz analyses"
ON public.quiz_analyses
FOR SELECT
USING (has_offering_access(offering_id));

-- Writes: only those who can manage the offering (instructor of the section,
-- institution admin, or super-admin). The edge function uses the service role
-- and authorizes the caller separately, but these guard any direct client write.
CREATE POLICY "Managers can write quiz analyses"
ON public.quiz_analyses
FOR ALL
USING (can_manage_offering(offering_id))
WITH CHECK (can_manage_offering(offering_id));

CREATE TRIGGER update_quiz_analyses_updated_at
BEFORE UPDATE ON public.quiz_analyses
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();
