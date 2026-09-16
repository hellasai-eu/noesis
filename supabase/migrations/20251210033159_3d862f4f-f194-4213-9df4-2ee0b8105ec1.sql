-- Composite indexes for common query patterns
CREATE INDEX idx_course_materials_course_created ON public.course_materials (course_id, created_at DESC);
CREATE INDEX idx_questions_course_visible_created ON public.questions (course_id, hidden, created_at DESC);
CREATE INDEX idx_open_questions_course_visible_created ON public.open_questions (course_id, hidden, created_at DESC);
CREATE INDEX idx_quiz_answers_user_course_time ON public.quiz_answers (user_id, course_id, answered_at DESC);
CREATE INDEX idx_student_progress_user_updated ON public.student_study_progress (user_id, updated_at DESC);