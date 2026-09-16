-- Give image moderation a column of its own.
--
-- The outcome of moderating an image had nowhere to live, so `handleModerateImage`
-- wrote the sentinels 'moderated' / 'rejected' into `openai_file_id` — a column
-- every other reader treats as a real OpenAI file id. Two consequences:
--
--   * Deleting a moderated image sent `file_id=moderated` to OpenAI, which 400s
--     ("Expected an ID that begins with 'file'"). `delete-from-openai` refuses to
--     continue past a failed vector-store detach, so it returned 502 and the
--     material was never deleted — the image could not be removed at all.
--   * `is_moderated` is true for an approved AND a rejected image alike, so the
--     only record of which was which was the sentinel. Readers that asked
--     `is_moderated = true` for "approved" — StudySessionManager — served
--     rejected images to students.
--
-- `moderation_status` now carries the outcome. `is_moderated` keeps its literal
-- meaning, "moderation has run" (i.e. status <> 'pending'), so the code that
-- writes it on insert stays correct.

ALTER TABLE public.course_materials
ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE public.course_materials
DROP CONSTRAINT IF EXISTS course_materials_moderation_status_check;

ALTER TABLE public.course_materials
ADD CONSTRAINT course_materials_moderation_status_check
CHECK (moderation_status IN ('pending', 'approved', 'rejected'));

-- Backfill the outcome from the sentinels, then clear them: `openai_file_id`
-- must only ever hold an id OpenAI would recognise. Clearing it is what makes
-- the stuck images deletable again — the delete path skips OpenAI entirely for
-- a material that has no file id.
UPDATE public.course_materials
SET moderation_status = CASE openai_file_id
      WHEN 'moderated' THEN 'approved'
      ELSE 'rejected'
    END,
    openai_file_id = NULL
WHERE openai_file_id IN ('moderated', 'rejected');

COMMENT ON COLUMN public.course_materials.moderation_status IS
  'Image moderation outcome: pending | approved | rejected. Only images are moderated; everything else stays pending.';
