-- Create offering_tests table to assign tests to class offerings
CREATE TABLE IF NOT EXISTS public.offering_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  test_id uuid NOT NULL REFERENCES public.tests(id) ON DELETE CASCADE,
  due_date timestamptz NULL,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offering_id, test_id)
);

-- Enable Row Level Security
ALTER TABLE public.offering_tests ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'offering_tests'
      AND policyname = 'Managers can manage offering tests'
  ) THEN
    CREATE POLICY "Managers can manage offering tests"
    ON public.offering_tests
    FOR ALL
    USING (can_manage_offering(offering_id))
    WITH CHECK (can_manage_offering(offering_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'offering_tests'
      AND policyname = 'Students see published tests'
  ) THEN
    CREATE POLICY "Students see published tests"
    ON public.offering_tests
    FOR SELECT
    USING (has_offering_access(offering_id) AND published_at IS NOT NULL);
  END IF;
END $$;

-- Updated-at trigger helper (safe to CREATE OR REPLACE)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS update_offering_tests_updated_at ON public.offering_tests;
CREATE TRIGGER update_offering_tests_updated_at
BEFORE UPDATE ON public.offering_tests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes
CREATE INDEX IF NOT EXISTS offering_tests_offering_id_idx ON public.offering_tests(offering_id);
CREATE INDEX IF NOT EXISTS offering_tests_test_id_idx ON public.offering_tests(test_id);