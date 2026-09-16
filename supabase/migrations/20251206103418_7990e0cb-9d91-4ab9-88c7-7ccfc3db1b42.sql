
-- Update get_user_institution_id to check user_institutions first (using session storage context)
-- Since we can't access session storage from SQL, we need a different approach
-- The function should return from user_institutions, not profiles

DROP FUNCTION IF EXISTS public.get_user_institution_id CASCADE;

CREATE OR REPLACE FUNCTION public.get_user_institution_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- First check profiles (for backwards compatibility)
  SELECT COALESCE(
    (SELECT institution_id FROM public.profiles WHERE user_id = _user_id AND institution_id IS NOT NULL LIMIT 1),
    (SELECT institution_id FROM public.user_institutions WHERE user_id = _user_id LIMIT 1)
  )
$$;

-- Update is_admin to also check user_institutions
DROP FUNCTION IF EXISTS public.is_admin CASCADE;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = _user_id AND role = 'admin'
  ) OR EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id AND role = 'admin'
  )
$$;

-- Update handle_new_institution to also set profiles.institution_id if null
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
  
  -- Update profile with this institution and admin role if not already set
  UPDATE public.profiles
  SET institution_id = COALESCE(institution_id, NEW.id), 
      role = 'admin'
  WHERE user_id = auth.uid();
  
  RETURN NEW;
END;
$$;
