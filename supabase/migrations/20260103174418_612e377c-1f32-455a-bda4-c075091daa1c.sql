-- Add policy to allow admins/instructors to update student progress for unflagging
CREATE POLICY "Admins and instructors can update progress in their courses"
ON public.open_question_progress
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_progress.course_id
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);

-- Also add policy for open_question_chats to allow admins/instructors to update flagged_offensive
CREATE POLICY "Admins and instructors can update chats in their courses"
ON public.open_question_chats
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM courses c
    JOIN user_institutions ui ON ui.institution_id = c.institution_id
    WHERE c.id = open_question_chats.course_id
    AND ui.user_id = auth.uid()
    AND ui.role IN ('admin', 'instructor')
  )
);