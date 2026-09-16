
-- Create function to add creator as admin when institution is created
CREATE OR REPLACE FUNCTION public.handle_new_institution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Add the creator to user_institutions as admin
  INSERT INTO public.user_institutions (user_id, institution_id, role)
  VALUES (auth.uid(), NEW.id, 'admin')
  ON CONFLICT (user_id, institution_id) DO NOTHING;
  
  -- Update or create profile with this institution
  UPDATE public.profiles
  SET institution_id = NEW.id, role = 'admin'
  WHERE user_id = auth.uid() AND institution_id IS NULL;
  
  RETURN NEW;
END;
$$;

-- Create trigger for new institutions
DROP TRIGGER IF EXISTS on_institution_created ON public.institutions;
CREATE TRIGGER on_institution_created
  AFTER INSERT ON public.institutions
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_institution();
