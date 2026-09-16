-- Create tags table
CREATE TABLE public.tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  institution_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(institution_id, name)
);

-- Create course_tags junction table
CREATE TABLE public.course_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(course_id, tag_id)
);

-- Create user_tags junction table for access control
CREATE TABLE public.user_tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, tag_id)
);

-- Enable RLS
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tags ENABLE ROW LEVEL SECURITY;

-- Security definer function to check if user has tag access
CREATE OR REPLACE FUNCTION public.user_has_tag_access(_user_id UUID, _tag_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_tags
    WHERE user_id = _user_id AND tag_id = _tag_id
  )
$$;

-- Security definer function to check if user is admin
CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = _user_id AND role = 'admin'
  )
$$;

-- Tags policies
CREATE POLICY "Users can view tags in their institution"
ON public.tags FOR SELECT
USING (institution_id = get_user_institution_id(auth.uid()));

CREATE POLICY "Admins can create tags"
ON public.tags FOR INSERT
WITH CHECK (public.is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));

CREATE POLICY "Admins can update tags"
ON public.tags FOR UPDATE
USING (public.is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));

CREATE POLICY "Admins can delete tags"
ON public.tags FOR DELETE
USING (public.is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));

-- Course tags policies
CREATE POLICY "Users can view course tags for accessible courses"
ON public.course_tags FOR SELECT
USING (EXISTS (
  SELECT 1 FROM public.courses c
  WHERE c.id = course_tags.course_id
  AND c.institution_id = get_user_institution_id(auth.uid())
));

CREATE POLICY "Admins can manage course tags"
ON public.course_tags FOR INSERT
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Admins can delete course tags"
ON public.course_tags FOR DELETE
USING (public.is_admin(auth.uid()));

-- User tags policies
CREATE POLICY "Admins can view user tags in their institution"
ON public.user_tags FOR SELECT
USING (public.is_admin(auth.uid()));

CREATE POLICY "Users can view their own tag access"
ON public.user_tags FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "Admins can assign user tags"
ON public.user_tags FOR INSERT
WITH CHECK (public.is_admin(auth.uid()));

CREATE POLICY "Admins can remove user tags"
ON public.user_tags FOR DELETE
USING (public.is_admin(auth.uid()));

-- Update courses RLS to respect tag-based access for non-admins
DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;

CREATE POLICY "Users can view courses in their institution"
ON public.courses FOR SELECT
USING (
  institution_id = get_user_institution_id(auth.uid())
  AND (
    -- Admins see all courses
    public.is_admin(auth.uid())
    OR
    -- Non-admins see courses with no tags OR courses with tags they have access to
    NOT EXISTS (SELECT 1 FROM public.course_tags ct WHERE ct.course_id = courses.id)
    OR
    EXISTS (
      SELECT 1 FROM public.course_tags ct
      JOIN public.user_tags ut ON ut.tag_id = ct.tag_id
      WHERE ct.course_id = courses.id AND ut.user_id = auth.uid()
    )
  )
);