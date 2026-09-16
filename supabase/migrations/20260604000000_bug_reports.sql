-- Bug reports inbox (issue #523).
--
-- Adds:
--   * bug_reports: text reports + screenshot attachments filed by logged-in
--     users (instructor / admin / super-admin) from the dashboard nav.
--   * RLS so reporters can only insert their own row; super-admins can read,
--     update, and delete any report.
--   * 'bug-reports' storage bucket with policies that mirror the table:
--     authenticated users can upload only under their own user-id prefix;
--     only super-admins can read or delete uploaded screenshots.

-- ============================================================================
-- 1. bug_reports table
-- ============================================================================

CREATE TABLE public.bug_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reporter_email text,
  reporter_role text,
  institution_id uuid REFERENCES public.institutions(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
  page_url text,
  user_agent text,
  viewport text,
  os text,
  screenshot_paths text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'resolved', 'wont_fix')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bug_reports_status_created
  ON public.bug_reports (status, created_at DESC);
CREATE INDEX idx_bug_reports_reporter
  ON public.bug_reports (reporter_id);

CREATE TRIGGER update_bug_reports_updated_at
  BEFORE UPDATE ON public.bug_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;

-- INSERT: instructors, admins, and super-admins only (not students).
CREATE POLICY "Authenticated users can submit their own bug reports"
  ON public.bug_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    reporter_id = auth.uid()
    AND (
      public.is_super_admin(auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.user_institutions
        WHERE user_id = auth.uid() AND role IN ('instructor', 'admin')
      )
    )
  );

-- SELECT / UPDATE / DELETE: super-admins only.
CREATE POLICY "Super admins can read bug reports"
  ON public.bug_reports
  FOR SELECT
  USING (public.is_super_admin(auth.uid()));

CREATE POLICY "Super admins can update bug reports"
  ON public.bug_reports
  FOR UPDATE
  USING (public.is_super_admin(auth.uid()))
  WITH CHECK (public.is_super_admin(auth.uid()));

CREATE POLICY "Super admins can delete bug reports"
  ON public.bug_reports
  FOR DELETE
  USING (public.is_super_admin(auth.uid()));

-- ============================================================================
-- 2. 'bug-reports' storage bucket + policies
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('bug-reports', 'bug-reports', false)
ON CONFLICT (id) DO NOTHING;

-- Upload: instructors, admins, and super-admins only, under their own uid prefix
-- (e.g. "<uid>/<random>-<file>.png"). storage.foldername returns path segments as text[].
CREATE POLICY "Authenticated users can upload their own bug screenshots"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'bug-reports'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND (
      public.is_super_admin(auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.user_institutions
        WHERE user_id = auth.uid() AND role IN ('instructor', 'admin')
      )
    )
  );

CREATE POLICY "Super admins can read bug screenshots"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'bug-reports'
    AND public.is_super_admin(auth.uid())
  );

CREATE POLICY "Super admins can delete bug screenshots"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'bug-reports'
    AND public.is_super_admin(auth.uid())
  );
