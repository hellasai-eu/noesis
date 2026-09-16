-- Drive study_guides.status from the generation job's own finalization (#978).
--
-- All-or-nothing: a guide is usable only when EVERY piece succeeded. The job
-- handler cannot decide this itself — `processItem` has no view of whether its
-- siblings will succeed, and the last item's own completion is not yet visible
-- to it when it returns. The runner already computes exactly the right answer
-- when it finalizes the job (`tallyJobItems` -> completed / partially_completed
-- / failed), so the guide status is derived from that transition instead.
--
--   completed                          -> ready
--   partially_completed | failed
--     | cancelled                      -> failed
--
-- `partially_completed` maps to `failed` deliberately: a guide missing a piece
-- has a hole in its sequence, and students advance strictly piece by piece
-- (#980). Half a guide is not a usable guide.

CREATE OR REPLACE FUNCTION public.sync_study_guide_status_from_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  guide_id uuid;
BEGIN
  IF NEW.type IS DISTINCT FROM 'study_guide_generation' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  BEGIN
    guide_id := (NEW.params ->> 'studyGuideId')::uuid;
  EXCEPTION WHEN others THEN
    -- A malformed params blob must not break the runner's own bookkeeping.
    RETURN NEW;
  END;

  IF guide_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' THEN
    UPDATE public.study_guides
       SET status = 'ready'
     WHERE id = guide_id;
  ELSIF NEW.status IN ('failed', 'partially_completed', 'cancelled') THEN
    UPDATE public.study_guides
       SET status = 'failed'
     WHERE id = guide_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_study_guide_status_from_job
  AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_study_guide_status_from_job();
