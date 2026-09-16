
-- Update functions to use user_institutions
DROP FUNCTION IF EXISTS public.get_user_institution_id CASCADE;
CREATE OR REPLACE FUNCTION public.get_user_institution_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT institution_id FROM public.user_institutions 
  WHERE user_id = _user_id 
  LIMIT 1
$$;

DROP FUNCTION IF EXISTS public.is_admin CASCADE;
CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_institutions
    WHERE user_id = _user_id AND role = 'admin'
  )
$$;

DROP FUNCTION IF EXISTS public.is_course_instructor CASCADE;
CREATE OR REPLACE FUNCTION public.is_course_instructor(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM user_institutions ui
    JOIN courses c ON c.institution_id = ui.institution_id
    WHERE ui.user_id = _user_id 
      AND ui.role = 'instructor'
      AND c.id = _course_id
      AND user_has_course_tag_access(_course_id, _user_id)
  )
$$;

-- Update triggers
CREATE OR REPLACE FUNCTION public.handle_new_institution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_institutions (user_id, institution_id, role)
  VALUES (auth.uid(), NEW.id, 'admin')
  ON CONFLICT (user_id, institution_id) DO NOTHING;
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

-- Recreate ALL RLS policies using user_institutions

-- Courses
CREATE POLICY "Users can view courses in their institution" ON public.courses 
FOR SELECT USING (
  is_super_admin(auth.uid()) 
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = courses.institution_id AND (ui.role = 'admin' OR user_has_course_tag_access(courses.id, auth.uid())))
);

CREATE POLICY "Admins can create courses" ON public.courses 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = courses.institution_id AND ui.role = 'admin')
);

CREATE POLICY "Admins can update courses" ON public.courses 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = courses.institution_id AND ui.role = 'admin')
);

CREATE POLICY "Admins can delete courses" ON public.courses 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = courses.institution_id AND ui.role = 'admin')
);

-- Institutions
CREATE POLICY "Admins can update their institution" ON public.institutions 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = institutions.id AND ui.role = 'admin')
);

-- Course materials
CREATE POLICY "Users can view materials in their courses" ON public.course_materials 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = course_materials.course_id AND ui.user_id = auth.uid())
);

CREATE POLICY "Admins and instructors can insert course materials" ON public.course_materials 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = course_materials.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can update course materials" ON public.course_materials 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = course_materials.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can delete course materials" ON public.course_materials 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = course_materials.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

-- Material chapters
CREATE POLICY "Users can view chapters for accessible materials" ON public.material_chapters 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE cm.id = material_chapters.material_id AND ui.user_id = auth.uid())
);

CREATE POLICY "Admins and instructors can insert chapters" ON public.material_chapters 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE cm.id = material_chapters.material_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can update chapters" ON public.material_chapters 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE cm.id = material_chapters.material_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can delete chapters" ON public.material_chapters 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM course_materials cm JOIN courses c ON cm.course_id = c.id JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE cm.id = material_chapters.material_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

-- Invitations
CREATE POLICY "Users can view invitations" ON public.invitations 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = invitations.institution_id AND ui.role = 'admin')
  OR ((auth.jwt() ->> 'email') = email)
);

CREATE POLICY "Admins can create invitations" ON public.invitations 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = invitations.institution_id AND ui.role = 'admin')
);

CREATE POLICY "Admins can update invitations" ON public.invitations 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = invitations.institution_id AND ui.role = 'admin')
);

CREATE POLICY "Admins can delete invitations" ON public.invitations 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = invitations.institution_id AND ui.role = 'admin')
);

-- Questions
CREATE POLICY "Users can view questions for accessible courses" ON public.questions 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = questions.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR user_has_course_tag_access(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can create questions" ON public.questions 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = questions.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can update questions" ON public.questions 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = questions.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can delete questions" ON public.questions 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = questions.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

-- Question votes
CREATE POLICY "Admins can view all votes" ON public.question_votes 
FOR SELECT USING (is_super_admin(auth.uid()) OR is_admin(auth.uid()));

-- Quizzes
CREATE POLICY "Users can view quizzes for accessible courses" ON public.quizzes 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = quizzes.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()) OR (user_has_course_tag_access(c.id, auth.uid()) AND quizzes.is_published = true)))
);

CREATE POLICY "Admins and instructors can create quizzes" ON public.quizzes 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = quizzes.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can update quizzes" ON public.quizzes 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = quizzes.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

CREATE POLICY "Admins and instructors can delete quizzes" ON public.quizzes 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = quizzes.course_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

-- Quiz questions
CREATE POLICY "Users can view quiz questions for accessible quizzes" ON public.quiz_questions 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM quizzes q JOIN courses c ON q.course_id = c.id JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE q.id = quiz_questions.quiz_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()) OR (user_has_course_tag_access(c.id, auth.uid()) AND q.is_published = true)))
);

CREATE POLICY "Admins and instructors can manage quiz questions" ON public.quiz_questions 
FOR ALL USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM quizzes q JOIN courses c ON q.course_id = c.id JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE q.id = quiz_questions.quiz_id AND ui.user_id = auth.uid() AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())))
);

-- Quiz answers
CREATE POLICY "Admins can view all quiz answers" ON public.quiz_answers 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = quiz_answers.course_id AND ui.user_id = auth.uid() AND ui.role = 'admin')
);

CREATE POLICY "Admins can delete quiz answers" ON public.quiz_answers 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM courses c JOIN user_institutions ui ON c.institution_id = ui.institution_id WHERE c.id = quiz_answers.course_id AND ui.user_id = auth.uid() AND ui.role = 'admin')
);

-- Tags
CREATE POLICY "Users can view tags in their institution" ON public.tags 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = tags.institution_id)
);

CREATE POLICY "Admins can create tags" ON public.tags 
FOR INSERT WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = tags.institution_id AND ui.role = 'admin')
);

CREATE POLICY "Admins can update tags" ON public.tags 
FOR UPDATE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = tags.institution_id AND ui.role = 'admin')
);

CREATE POLICY "Admins can delete tags" ON public.tags 
FOR DELETE USING (
  is_super_admin(auth.uid())
  OR EXISTS (SELECT 1 FROM user_institutions ui WHERE ui.user_id = auth.uid() AND ui.institution_id = tags.institution_id AND ui.role = 'admin')
);

-- User tags
CREATE POLICY "Admins can view user tags" ON public.user_tags 
FOR SELECT USING (is_super_admin(auth.uid()) OR is_admin(auth.uid()));

CREATE POLICY "Admins can assign user tags" ON public.user_tags 
FOR INSERT WITH CHECK (is_super_admin(auth.uid()) OR is_admin(auth.uid()));

CREATE POLICY "Admins can remove user tags" ON public.user_tags 
FOR DELETE USING (is_super_admin(auth.uid()) OR is_admin(auth.uid()));

-- Profiles
CREATE POLICY "Admins can view profiles" ON public.profiles 
FOR SELECT USING (is_super_admin(auth.uid()) OR is_admin(auth.uid()));
