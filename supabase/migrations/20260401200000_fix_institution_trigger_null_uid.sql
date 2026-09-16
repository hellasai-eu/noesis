-- Fix handle_new_institution trigger to handle NULL auth.uid()
-- This happens when institutions are created via service role (e.g., E2E seeding)
CREATE OR REPLACE FUNCTION public.handle_new_institution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Skip if no authenticated user (e.g., service role or migration context)
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Add the creator to user_institutions as admin
  INSERT INTO public.user_institutions (user_id, institution_id, role)
  VALUES (auth.uid(), NEW.id, 'admin')
  ON CONFLICT (user_id, institution_id) DO NOTHING;

  RETURN NEW;
END;
$$;
