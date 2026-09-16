-- Allow admins to delete quiz answers for leaderboard reset
CREATE POLICY "Admins can delete quiz answers"
ON public.quiz_answers
FOR DELETE
USING (EXISTS (
  SELECT 1
  FROM courses c
  JOIN profiles p ON c.institution_id = p.institution_id
  WHERE c.id = quiz_answers.course_id
    AND p.user_id = auth.uid()
    AND p.role = 'admin'
));