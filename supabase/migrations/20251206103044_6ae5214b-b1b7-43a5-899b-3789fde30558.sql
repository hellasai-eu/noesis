
-- Drop and recreate courses SELECT policy to allow super admins
DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;

CREATE POLICY "Users can view courses in their institution" ON public.courses 
FOR SELECT USING (
  is_super_admin(auth.uid()) 
  OR (
    institution_id = get_user_institution_id(auth.uid()) 
    AND (is_admin(auth.uid()) OR user_has_course_tag_access(id, auth.uid()))
  )
);

-- Also fix course_materials, questions, quizzes policies for super admins
DROP POLICY IF EXISTS "Users can view materials in their courses" ON public.course_materials;
CREATE POLICY "Users can view materials in their courses" ON public.course_materials 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR course_id IN (SELECT c.id FROM courses c JOIN profiles p ON c.institution_id = p.institution_id WHERE p.user_id = auth.uid())
);

-- Fix invitations SELECT for super admins
DROP POLICY IF EXISTS "Users can view invitations for their email or admins can view all" ON public.invitations;
CREATE POLICY "Users can view invitations" ON public.invitations 
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR (EXISTS (SELECT 1 FROM profiles WHERE profiles.user_id = auth.uid() AND profiles.role = 'admin' AND profiles.institution_id = invitations.institution_id))
  OR ((auth.jwt() ->> 'email') = email)
);

-- Fix user_institutions SELECT for super admins
DROP POLICY IF EXISTS "Institution admins can view all memberships in their institution" ON public.user_institutions;
CREATE POLICY "Admins can view memberships" ON public.user_institutions 
FOR SELECT USING (
  is_super_admin(auth.uid()) OR is_institution_admin(auth.uid(), institution_id)
);
