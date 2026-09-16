-- Create user_institutions junction table for many-to-many relationship
CREATE TABLE public.user_institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'student',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(user_id, institution_id)
);

-- Enable RLS
ALTER TABLE public.user_institutions ENABLE ROW LEVEL SECURITY;

-- Migrate existing data from profiles to user_institutions
INSERT INTO public.user_institutions (user_id, institution_id, role)
SELECT user_id, institution_id, role
FROM public.profiles
WHERE institution_id IS NOT NULL;

-- Create security definer function to get all user institution IDs
CREATE OR REPLACE FUNCTION public.get_user_institution_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT institution_id
  FROM public.user_institutions
  WHERE user_id = _user_id
$$;

-- Create function to check if user belongs to an institution
CREATE OR REPLACE FUNCTION public.user_belongs_to_institution(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id AND institution_id = _institution_id
  )
$$;

-- Create function to get user's role in a specific institution
CREATE OR REPLACE FUNCTION public.get_user_role_in_institution(_user_id uuid, _institution_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_institutions
  WHERE user_id = _user_id AND institution_id = _institution_id
  LIMIT 1
$$;

-- Create function to check if user is admin of a specific institution
CREATE OR REPLACE FUNCTION public.is_institution_admin(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id 
      AND institution_id = _institution_id
      AND role = 'admin'
  ) OR is_super_admin(_user_id)
$$;

-- RLS policies for user_institutions
CREATE POLICY "Users can view their own institution memberships"
ON public.user_institutions
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Institution admins can view all memberships in their institution"
ON public.user_institutions
FOR SELECT
TO authenticated
USING (
  is_institution_admin(auth.uid(), institution_id)
);

CREATE POLICY "Institution admins can insert memberships"
ON public.user_institutions
FOR INSERT
TO authenticated
WITH CHECK (
  is_institution_admin(auth.uid(), institution_id)
);

CREATE POLICY "Institution admins can update memberships"
ON public.user_institutions
FOR UPDATE
TO authenticated
USING (
  is_institution_admin(auth.uid(), institution_id)
);

CREATE POLICY "Institution admins can delete memberships"
ON public.user_institutions
FOR DELETE
TO authenticated
USING (
  is_institution_admin(auth.uid(), institution_id)
);

-- Update institutions SELECT policy to use new function
DROP POLICY IF EXISTS "Users can view their own institution" ON public.institutions;

CREATE POLICY "Users can view their institutions"
ON public.institutions
FOR SELECT
TO authenticated
USING (
  user_belongs_to_institution(auth.uid(), id) OR is_super_admin(auth.uid())
);