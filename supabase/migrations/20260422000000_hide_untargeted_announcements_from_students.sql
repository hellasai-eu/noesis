-- Issue #328: Announcements with zero targeted offerings should be hidden from
-- students (treated as drafts), not broadcast to everyone.
--
-- The previous policies used "no targets = visible to all" (NOT EXISTS
-- announcement_offerings). That let an instructor unintentionally publish an
-- announcement to every student when they simply forgot to pick a section.
-- Require at least one matching announcement_offerings row for student SELECT.
-- Managers still see their own untargeted rows via the manage policy.

DROP POLICY IF EXISTS "Course members read class announcements" ON public.class_announcements;
DROP POLICY IF EXISTS "Users see their own announcement reads" ON public.announcement_reads;
DROP POLICY IF EXISTS "Users record their own announcement reads" ON public.announcement_reads;
DROP POLICY IF EXISTS "Users delete their own announcement reads" ON public.announcement_reads;

CREATE POLICY "Course members read class announcements"
  ON public.class_announcements
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.offerings o
      WHERE o.course_id = class_announcements.course_id
        AND public.has_offering_access(o.id)
    )
    AND EXISTS (
      SELECT 1 FROM public.announcement_offerings ao
      JOIN public.offerings o2 ON o2.id = ao.offering_id
      WHERE ao.announcement_id = class_announcements.id
        AND o2.course_id = class_announcements.course_id
        AND public.has_offering_access(o2.id)
    )
  );

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
          SELECT 1 FROM public.announcement_offerings ao
          JOIN public.offerings o ON o.id = ao.offering_id
          WHERE ao.announcement_id = a.id
            AND o.course_id = a.course_id
            AND public.has_offering_access(o.id)
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
          SELECT 1 FROM public.announcement_offerings ao
          JOIN public.offerings o ON o.id = ao.offering_id
          WHERE ao.announcement_id = a.id
            AND o.course_id = a.course_id
            AND public.has_offering_access(o.id)
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
          SELECT 1 FROM public.announcement_offerings ao
          JOIN public.offerings o ON o.id = ao.offering_id
          WHERE ao.announcement_id = a.id
            AND o.course_id = a.course_id
            AND public.has_offering_access(o.id)
        )
    )
  );
