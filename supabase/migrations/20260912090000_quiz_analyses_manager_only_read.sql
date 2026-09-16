-- Restrict quiz_analyses reads to offering managers (compliance finding F3).
--
-- The original SELECT policy (20260715000000) used has_offering_access, which
-- includes enrolled students — so any student could read the stored analysis
-- for their offering, including `clusters` rows that name real classmates
-- (member_user_ids) under judgment labels like "missed most of the quiz".
-- No student surface ever queried the table; the grant anticipated a student
-- insight panel that was never built, and the sibling `study_guide_analyses`
-- (20260729090000) was created manager-only for exactly this reason.
--
-- Align the two: reads require can_manage_offering, same as writes. Managers
-- were already covered by the FOR ALL write policy's USING clause; the
-- explicit SELECT policy mirrors study_guide_analyses for clarity.

DROP POLICY "Offering members can read quiz analyses" ON public.quiz_analyses;

CREATE POLICY "Managers can read quiz analyses"
  ON public.quiz_analyses
  FOR SELECT
  USING (public.can_manage_offering(offering_id));
