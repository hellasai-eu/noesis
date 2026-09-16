-- Per-assignment release of correct answers and explanations to students.
-- Works alongside the global quizzes.show_answers flag: answers are visible to
-- a student when either flag is true for their specific assignment.
ALTER TABLE public.offering_quizzes
  ADD COLUMN answers_released boolean NOT NULL DEFAULT false;
