-- Migration: Add announcement_reads table
-- Issue #311: Per-user read receipts for class_announcements. A student has an
-- unread announcement if they have no matching row here. Kept separate from
-- class_announcements so the core table matches the issue spec exactly.

-- ============================================================
-- Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.announcement_reads (
  announcement_id uuid NOT NULL REFERENCES public.class_announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_reads_user
  ON public.announcement_reads (user_id);

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

-- Users can see only their own read receipts, and only for announcements they can access.
CREATE POLICY "Users see their own announcement reads"
  ON public.announcement_reads
  FOR SELECT
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.class_announcements a
      WHERE a.id = announcement_reads.announcement_id
      AND public.has_offering_access(a.offering_id)
    )
  );

-- Users can insert a read receipt for themselves only, and only for announcements they can access.
CREATE POLICY "Users record their own announcement reads"
  ON public.announcement_reads
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.class_announcements a
      WHERE a.id = announcement_reads.announcement_id
      AND public.has_offering_access(a.offering_id)
    )
  );

-- Users can delete their own read receipts (e.g. to mark unread)
CREATE POLICY "Users delete their own announcement reads"
  ON public.announcement_reads
  FOR DELETE
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1
      FROM public.class_announcements a
      WHERE a.id = announcement_reads.announcement_id
      AND public.has_offering_access(a.offering_id)
    )
  );
