-- Index the foreign-key columns that RLS reads on every query (#947, item a).
--
-- 64 foreign-key constraints in `public` have no index whose leading column is
-- the constraint's first column. These 19 are the subset whose column also
-- appears in a row-level-security predicate on its own table, which is what
-- makes them the ones worth doing first.
--
-- Two costs are being paid today, and one index fixes both:
--
--   1. RLS runs on every read. A policy's USING clause becomes a filter in the
--      plan for every query against the table, so `quiz_sessions` gated on
--      `user_id` with no index on `user_id` means each student's own reads are
--      resolved by a sequential scan. These are per-user or per-course columns,
--      so the predicate is highly selective — precisely the case where the
--      missing index costs most.
--
--   2. Every one of them is a foreign key, and enforcing a parent delete means
--      finding the children. Without an index that is a sequential scan of the
--      child table per parent row. This is the half that is not merely slow:
--      `delete-user` cascades across ~50 tables to satisfy a GDPR erasure, and
--      an erasure that times out half-lands. Deleting a course or an offering
--      walks the same path.
--
-- "Every one of them is a foreign key" is a statement about the live catalogue
-- (`pg_constraint`), not about the CREATE TABLE statements, and the two do not
-- always agree. Several of these columns were declared as bare uuids and only
-- became foreign keys later, when the repair pass in 20260726000000 walked
-- `user_reference_map()` and issued
--
--     ALTER TABLE public.<tbl>
--       ADD CONSTRAINT fk_<tbl>_<col>_auth_users FOREIGN KEY (<col>)
--       REFERENCES auth.users(id) ON DELETE <rule>
--
-- for each entry. `ai_usage_logs.user_id` is the clearest example: its CREATE
-- TABLE (20251227093331) declares a plain uuid, and it carries
-- `fk_ai_usage_logs_user_id_auth_users ... ON DELETE SET NULL` today. So
-- reading the table definition alone understates which of these columns the
-- cascade argument covers — the catalogue is the authority.
--
-- Each column below is genuinely unindexed for its own lookup, not merely
-- absent from a composite. Where a composite exists it has the column in
-- SECOND position, which a btree cannot use for a leading-column probe:
--
--   open_question_grades  UNIQUE (open_question_id, user_id)
--   question_votes        UNIQUE (question_id, user_id)
--   evaluation_timeline_cache UNIQUE (course_id, user_id)
--   student_evaluations   (course_id, user_id, generated_at DESC)
--   flashcard_reviews     (user_id, course_id)
--   copilot_sessions      (course_id, user_id)
--   invitation_courses    UNIQUE (invitation_id, course_id)
--   study_guide_answers   (study_guide_id, offering_id)
--   study_guide_progress  (study_guide_id, offering_id)
--
-- and `tests` / `test_questions` carry nothing at all but their primary key.
--
-- Plain CREATE INDEX, matching the 66 migrations that already build indexes
-- here — none of them uses CONCURRENTLY. That takes a lock blocking writes to
-- the table while the index builds, which is why it is the right call only
-- while these tables are small. If any of them grows large, a later index
-- should be built CONCURRENTLY in its own migration, outside a transaction.
--
-- IF NOT EXISTS throughout: preview branches apply migrations incrementally,
-- so this must be safe to meet a database where some already exist.

-- ── Per-user columns: the subject's own rows, and the erasure cascade ──────
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_id
  ON public.ai_usage_logs (user_id);

CREATE INDEX IF NOT EXISTS idx_copilot_sessions_user_id
  ON public.copilot_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_evaluation_timeline_cache_user_id
  ON public.evaluation_timeline_cache (user_id);

CREATE INDEX IF NOT EXISTS idx_flashcard_sessions_user_id
  ON public.flashcard_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_open_question_grades_user_id
  ON public.open_question_grades (user_id);

CREATE INDEX IF NOT EXISTS idx_question_votes_user_id
  ON public.question_votes (user_id);

CREATE INDEX IF NOT EXISTS idx_quiz_sessions_user_id
  ON public.quiz_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_student_evaluations_user_id
  ON public.student_evaluations (user_id);

-- Authorship, cleared rather than cascaded on erasure (ON DELETE SET NULL) —
-- which still has to find the rows.
CREATE INDEX IF NOT EXISTS idx_questions_created_by
  ON public.questions (created_by);

-- ── Per-course columns: the course/offering delete cascade ────────────────
CREATE INDEX IF NOT EXISTS idx_course_chapter_progress_course_id
  ON public.course_chapter_progress (course_id);

CREATE INDEX IF NOT EXISTS idx_course_competencies_course_id
  ON public.course_competencies (course_id);

CREATE INDEX IF NOT EXISTS idx_flashcard_reviews_course_id
  ON public.flashcard_reviews (course_id);

CREATE INDEX IF NOT EXISTS idx_invitation_courses_course_id
  ON public.invitation_courses (course_id);

CREATE INDEX IF NOT EXISTS idx_open_question_mode_changes_course_id
  ON public.open_question_mode_changes (course_id);

CREATE INDEX IF NOT EXISTS idx_tests_course_id
  ON public.tests (course_id);

CREATE INDEX IF NOT EXISTS idx_textbook_chat_messages_course_id
  ON public.textbook_chat_messages (course_id);

CREATE INDEX IF NOT EXISTS idx_test_questions_test_id
  ON public.test_questions (test_id);

-- ── Per-offering columns on the study-guide answer path ───────────────────
CREATE INDEX IF NOT EXISTS idx_study_guide_answers_offering_id
  ON public.study_guide_answers (offering_id);

CREATE INDEX IF NOT EXISTS idx_study_guide_progress_offering_id
  ON public.study_guide_progress (offering_id);
