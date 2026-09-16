
-- Drop all tables except super_admins (in correct order due to foreign keys)
DROP TABLE IF EXISTS public.quiz_answers CASCADE;
DROP TABLE IF EXISTS public.quiz_sessions CASCADE;
DROP TABLE IF EXISTS public.quiz_questions CASCADE;
DROP TABLE IF EXISTS public.quizzes CASCADE;
DROP TABLE IF EXISTS public.question_votes CASCADE;
DROP TABLE IF EXISTS public.questions CASCADE;
DROP TABLE IF EXISTS public.material_chapters CASCADE;
DROP TABLE IF EXISTS public.course_materials CASCADE;
DROP TABLE IF EXISTS public.course_tags CASCADE;
DROP TABLE IF EXISTS public.user_tags CASCADE;
DROP TABLE IF EXISTS public.tags CASCADE;
DROP TABLE IF EXISTS public.invitations CASCADE;
DROP TABLE IF EXISTS public.user_institutions CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;
DROP TABLE IF EXISTS public.courses CASCADE;
DROP TABLE IF EXISTS public.institutions CASCADE;
DROP VIEW IF EXISTS public.question_vote_stats CASCADE;

-- Drop existing functions
DROP FUNCTION IF EXISTS public.is_institution_admin CASCADE;
DROP FUNCTION IF EXISTS public.user_belongs_to_institution CASCADE;
DROP FUNCTION IF EXISTS public.get_user_role_in_institution CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_user CASCADE;
DROP FUNCTION IF EXISTS public.update_updated_at_column CASCADE;
DROP FUNCTION IF EXISTS public.get_user_institution_id CASCADE;
DROP FUNCTION IF EXISTS public.user_has_tag_access CASCADE;
DROP FUNCTION IF EXISTS public.is_admin CASCADE;
DROP FUNCTION IF EXISTS public.create_course_tag CASCADE;
DROP FUNCTION IF EXISTS public.user_has_course_tag_access CASCADE;
DROP FUNCTION IF EXISTS public.is_course_instructor CASCADE;
DROP FUNCTION IF EXISTS public.get_question_vote_counts CASCADE;
DROP FUNCTION IF EXISTS public.get_user_display_name CASCADE;
DROP FUNCTION IF EXISTS public.is_super_admin CASCADE;
DROP FUNCTION IF EXISTS public.get_user_institution_ids CASCADE;

-- =====================
-- CREATE TABLES
-- =====================

-- Institutions table
CREATE TABLE public.institutions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Profiles table
CREATE TABLE public.profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE,
  institution_id uuid REFERENCES public.institutions(id),
  full_name text,
  email text,
  role text NOT NULL DEFAULT 'student',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- User institutions (many-to-many)
CREATE TABLE public.user_institutions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  institution_id uuid NOT NULL REFERENCES public.institutions(id),
  role text NOT NULL DEFAULT 'student',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, institution_id)
);

-- Tags table
CREATE TABLE public.tags (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  institution_id uuid NOT NULL,
  color text DEFAULT '#6366f1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(name, institution_id)
);

-- User tags
CREATE TABLE public.user_tags (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, tag_id)
);

-- Courses table
CREATE TABLE public.courses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES public.institutions(id),
  title text NOT NULL,
  description text,
  theme text,
  cover_image_url text,
  created_by uuid,
  leaderboard_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Course tags
CREATE TABLE public.course_tags (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(course_id, tag_id)
);

-- Course materials
CREATE TABLE public.course_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title text,
  description text,
  author text,
  year integer,
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_size integer,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Material chapters
CREATE TABLE public.material_chapters (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES public.course_materials(id) ON DELETE CASCADE,
  title text NOT NULL,
  chapter_number integer NOT NULL,
  content_type text NOT NULL,
  content text,
  file_url text,
  file_name text,
  instructions text,
  cheat_sheet text,
  cheat_sheet_visible boolean NOT NULL DEFAULT false,
  flashcards jsonb DEFAULT '[]'::jsonb,
  flashcards_visible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invitations table
CREATE TABLE public.invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES public.institutions(id),
  course_id uuid REFERENCES public.courses(id),
  email text NOT NULL,
  role text NOT NULL DEFAULT 'student',
  invited_name text,
  invited_tags jsonb DEFAULT '[]'::jsonb,
  invited_by uuid,
  status text NOT NULL DEFAULT 'pending',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Questions table
CREATE TABLE public.questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  correct_answer integer NOT NULL,
  explanation text,
  difficulty text NOT NULL DEFAULT 'medium',
  material_references jsonb DEFAULT '[]'::jsonb,
  hidden boolean NOT NULL DEFAULT false,
  upvotes integer NOT NULL DEFAULT 0,
  downvotes integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Question votes
CREATE TABLE public.question_votes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  vote_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(question_id, user_id)
);

-- Quizzes table
CREATE TABLE public.quizzes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  time_limit_minutes integer,
  due_date timestamptz,
  is_published boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Quiz questions
CREATE TABLE public.quiz_questions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  order_num integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Quiz sessions
CREATE TABLE public.quiz_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  quiz_id uuid NOT NULL REFERENCES public.quizzes(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expired_at timestamptz
);

-- Quiz answers
CREATE TABLE public.quiz_answers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id),
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  quiz_id uuid REFERENCES public.quizzes(id) ON DELETE CASCADE,
  session_id uuid,
  user_id uuid NOT NULL,
  selected_answer integer NOT NULL,
  is_correct boolean NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now()
);

-- Question vote stats view
CREATE VIEW public.question_vote_stats AS
SELECT 
  question_id,
  COUNT(*) FILTER (WHERE vote_type = 'up') as upvote_count,
  COUNT(*) FILTER (WHERE vote_type = 'down') as downvote_count
FROM public.question_votes
GROUP BY question_id;

-- =====================
-- CREATE FUNCTIONS
-- =====================

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins sa
    JOIN auth.users u ON u.email = sa.email
    WHERE u.id = _user_id
  )
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = _user_id AND role = 'admin'
  )
$$;

CREATE OR REPLACE FUNCTION public.is_institution_admin(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id 
      AND institution_id = _institution_id
      AND role = 'admin'
  ) OR is_super_admin(_user_id)
$$;

CREATE OR REPLACE FUNCTION public.user_belongs_to_institution(_user_id uuid, _institution_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id AND institution_id = _institution_id
  )
$$;

CREATE OR REPLACE FUNCTION public.get_user_role_in_institution(_user_id uuid, _institution_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role
  FROM public.user_institutions
  WHERE user_id = _user_id AND institution_id = _institution_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_user_institution_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT institution_id
  FROM public.profiles
  WHERE user_id = _user_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_user_institution_ids(_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT institution_id
  FROM public.user_institutions
  WHERE user_id = _user_id
$$;

CREATE OR REPLACE FUNCTION public.user_has_tag_access(_user_id uuid, _tag_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_tags
    WHERE user_id = _user_id AND tag_id = _tag_id
  )
$$;

CREATE OR REPLACE FUNCTION public.user_has_course_tag_access(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM course_tags ct
    JOIN user_tags ut ON ut.tag_id = ct.tag_id
    WHERE ct.course_id = _course_id AND ut.user_id = _user_id
  )
$$;

CREATE OR REPLACE FUNCTION public.is_course_instructor(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM profiles p
    WHERE p.user_id = _user_id 
      AND p.role = 'instructor'
      AND user_has_course_tag_access(_course_id, _user_id)
  )
$$;

CREATE OR REPLACE FUNCTION public.get_user_display_name(_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(full_name, 'Anonymous')
  FROM public.profiles
  WHERE user_id = _user_id
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.get_question_vote_counts(p_question_id uuid)
RETURNS TABLE(upvotes bigint, downvotes bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    COUNT(*) FILTER (WHERE vote_type = 'up') as upvotes,
    COUNT(*) FILTER (WHERE vote_type = 'down') as downvotes
  FROM public.question_votes
  WHERE question_id = p_question_id
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data ->> 'full_name');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_course_tag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tag_id uuid;
BEGIN
  INSERT INTO public.tags (name, institution_id, color)
  VALUES (NEW.title, NEW.institution_id, '#6366f1')
  ON CONFLICT (name, institution_id) DO NOTHING
  RETURNING id INTO new_tag_id;
  
  IF new_tag_id IS NOT NULL THEN
    INSERT INTO public.course_tags (course_id, tag_id)
    VALUES (NEW.id, new_tag_id);
  END IF;
  
  RETURN NEW;
END;
$$;

-- =====================
-- CREATE TRIGGERS
-- =====================

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER update_institutions_updated_at
  BEFORE UPDATE ON public.institutions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_courses_updated_at
  BEFORE UPDATE ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_questions_updated_at
  BEFORE UPDATE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_quizzes_updated_at
  BEFORE UPDATE ON public.quizzes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_material_chapters_updated_at
  BEFORE UPDATE ON public.material_chapters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER on_course_created
  AFTER INSERT ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.create_course_tag();

-- =====================
-- ENABLE RLS
-- =====================

ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_answers ENABLE ROW LEVEL SECURITY;

-- =====================
-- RLS POLICIES
-- =====================

-- Institutions policies
CREATE POLICY "Users can view their institutions" ON public.institutions FOR SELECT USING (user_belongs_to_institution(auth.uid(), id) OR is_super_admin(auth.uid()));
CREATE POLICY "Super admins can view all institutions" ON public.institutions FOR SELECT USING (is_super_admin(auth.uid()));
CREATE POLICY "Super admins can create institutions" ON public.institutions FOR INSERT WITH CHECK (is_super_admin(auth.uid()));
CREATE POLICY "Admins can update their institution" ON public.institutions FOR UPDATE USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = institutions.id));
CREATE POLICY "Super admins can update all institutions" ON public.institutions FOR UPDATE USING (is_super_admin(auth.uid()));
CREATE POLICY "Super admins can delete institutions" ON public.institutions FOR DELETE USING (is_super_admin(auth.uid()));

-- Profiles policies
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins can view all profiles in their institution" ON public.profiles FOR SELECT USING (is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));
CREATE POLICY "Users can insert their own profile" ON public.profiles FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING (user_id = auth.uid());

-- User institutions policies
CREATE POLICY "Users can view their own institution memberships" ON public.user_institutions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Institution admins can view all memberships in their institution" ON public.user_institutions FOR SELECT USING (is_institution_admin(auth.uid(), institution_id));
CREATE POLICY "Institution admins can insert memberships" ON public.user_institutions FOR INSERT WITH CHECK (is_institution_admin(auth.uid(), institution_id));
CREATE POLICY "Institution admins can update memberships" ON public.user_institutions FOR UPDATE USING (is_institution_admin(auth.uid(), institution_id));
CREATE POLICY "Institution admins can delete memberships" ON public.user_institutions FOR DELETE USING (is_institution_admin(auth.uid(), institution_id));

-- Tags policies
CREATE POLICY "Users can view tags in their institution" ON public.tags FOR SELECT USING (institution_id = get_user_institution_id(auth.uid()));
CREATE POLICY "Admins can create tags" ON public.tags FOR INSERT WITH CHECK (is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));
CREATE POLICY "Admins can update tags" ON public.tags FOR UPDATE USING (is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));
CREATE POLICY "Admins can delete tags" ON public.tags FOR DELETE USING (is_admin(auth.uid()) AND institution_id = get_user_institution_id(auth.uid()));

-- User tags policies
CREATE POLICY "Users can view their own tag access" ON public.user_tags FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins can view user tags in their institution" ON public.user_tags FOR SELECT USING (is_admin(auth.uid()));
CREATE POLICY "Admins can assign user tags" ON public.user_tags FOR INSERT WITH CHECK (is_admin(auth.uid()));
CREATE POLICY "Admins can remove user tags" ON public.user_tags FOR DELETE USING (is_admin(auth.uid()));

-- Courses policies
CREATE POLICY "Users can view courses in their institution" ON public.courses FOR SELECT USING (institution_id = get_user_institution_id(auth.uid()) AND (is_admin(auth.uid()) OR user_has_course_tag_access(id, auth.uid())));
CREATE POLICY "Admins can create courses" ON public.courses FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = courses.institution_id));
CREATE POLICY "Admins can update courses" ON public.courses FOR UPDATE USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = courses.institution_id));
CREATE POLICY "Admins can delete courses" ON public.courses FOR DELETE USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = courses.institution_id));

-- Course tags policies
CREATE POLICY "Users can view course tags for accessible courses" ON public.course_tags FOR SELECT USING (user_has_tag_access(tag_id, auth.uid()) OR is_admin(auth.uid()));
CREATE POLICY "Admins can manage course tags" ON public.course_tags FOR INSERT WITH CHECK (is_admin(auth.uid()));
CREATE POLICY "Admins can delete course tags" ON public.course_tags FOR DELETE USING (is_admin(auth.uid()));

-- Course materials policies
CREATE POLICY "Users can view materials in their courses" ON public.course_materials FOR SELECT USING (course_id IN (SELECT c.id FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE p.user_id = auth.uid()));
CREATE POLICY "Admins and instructors can insert course materials" ON public.course_materials FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = course_materials.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can update course materials" ON public.course_materials FOR UPDATE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = course_materials.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can delete course materials" ON public.course_materials FOR DELETE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = course_materials.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));

-- Material chapters policies
CREATE POLICY "Users can view chapters for accessible materials" ON public.material_chapters FOR SELECT USING (EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN profiles p ON c.institution_id = p.institution_id WHERE cm.id = material_chapters.material_id AND p.user_id = auth.uid()));
CREATE POLICY "Admins and instructors can insert chapters" ON public.material_chapters FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN profiles p ON c.institution_id = p.institution_id WHERE cm.id = material_chapters.material_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can update chapters" ON public.material_chapters FOR UPDATE USING (EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN profiles p ON c.institution_id = p.institution_id WHERE cm.id = material_chapters.material_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can delete chapters" ON public.material_chapters FOR DELETE USING (EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN profiles p ON c.institution_id = p.institution_id WHERE cm.id = material_chapters.material_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));

-- Invitations policies
CREATE POLICY "Users can view invitations for their email or admins can view all" ON public.invitations FOR SELECT USING ((EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = invitations.institution_id)) OR ((auth.jwt() ->> 'email') = email));
CREATE POLICY "Admins can create invitations" ON public.invitations FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = invitations.institution_id));
CREATE POLICY "Admins can update invitations" ON public.invitations FOR UPDATE USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = invitations.institution_id));
CREATE POLICY "Admins can delete invitations" ON public.invitations FOR DELETE USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = invitations.institution_id));

-- Questions policies
CREATE POLICY "Users can view questions for accessible courses" ON public.questions FOR SELECT USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = questions.course_id AND p.user_id = auth.uid() AND (is_admin(auth.uid()) OR user_has_course_tag_access(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can create questions" ON public.questions FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = questions.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can update questions" ON public.questions FOR UPDATE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = questions.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can delete questions" ON public.questions FOR DELETE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = questions.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));

-- Question votes policies
CREATE POLICY "Users can view their own votes" ON public.question_votes FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins can view all votes" ON public.question_votes FOR SELECT USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin'));
CREATE POLICY "Users can insert their own votes" ON public.question_votes FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update their own votes" ON public.question_votes FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY "Users can delete their own votes" ON public.question_votes FOR DELETE USING (user_id = auth.uid());

-- Quizzes policies
CREATE POLICY "Users can view quizzes for accessible courses" ON public.quizzes FOR SELECT USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = quizzes.course_id AND p.user_id = auth.uid() AND (is_admin(auth.uid()) OR is_course_instructor(c.id, auth.uid()) OR (user_has_course_tag_access(c.id, auth.uid()) AND quizzes.is_published = true))));
CREATE POLICY "Admins and instructors can create quizzes" ON public.quizzes FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = quizzes.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can update quizzes" ON public.quizzes FOR UPDATE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = quizzes.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));
CREATE POLICY "Admins and instructors can delete quizzes" ON public.quizzes FOR DELETE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = quizzes.course_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));

-- Quiz questions policies
CREATE POLICY "Users can view quiz questions for accessible quizzes" ON public.quiz_questions FOR SELECT USING (EXISTS (SELECT 1 FROM quizzes q JOIN courses c ON q.course_id = c.id JOIN profiles p ON c.institution_id = p.institution_id WHERE q.id = quiz_questions.quiz_id AND p.user_id = auth.uid() AND (is_admin(auth.uid()) OR is_course_instructor(c.id, auth.uid()) OR (user_has_course_tag_access(c.id, auth.uid()) AND q.is_published = true))));
CREATE POLICY "Admins and instructors can manage quiz questions" ON public.quiz_questions FOR ALL USING (EXISTS (SELECT 1 FROM quizzes q JOIN courses c ON q.course_id = c.id JOIN profiles p ON c.institution_id = p.institution_id WHERE q.id = quiz_questions.quiz_id AND p.user_id = auth.uid() AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))));

-- Quiz sessions policies
CREATE POLICY "Users can view their own quiz sessions" ON public.quiz_sessions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can create their own quiz sessions" ON public.quiz_sessions FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update their own quiz sessions" ON public.quiz_sessions FOR UPDATE USING (user_id = auth.uid());

-- Quiz answers policies
CREATE POLICY "Users can view their own quiz answers" ON public.quiz_answers FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Admins can view all quiz answers" ON public.quiz_answers FOR SELECT USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = quiz_answers.course_id AND p.user_id = auth.uid() AND p.role = 'admin'));
CREATE POLICY "Users can submit quiz answers" ON public.quiz_answers FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Admins can delete quiz answers" ON public.quiz_answers FOR DELETE USING (EXISTS (SELECT 1 FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE c.id = quiz_answers.course_id AND p.user_id = auth.uid() AND p.role = 'admin'));
