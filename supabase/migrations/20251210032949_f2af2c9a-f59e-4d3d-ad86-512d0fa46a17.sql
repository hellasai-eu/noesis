-- ====== course_* and tags ======
CREATE INDEX idx_course_exercise_pdfs_course_id ON public.course_exercise_pdfs (course_id);
CREATE INDEX idx_course_materials_course_id ON public.course_materials (course_id);
CREATE INDEX idx_course_tags_course_id ON public.course_tags (course_id);
CREATE INDEX idx_course_tags_tag_id ON public.course_tags (tag_id);

-- ====== courses / institutions ======
CREATE INDEX idx_courses_institution_id ON public.courses (institution_id);
CREATE INDEX idx_invitations_institution_id ON public.invitations (institution_id);
CREATE INDEX idx_tags_institution_id ON public.tags (institution_id);

-- ====== materials / chapters / study_sessions ======
CREATE INDEX idx_material_chapters_material_id ON public.material_chapters (material_id);
CREATE INDEX idx_study_sessions_course_id ON public.study_sessions (course_id);
CREATE INDEX idx_study_sessions_material_id ON public.study_sessions (material_id);
CREATE INDEX idx_study_sessions_chapter_id ON public.study_sessions (chapter_id);
CREATE INDEX idx_student_progress_course_id ON public.student_study_progress (course_id);
CREATE INDEX idx_student_progress_study_session_id ON public.student_study_progress (study_session_id);
CREATE INDEX idx_study_session_messages_progress_id ON public.study_session_messages (progress_id);

-- ====== open questions ======
CREATE INDEX idx_open_questions_course_id ON public.open_questions (course_id);
CREATE INDEX idx_open_question_grades_course_id ON public.open_question_grades (course_id);
CREATE INDEX idx_open_question_grades_question_id ON public.open_question_grades (open_question_id);

-- ====== MCQ questions ======
CREATE INDEX idx_questions_course_id ON public.questions (course_id);

-- ====== quizzes / sessions / answers ======
CREATE INDEX idx_quizzes_course_id ON public.quizzes (course_id);
CREATE INDEX idx_quiz_sessions_course_id ON public.quiz_sessions (course_id);
CREATE INDEX idx_quiz_sessions_quiz_id ON public.quiz_sessions (quiz_id);
CREATE INDEX idx_quiz_questions_quiz_id ON public.quiz_questions (quiz_id);
CREATE INDEX idx_quiz_questions_question_id ON public.quiz_questions (question_id);
CREATE INDEX idx_quiz_answers_course_id ON public.quiz_answers (course_id);
CREATE INDEX idx_quiz_answers_quiz_id ON public.quiz_answers (quiz_id);
CREATE INDEX idx_quiz_answers_question_id ON public.quiz_answers (question_id);

-- ====== user mappings ======
CREATE INDEX idx_user_institutions_institution_id ON public.user_institutions (institution_id);
CREATE INDEX idx_user_tags_tag_id ON public.user_tags (tag_id);