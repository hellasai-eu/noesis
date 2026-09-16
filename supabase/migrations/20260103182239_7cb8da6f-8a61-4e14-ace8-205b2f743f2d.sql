-- Allow instructors/admins to UPDATE student_study_progress (for unflagging sessions)
CREATE POLICY "Admins and instructors can update study progress in their courses"
ON public.student_study_progress
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = student_study_progress.course_id
    AND (
      -- Course creator can update
      c.created_by = auth.uid()
      -- Institution admin can update
      OR EXISTS (
        SELECT 1 FROM user_institutions ui
        WHERE ui.user_id = auth.uid()
        AND ui.institution_id = c.institution_id
        AND ui.role = 'admin'
      )
      -- Instructor with tag access can update
      OR EXISTS (
        SELECT 1 FROM user_institutions ui
        WHERE ui.user_id = auth.uid()
        AND ui.institution_id = c.institution_id
        AND ui.role = 'instructor'
        AND EXISTS (
          SELECT 1 FROM course_tags ct
          JOIN user_tags ut ON ut.tag_id = ct.tag_id
          WHERE ct.course_id = c.id AND ut.user_id = auth.uid()
        )
      )
      -- Class instructor can update
      OR EXISTS (
        SELECT 1 FROM offerings o
        JOIN class_enrollments ce ON ce.class_id = o.class_id
        WHERE o.course_id = c.id
        AND ce.user_id = auth.uid()
        AND ce.role = 'instructor'
      )
    )
  )
);

-- Allow instructors/admins to DELETE student_study_progress
CREATE POLICY "Admins and instructors can delete study progress in their courses"
ON public.student_study_progress
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM courses c
    WHERE c.id = student_study_progress.course_id
    AND (
      c.created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM user_institutions ui
        WHERE ui.user_id = auth.uid()
        AND ui.institution_id = c.institution_id
        AND ui.role = 'admin'
      )
      OR EXISTS (
        SELECT 1 FROM user_institutions ui
        WHERE ui.user_id = auth.uid()
        AND ui.institution_id = c.institution_id
        AND ui.role = 'instructor'
        AND EXISTS (
          SELECT 1 FROM course_tags ct
          JOIN user_tags ut ON ut.tag_id = ct.tag_id
          WHERE ct.course_id = c.id AND ut.user_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1 FROM offerings o
        JOIN class_enrollments ce ON ce.class_id = o.class_id
        WHERE o.course_id = c.id
        AND ce.user_id = auth.uid()
        AND ce.role = 'instructor'
      )
    )
  )
);

-- Allow instructors/admins to DELETE study_session_messages
CREATE POLICY "Admins and instructors can delete study messages in their courses"
ON public.study_session_messages
FOR DELETE
USING (
  EXISTS (
    SELECT 1 FROM student_study_progress ssp
    JOIN courses c ON c.id = ssp.course_id
    WHERE ssp.id = study_session_messages.progress_id
    AND (
      c.created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM user_institutions ui
        WHERE ui.user_id = auth.uid()
        AND ui.institution_id = c.institution_id
        AND ui.role = 'admin'
      )
      OR EXISTS (
        SELECT 1 FROM user_institutions ui
        WHERE ui.user_id = auth.uid()
        AND ui.institution_id = c.institution_id
        AND ui.role = 'instructor'
        AND EXISTS (
          SELECT 1 FROM course_tags ct
          JOIN user_tags ut ON ut.tag_id = ct.tag_id
          WHERE ct.course_id = c.id AND ut.user_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1 FROM offerings o
        JOIN class_enrollments ce ON ce.class_id = o.class_id
        WHERE o.course_id = c.id
        AND ce.user_id = auth.uid()
        AND ce.role = 'instructor'
      )
    )
  )
);

-- Enable realtime for status updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.student_study_progress;
ALTER PUBLICATION supabase_realtime ADD TABLE public.open_question_progress;