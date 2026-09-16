-- Migration: Add class_announcements table
-- Issue #311: Class announcements/bulletin board scoped to an offering.
-- Instructors can create/edit/delete announcements; enrolled students can read them.

-- ============================================================
-- Table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.class_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) <= 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_announcements_offering_created
  ON public.class_announcements (offering_id, created_at DESC);

-- ============================================================
-- updated_at trigger
-- ============================================================
CREATE TRIGGER update_class_announcements_updated_at
  BEFORE UPDATE ON public.class_announcements
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.class_announcements ENABLE ROW LEVEL SECURITY;

-- Managers (instructors/admins/superadmins) can CRUD announcements for their offerings
CREATE POLICY "Managers can manage class announcements"
  ON public.class_announcements
  FOR ALL
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

-- Students (and any user with offering access) can read announcements
CREATE POLICY "Offering members can read class announcements"
  ON public.class_announcements
  FOR SELECT
  USING (public.has_offering_access(offering_id));
