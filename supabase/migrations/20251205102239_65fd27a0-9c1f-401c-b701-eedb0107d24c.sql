-- Drop existing restrictive policies and recreate as permissive
DROP POLICY IF EXISTS "Admins can manage course materials" ON public.course_materials;
DROP POLICY IF EXISTS "Users can view materials in their courses" ON public.course_materials;

-- Recreate as permissive policies
CREATE POLICY "Users can view materials in their courses"
  ON public.course_materials FOR SELECT
  USING (
    course_id IN (
      SELECT c.id FROM public.courses c
      JOIN public.profiles p ON c.institution_id = p.institution_id
      WHERE p.user_id = auth.uid()
    )
  );

CREATE POLICY "Admins can insert course materials"
  ON public.course_materials FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.courses c
      JOIN public.profiles p ON c.institution_id = p.institution_id
      WHERE c.id = course_materials.course_id
      AND p.user_id = auth.uid()
      AND p.role = 'admin'
    )
  );

CREATE POLICY "Admins can delete course materials"
  ON public.course_materials FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.courses c
      JOIN public.profiles p ON c.institution_id = p.institution_id
      WHERE c.id = course_materials.course_id
      AND p.user_id = auth.uid()
      AND p.role = 'admin'
    )
  );

-- Also fix the courses policies to be permissive
DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;
DROP POLICY IF EXISTS "Admins can create courses" ON public.courses;
DROP POLICY IF EXISTS "Admins can update courses" ON public.courses;
DROP POLICY IF EXISTS "Admins can delete courses" ON public.courses;

CREATE POLICY "Users can view courses in their institution"
  ON public.courses FOR SELECT
  USING (
    institution_id IN (SELECT institution_id FROM public.profiles WHERE user_id = auth.uid())
  );

CREATE POLICY "Admins can create courses"
  ON public.courses FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() 
      AND role = 'admin' 
      AND institution_id = courses.institution_id
    )
  );

CREATE POLICY "Admins can update courses"
  ON public.courses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() 
      AND role = 'admin' 
      AND institution_id = courses.institution_id
    )
  );

CREATE POLICY "Admins can delete courses"
  ON public.courses FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() 
      AND role = 'admin' 
      AND institution_id = courses.institution_id
    )
  );

-- Fix institutions policies
DROP POLICY IF EXISTS "Users can view their institution" ON public.institutions;

CREATE POLICY "Users can view their institution"
  ON public.institutions FOR SELECT
  USING (
    id IN (SELECT institution_id FROM public.profiles WHERE user_id = auth.uid())
  );

CREATE POLICY "Authenticated users can create institutions"
  ON public.institutions FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Fix profiles policies
DROP POLICY IF EXISTS "Users can view profiles in their institution" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;

CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can view profiles in their institution"
  ON public.profiles FOR SELECT
  USING (
    institution_id IN (SELECT institution_id FROM public.profiles WHERE user_id = auth.uid())
    OR user_id = auth.uid()
  );

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (user_id = auth.uid());

-- Fix invitations policies
DROP POLICY IF EXISTS "Admins can view invitations for their institution" ON public.invitations;
DROP POLICY IF EXISTS "Admins can create invitations" ON public.invitations;
DROP POLICY IF EXISTS "Admins can update invitations" ON public.invitations;

CREATE POLICY "Admins can view invitations for their institution"
  ON public.invitations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() 
      AND role = 'admin' 
      AND institution_id = invitations.institution_id
    )
  );

CREATE POLICY "Admins can create invitations"
  ON public.invitations FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() 
      AND role = 'admin' 
      AND institution_id = invitations.institution_id
    )
  );

CREATE POLICY "Admins can update invitations"
  ON public.invitations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE user_id = auth.uid() 
      AND role = 'admin' 
      AND institution_id = invitations.institution_id
    )
  );