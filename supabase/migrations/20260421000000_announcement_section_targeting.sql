-- Migration: Re-shape class_announcements for multi-section targeting
-- Issue #318: Announcements move under Classwork and can be targeted at one or
-- more sections (offerings). Targeting is stored in a junction table; an empty
-- junction set means "visible to every offering of the course".

-- ============================================================
-- 1. Add course_id to class_announcements and backfill from offering_id.
-- ============================================================
ALTER TABLE public.class_announcements
  ADD COLUMN IF NOT EXISTS course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE;

UPDATE public.class_announcements AS a
SET course_id = o.course_id
FROM public.offerings AS o
WHERE a.offering_id = o.id
  AND a.course_id IS NULL;

-- Any announcement whose offering no longer exists has no course we can attach
-- to; drop it rather than leave an orphan row.
DO $$
DECLARE orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.class_announcements WHERE course_id IS NULL;
  IF orphan_count > 0 THEN
    RAISE NOTICE 'Migration: deleting % announcement row(s) whose offering no longer exists.', orphan_count;
  END IF;
END;
$$;
DELETE FROM public.class_announcements WHERE course_id IS NULL;

ALTER TABLE public.class_announcements
  ALTER COLUMN course_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_announcements_course_created
  ON public.class_announcements (course_id, created_at DESC);

-- ============================================================
-- 2. Junction table mapping announcements -> targeted offerings.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.announcement_offerings (
  announcement_id uuid NOT NULL REFERENCES public.class_announcements(id) ON DELETE CASCADE,
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, offering_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_offerings_offering
  ON public.announcement_offerings (offering_id);

INSERT INTO public.announcement_offerings (announcement_id, offering_id)
SELECT id, offering_id
FROM public.class_announcements
WHERE offering_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ============================================================
-- 3. Drop existing policies that reference offering_id before we can drop
--    the column. Both class_announcements and announcement_reads policies
--    reference class_announcements.offering_id.
-- ============================================================
DROP POLICY IF EXISTS "Managers can manage class announcements" ON public.class_announcements;
DROP POLICY IF EXISTS "Offering members can read class announcements" ON public.class_announcements;
DROP POLICY IF EXISTS "Users see their own announcement reads" ON public.announcement_reads;
DROP POLICY IF EXISTS "Users record their own announcement reads" ON public.announcement_reads;
DROP POLICY IF EXISTS "Users delete their own announcement reads" ON public.announcement_reads;

-- ============================================================
-- 4. Drop the legacy single-offering column.
-- ============================================================
DROP INDEX IF EXISTS idx_class_announcements_offering_created;
ALTER TABLE public.class_announcements
  DROP COLUMN IF EXISTS offering_id;

-- ============================================================
-- 5. RLS on announcement_offerings.
-- ============================================================
ALTER TABLE public.announcement_offerings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Managers manage announcement offerings"
  ON public.announcement_offerings
  FOR ALL
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

CREATE POLICY "Offering members read announcement offerings"
  ON public.announcement_offerings
  FOR SELECT
  USING (public.has_offering_access(offering_id));

-- ============================================================
-- 6. New RLS on class_announcements.
-- ============================================================

-- Managers: any instructor/admin who can manage any offering of the course.
CREATE POLICY "Managers manage class announcements"
  ON public.class_announcements
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.offerings o
      WHERE o.course_id = class_announcements.course_id
        AND public.can_manage_offering(o.id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.offerings o
      WHERE o.course_id = class_announcements.course_id
        AND public.can_manage_offering(o.id)
    )
  );

-- Readers: a user with access to any offering of the course, AND either
--  (a) the announcement has no targeted offerings (visible to all), or
--  (b) the announcement targets an offering the user has access to.
CREATE POLICY "Course members read class announcements"
  ON public.class_announcements
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.offerings o
      WHERE o.course_id = class_announcements.course_id
        AND public.has_offering_access(o.id)
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.announcement_offerings ao
        WHERE ao.announcement_id = class_announcements.id
      )
      OR EXISTS (
        SELECT 1 FROM public.announcement_offerings ao2
        JOIN public.offerings o2 ON o2.id = ao2.offering_id
        WHERE ao2.announcement_id = class_announcements.id
          AND o2.course_id = class_announcements.course_id
          AND public.has_offering_access(o2.id)
      )
    )
  );

-- ============================================================
-- 7. New announcement_reads RLS policies using the course-level predicate.
-- ============================================================
CREATE POLICY "Users see their own announcement reads"
  ON public.announcement_reads
  FOR SELECT
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.class_announcements a
      WHERE a.id = announcement_reads.announcement_id
        AND EXISTS (
          SELECT 1 FROM public.offerings o
          WHERE o.course_id = a.course_id
            AND public.has_offering_access(o.id)
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.announcement_offerings ao
            WHERE ao.announcement_id = a.id
          )
          OR EXISTS (
            SELECT 1 FROM public.announcement_offerings ao2
            JOIN public.offerings o2 ON o2.id = ao2.offering_id
            WHERE ao2.announcement_id = a.id
              AND o2.course_id = a.course_id
              AND public.has_offering_access(o2.id)
          )
        )
    )
  );

CREATE POLICY "Users record their own announcement reads"
  ON public.announcement_reads
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.class_announcements a
      WHERE a.id = announcement_reads.announcement_id
        AND EXISTS (
          SELECT 1 FROM public.offerings o
          WHERE o.course_id = a.course_id
            AND public.has_offering_access(o.id)
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.announcement_offerings ao
            WHERE ao.announcement_id = a.id
          )
          OR EXISTS (
            SELECT 1 FROM public.announcement_offerings ao2
            JOIN public.offerings o2 ON o2.id = ao2.offering_id
            WHERE ao2.announcement_id = a.id
              AND o2.course_id = a.course_id
              AND public.has_offering_access(o2.id)
          )
        )
    )
  );

CREATE POLICY "Users delete their own announcement reads"
  ON public.announcement_reads
  FOR DELETE
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.class_announcements a
      WHERE a.id = announcement_reads.announcement_id
        AND EXISTS (
          SELECT 1 FROM public.offerings o
          WHERE o.course_id = a.course_id
            AND public.has_offering_access(o.id)
        )
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.announcement_offerings ao
            WHERE ao.announcement_id = a.id
          )
          OR EXISTS (
            SELECT 1 FROM public.announcement_offerings ao2
            JOIN public.offerings o2 ON o2.id = ao2.offering_id
            WHERE ao2.announcement_id = a.id
              AND o2.course_id = a.course_id
              AND public.has_offering_access(o2.id)
          )
        )
    )
  );
