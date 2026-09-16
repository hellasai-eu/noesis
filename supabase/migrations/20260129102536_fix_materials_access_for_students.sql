-- Fix course_materials and material_chapters access for students
-- Students should be able to view materials for courses they have access to via class enrollment

-- Update course_materials SELECT policy to include student class-based access
DROP POLICY IF EXISTS "Users can view materials in their courses" ON public.course_materials;

CREATE POLICY "Users can view materials in their courses" ON public.course_materials
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR (
    EXISTS (
      SELECT 1 FROM courses c
      JOIN user_institutions ui ON c.institution_id = ui.institution_id
      WHERE c.id = course_materials.course_id
        AND ui.user_id = auth.uid()
        AND (
          -- Admins see all materials in institution
          ui.role = 'admin'
          OR
          -- Instructors with tag access
          (ui.role = 'instructor' AND user_has_course_tag_access(c.id, auth.uid()))
          OR
          -- Students enrolled in a class that offers this course
          user_has_class_course_access(c.id, auth.uid())
        )
    )
  )
);

-- Update material_chapters SELECT policy to include student class-based access
DROP POLICY IF EXISTS "Users can view chapters for accessible materials" ON public.material_chapters;

CREATE POLICY "Users can view chapters for accessible materials" ON public.material_chapters
FOR SELECT USING (
  is_super_admin(auth.uid())
  OR (
    EXISTS (
      SELECT 1 FROM course_materials cm
      JOIN courses c ON cm.course_id = c.id
      JOIN user_institutions ui ON c.institution_id = ui.institution_id
      WHERE cm.id = material_chapters.material_id
        AND ui.user_id = auth.uid()
        AND (
          -- Admins see all chapters in institution
          ui.role = 'admin'
          OR
          -- Instructors with tag access
          (ui.role = 'instructor' AND user_has_course_tag_access(c.id, auth.uid()))
          OR
          -- Students enrolled in a class that offers this course
          user_has_class_course_access(c.id, auth.uid())
        )
    )
  )
);
