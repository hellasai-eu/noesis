-- Add policy for admins and instructors to manage student mastery records
CREATE POLICY "Admins and instructors can manage student mastery"
ON public.student_competency_mastery
FOR ALL
USING (
  is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1
    FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = student_competency_mastery.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
)
WITH CHECK (
  is_super_admin(auth.uid())
  OR EXISTS (
    SELECT 1
    FROM courses c
    JOIN user_institutions ui ON c.institution_id = ui.institution_id
    WHERE c.id = student_competency_mastery.course_id
    AND ui.user_id = auth.uid()
    AND (ui.role = 'admin' OR is_course_instructor(c.id, auth.uid()))
  )
);