-- Study guides are always publishable; drop the vestigial `status` column.
--
-- `status` was introduced by #977 as a draft → ready gate and, after #1004,
-- was toggled only by a Publish button in the manager. It never affected what
-- a student could see: both visibility helpers —
-- `study_guide_published_to_user` and `study_guide_assigned_in_offering` —
-- key solely off `offering_study_guides.published_at`. Assignment to a section
-- is the real gate, and it always was.
--
-- So the column had exactly one effect: an instructor who had built a guide
-- but not pressed Publish could not assign it, for no reason a student would
-- ever observe. The remaining writers were the Publish toggle and the insert
-- in CreateStudyGuideDialog; both go away with this change.
--
-- Dropped rather than left in place. A column nothing reads is a trap: the
-- next `WHERE status = 'ready'` silently reinstates an invisible gate, and the
-- CHECK still permitted 'generating'/'failed' — values the job-based flow
-- stopped writing when 20260728140000 removed the job status sync, and which
-- the manager already had to special-case as legacy.
--
-- No data is lost that means anything: the column carried instructor
-- bookkeeping, not student-visible state or submission history.

ALTER TABLE public.study_guides
  DROP CONSTRAINT IF EXISTS study_guides_status_check;

ALTER TABLE public.study_guides
  DROP COLUMN IF EXISTS status;
