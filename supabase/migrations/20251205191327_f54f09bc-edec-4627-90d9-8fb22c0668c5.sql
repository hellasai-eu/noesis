-- Create a function to check if user is an instructor with tag access to a course
CREATE OR REPLACE FUNCTION public.is_course_instructor(_course_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
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

-- Update questions policies to allow instructors
DROP POLICY IF EXISTS "Admins can create questions" ON public.questions;
CREATE POLICY "Admins and instructors can create questions" 
ON public.questions 
FOR INSERT 
WITH CHECK (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

DROP POLICY IF EXISTS "Admins can update questions" ON public.questions;
CREATE POLICY "Admins and instructors can update questions" 
ON public.questions 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

DROP POLICY IF EXISTS "Admins can delete questions" ON public.questions;
CREATE POLICY "Admins and instructors can delete questions" 
ON public.questions 
FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = questions.course_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Update course_materials policies
DROP POLICY IF EXISTS "Admins can insert course materials" ON public.course_materials;
CREATE POLICY "Admins and instructors can insert course materials" 
ON public.course_materials 
FOR INSERT 
WITH CHECK (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = course_materials.course_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

DROP POLICY IF EXISTS "Admins can update course materials" ON public.course_materials;
CREATE POLICY "Admins and instructors can update course materials" 
ON public.course_materials 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = course_materials.course_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

DROP POLICY IF EXISTS "Admins can delete course materials" ON public.course_materials;
CREATE POLICY "Admins and instructors can delete course materials" 
ON public.course_materials 
FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM courses c
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE c.id = course_materials.course_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

-- Update material_chapters policies
DROP POLICY IF EXISTS "Admins can insert chapters" ON public.material_chapters;
CREATE POLICY "Admins and instructors can insert chapters" 
ON public.material_chapters 
FOR INSERT 
WITH CHECK (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

DROP POLICY IF EXISTS "Admins can update chapters" ON public.material_chapters;
CREATE POLICY "Admins and instructors can update chapters" 
ON public.material_chapters 
FOR UPDATE 
USING (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);

DROP POLICY IF EXISTS "Admins can delete chapters" ON public.material_chapters;
CREATE POLICY "Admins and instructors can delete chapters" 
ON public.material_chapters 
FOR DELETE 
USING (
  EXISTS (
    SELECT 1 FROM course_materials cm
    JOIN courses c ON cm.course_id = c.id
    JOIN profiles p ON c.institution_id = p.institution_id
    WHERE cm.id = material_chapters.material_id 
      AND p.user_id = auth.uid() 
      AND (p.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);