-- Instructor study-guide analytics (#981, part of epic #976)
--
-- Two things live here:
--
--   1. `study_guide_analyses` — the cache for the AI class assessment produced
--      by the `analyze-study-guide` edge function. Modelled on `quiz_analyses`
--      (20260715000000) and upserted on (study_guide_id, offering_id) so the
--      instructor's explicit "Refresh" overwrites the stored report in place.
--
--   2. Realtime on the two student-written study-guide tables, so the results
--      view can update as students submit instead of polling.
--
-- The RAW statistics in the results view are computed client-side from
-- `study_guide_progress` / `study_guide_answers` and are always live. Only the
-- AI narrative is cached here: it costs a model call, so it is regenerated on
-- demand rather than on every new submission.

-- ============================================================================
-- 1. The cached AI assessment
-- ============================================================================

CREATE TABLE public.study_guide_analyses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  study_guide_id UUID NOT NULL REFERENCES public.study_guides(id) ON DELETE CASCADE,
  offering_id UUID NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  -- The scope the report was computed over: NULL = whole class, otherwise the
  -- sub-group. Part of the key rather than metadata, because the report is a
  -- reading of a specific cohort. Sharing one slot across scopes would let a
  -- group-scoped refresh overwrite the whole-class report, and the panel — which
  -- has no way to tell which cohort a stored row describes — would then present
  -- one group's weaknesses as the whole class's.
  group_id UUID,
  -- Structured report: overall narrative, ranked strengths and weaknesses tied
  -- to pieces + competencies, misconceptions with evidence, suggested actions,
  -- and the deterministically-computed low-confidence markers.
  report JSONB NOT NULL,
  model TEXT,
  -- How many students had submitted when this was computed. Rendered next to
  -- the report so a stale assessment is visibly stale.
  submission_count INTEGER NOT NULL DEFAULT 0,
  -- Whole-report caveat: the analysis rests on thin data overall. Per-piece and
  -- per-competency thinness is marked inside `report` instead.
  low_confidence BOOLEAN NOT NULL DEFAULT false,
  generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  -- Composite FK so a group can never be attached to the wrong offering,
  -- mirroring offering_study_guides (20260727120000).
  CONSTRAINT study_guide_analyses_group_id_offering_fkey
    FOREIGN KEY (group_id, offering_id)
    REFERENCES public.offering_groups(id, offering_id)
    ON DELETE CASCADE
);

-- One analysis per (assigned guide, scope). Doubles as the upsert target.
-- NULLS NOT DISTINCT so the whole-class scope gets exactly one slot rather than
-- a new row per refresh — same idiom as offering_study_guides.
CREATE UNIQUE INDEX idx_study_guide_analyses_unique
  ON public.study_guide_analyses(study_guide_id, offering_id, group_id)
  NULLS NOT DISTINCT;
CREATE INDEX idx_study_guide_analyses_offering
  ON public.study_guide_analyses(offering_id);
CREATE INDEX idx_study_guide_analyses_group
  ON public.study_guide_analyses(group_id);

ALTER TABLE public.study_guide_analyses ENABLE ROW LEVEL SECURITY;

-- Unlike `quiz_analyses` (readable by any offering member), this is
-- instructor-only on both sides: the report names which students are struggling
-- with what, and #981 scopes the whole results surface to offering managers.
-- `can_manage_offering` already folds in the `course_instructor_sections`
-- restriction, so an instructor limited to some sections cannot read another
-- section's assessment.
CREATE POLICY "Managers can read study guide analyses"
  ON public.study_guide_analyses
  FOR SELECT
  USING (public.can_manage_offering(offering_id));

-- The edge function writes as the service role and authorizes the caller
-- itself; this guards any direct client write.
CREATE POLICY "Managers can write study guide analyses"
  ON public.study_guide_analyses
  FOR ALL
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

CREATE TRIGGER update_study_guide_analyses_updated_at
  BEFORE UPDATE ON public.study_guide_analyses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 2. Realtime for the live results view
--
-- The instructor watches results arrive; students INSERT answers and UPDATE
-- progress. Realtime applies the table's RLS to each change, and the SELECT
-- policies on both tables are `can_manage_offering(offering_id)` — so an
-- instructor only ever receives events for offerings they manage.
--
-- Guarded rather than a bare ALTER: `supabase db reset` replays every
-- migration, and adding a table already in the publication is an error.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'study_guide_answers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.study_guide_answers;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'study_guide_progress'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.study_guide_progress;
  END IF;
END
$$;
