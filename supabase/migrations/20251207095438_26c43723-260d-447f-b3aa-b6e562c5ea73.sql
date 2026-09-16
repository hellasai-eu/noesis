-- Function to get user auth info (last sign in, created at) for admins
CREATE OR REPLACE FUNCTION public.get_user_auth_info(_user_id uuid)
RETURNS TABLE(last_sign_in_at timestamptz, auth_created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.last_sign_in_at, u.created_at
  FROM auth.users u
  WHERE u.id = _user_id
$$;