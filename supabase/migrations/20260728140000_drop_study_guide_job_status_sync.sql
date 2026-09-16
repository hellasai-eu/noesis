-- Retire the job-driven study guide status machinery (#1004).
--
-- Generation is now instructor-driven and synchronous: an outline call, then a
-- theory call per piece, then a questions call per piece, each its own request
-- that the instructor initiates and waits on. There is no
-- `study_guide_generation` job any more, so the trigger that derived
-- `study_guides.status` from a job's terminal state has nothing to fire on.
--
-- Dropping it rather than leaving it dormant is deliberate. A trigger nobody
-- expects, keyed on a job type nobody creates, would still rewrite a guide's
-- status the moment any row of that type appeared — from a replayed migration,
-- a manual insert, or a future feature reusing the name. Dead code that still
-- executes is worse than none.
--
-- `status` keeps its CHECK (draft | generating | ready | failed). Only `draft`
-- and `ready` are written now — `ready` set explicitly by the instructor when
-- they publish — but narrowing the constraint would break any row still
-- carrying an old value, and the two spare values cost nothing.

DROP TRIGGER IF EXISTS trg_sync_study_guide_status_from_job ON public.jobs;
DROP FUNCTION IF EXISTS public.sync_study_guide_status_from_job();

-- Guides stranded by the old flow. `generating` meant a job was in flight and
-- `failed` meant it died; with the job gone, nothing would ever move either
-- again and the instructor would be unable to publish. Both become `draft`,
-- which is exactly what they now are: authored content, not yet published.
UPDATE public.study_guides
   SET status = 'draft'
 WHERE status IN ('generating', 'failed');

-- The one-active-job-per-guide index guarded against two concurrent
-- regenerations of the same guide. With no job type to constrain it is inert,
-- and leaving an index on `params->>'studyGuideId'` implies a job that no
-- longer exists.
DROP INDEX IF EXISTS public.idx_jobs_one_active_study_guide_generation;
