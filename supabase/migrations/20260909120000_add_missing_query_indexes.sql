-- Add indexes for query patterns that currently have no covering index.
-- Derived from an audit of every frontend query, edge-function query, and RLS
-- policy predicate against pg_indexes. Grouped by how hot the path is.

-- ---------------------------------------------------------------------------
-- Tier 1: hot paths (per chat turn / per answer submission / every
-- instructor-side RLS evaluation)
-- ---------------------------------------------------------------------------

-- verify-question-enrollment runs
--   WHERE question_id = ? AND published_at IS NOT NULL ORDER BY published_at DESC
-- before every student open-question chat turn and answer fetch; every existing
-- index on this table leads with offering_id or group_id. Full (not partial)
-- so it also serves the FK check when a question is deleted.
CREATE INDEX IF NOT EXISTS idx_offering_questions_question_published
  ON public.offering_questions (question_id, published_at DESC);

-- resolve-study-session-offering looks up by study_session_id on every
-- study-tutor chat turn; also an unindexed FK from study_sessions.
CREATE INDEX IF NOT EXISTS idx_offering_study_sessions_session
  ON public.offering_study_sessions (study_session_id);

-- submit-quiz-answers / record_quiz_answers() check the offering assignment by
-- quiz_id on every quiz submission; also an unindexed FK from quizzes.
CREATE INDEX IF NOT EXISTS idx_offering_quizzes_quiz
  ON public.offering_quizzes (quiz_id);

-- instructor_can_access_section() probes WHERE course_id = ? AND user_id = ?
-- (and the EXISTS arm adds class_id). The pkey is (course_id, class_id, user_id)
-- with class_id in the middle, so the probe scans all section rows for the
-- course. This helper sits under can_manage_offering / has_offering_access /
-- instructor_can_access_student, i.e. essentially every instructor-side SELECT.
CREATE INDEX IF NOT EXISTS idx_course_instructor_sections_course_user
  ON public.course_instructor_sections (course_id, user_id, class_id);

-- "Users can view instructor section restrictions" policy filters
-- user_id = auth.uid(), and several admin flows delete by user_id.
CREATE INDEX IF NOT EXISTS idx_course_instructor_sections_user
  ON public.course_instructor_sections (user_id);

-- record_quiz_answers()'s per-answer duplicate guard filters
-- (user_id, session_id, question_id); the session-review reads filter
-- session_id. The closest existing index is (user_id, course_id, answered_at),
-- which scans a student's entire answer history. Partial: practice answers
-- (session_id IS NULL) are the bulk of rows and never queried this way.
CREATE INDEX IF NOT EXISTS idx_quiz_answers_session_question
  ON public.quiz_answers (session_id, question_id)
  WHERE session_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tier 2: real query paths, moderate heat
-- ---------------------------------------------------------------------------

-- RLS policies "Users can accept/view their own invitation" filter
-- email = auth.jwt()->>'email' AND status = 'pending' with no institution
-- predicate, on a table that only grows (accepted invitations are retained).
CREATE INDEX IF NOT EXISTS idx_invitations_email_status
  ON public.invitations (email, status);

-- record-login-attempt attributes failed logins by profile email on every
-- failed login; profiles had no email index at all. Stored values are
-- GoTrue-normalized (lowercase), and the handler lowercases its input, so a
-- plain btree serves the equality lookup.
CREATE INDEX IF NOT EXISTS idx_profiles_email
  ON public.profiles (email);

-- StudentQuiz filters competency_chapters by chapter_id; the only non-PK index
-- leads with competency_id. Also an unindexed FK from material_chapters.
CREATE INDEX IF NOT EXISTS idx_competency_chapters_chapter
  ON public.competency_chapters (chapter_id);

-- generate-student-questions filters course_competencies by chapter_id;
-- also an unindexed FK from material_chapters.
CREATE INDEX IF NOT EXISTS idx_course_competencies_chapter
  ON public.course_competencies (chapter_id)
  WHERE chapter_id IS NOT NULL;

-- The GDPR erasure flow deletes and export-data reads flagged_content by
-- data->>'user_id'; the table has only its pkey.
CREATE INDEX IF NOT EXISTS idx_flagged_content_user
  ON public.flagged_content ((data ->> 'user_id'));

-- ---------------------------------------------------------------------------
-- Tier 3: unindexed foreign keys. Postgres seq-scans the child table once per
-- parent-row delete, so these govern how long deleting a question, material,
-- class, course, job, or user takes. Cold for reads; cheap to keep.
-- ---------------------------------------------------------------------------

-- Referencing questions (single-question deletes happen from the UI, and
-- course deletion cascades through questions):
CREATE INDEX IF NOT EXISTS idx_study_guide_answers_question
  ON public.study_guide_answers (question_id);
CREATE INDEX IF NOT EXISTS idx_test_questions_question
  ON public.test_questions (question_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_open_question
  ON public.chat_sessions (open_question_id)
  WHERE open_question_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_study_session
  ON public.chat_sessions (study_session_id)
  WHERE study_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_socratic_session_state_open_question
  ON public.socratic_session_state (open_question_id);

-- Referencing chat/state rows (reset_open_question_progress deletes sessions,
-- which cascades to messages; each message delete checks these):
CREATE INDEX IF NOT EXISTS idx_chat_state_history_trigger_message
  ON public.chat_state_history (trigger_message_id)
  WHERE trigger_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_socratic_state_history_trigger_message
  ON public.socratic_state_history (trigger_message_id)
  WHERE trigger_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_study_tutor_state_history_message
  ON public.study_tutor_state_history (message_id)
  WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_study_tutor_session_state_progress
  ON public.study_tutor_session_state (progress_id);

-- Referencing materials / chapters / classes / jobs:
CREATE INDEX IF NOT EXISTS idx_textbook_chat_messages_material
  ON public.textbook_chat_messages (material_id);
CREATE INDEX IF NOT EXISTS idx_course_chapter_progress_chapter
  ON public.course_chapter_progress (chapter_id);
CREATE INDEX IF NOT EXISTS idx_offering_chapter_flashcards_chapter
  ON public.offering_chapter_flashcards (chapter_id);
CREATE INDEX IF NOT EXISTS idx_course_instructor_sections_class
  ON public.course_instructor_sections (class_id);
CREATE INDEX IF NOT EXISTS idx_notifications_job
  ON public.notifications (job_id)
  WHERE job_id IS NOT NULL;

-- Referencing courses / institutions (super-admin course and institution
-- deletion cascades through these):
CREATE INDEX IF NOT EXISTS idx_flashcard_sessions_course
  ON public.flashcard_sessions (course_id);
CREATE INDEX IF NOT EXISTS idx_invitations_course
  ON public.invitations (course_id)
  WHERE course_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_rate_limit_events_course
  ON public.ai_rate_limit_events (course_id)
  WHERE course_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_rate_limit_events_institution
  ON public.ai_rate_limit_events (institution_id)
  WHERE institution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bug_reports_institution
  ON public.bug_reports (institution_id)
  WHERE institution_id IS NOT NULL;

-- Referencing auth.users. delete-user removes the auth row, and every one of
-- these columns forces a per-table scan during that delete; export-data also
-- pages through most of them by the same column. system_config.updated_by is
-- deliberately skipped (single-digit row count).
CREATE INDEX IF NOT EXISTS idx_courses_created_by
  ON public.courses (created_by);
CREATE INDEX IF NOT EXISTS idx_classes_created_by
  ON public.classes (created_by);
CREATE INDEX IF NOT EXISTS idx_quizzes_created_by
  ON public.quizzes (created_by);
CREATE INDEX IF NOT EXISTS idx_tests_created_by
  ON public.tests (created_by);
CREATE INDEX IF NOT EXISTS idx_study_sessions_created_by
  ON public.study_sessions (created_by);
CREATE INDEX IF NOT EXISTS idx_study_guides_created_by
  ON public.study_guides (created_by);
CREATE INDEX IF NOT EXISTS idx_course_materials_uploaded_by
  ON public.course_materials (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_course_exercise_pdfs_uploaded_by
  ON public.course_exercise_pdfs (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_graded_tests_created_by
  ON public.graded_tests (created_by);
CREATE INDEX IF NOT EXISTS idx_graded_tests_graded_by
  ON public.graded_tests (graded_by)
  WHERE graded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_course_chapter_progress_completed_by
  ON public.course_chapter_progress (completed_by)
  WHERE completed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_class_announcements_author
  ON public.class_announcements (author_id);
CREATE INDEX IF NOT EXISTS idx_course_notes_author
  ON public.course_notes (author_id);
CREATE INDEX IF NOT EXISTS idx_offering_groups_created_by
  ON public.offering_groups (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_offering_groups_owner
  ON public.offering_groups (owner_user_id)
  WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_offering_group_members_added_by
  ON public.offering_group_members (added_by)
  WHERE added_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_student_admin_notes_created_by
  ON public.student_admin_notes (created_by);
CREATE INDEX IF NOT EXISTS idx_student_admin_notes_updated_by
  ON public.student_admin_notes (updated_by)
  WHERE updated_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_student_admin_notes_audit_actor
  ON public.student_admin_notes_audit (actor);
CREATE INDEX IF NOT EXISTS idx_open_question_mode_changes_changed_by
  ON public.open_question_mode_changes (changed_by);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender
  ON public.chat_messages (sender_user_id)
  WHERE sender_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_invited_by
  ON public.invitations (invited_by);
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_user
  ON public.failed_login_attempts (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_rate_limit_events_user
  ON public.ai_rate_limit_events (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_notifications_student
  ON public.admin_notifications (student_id);
