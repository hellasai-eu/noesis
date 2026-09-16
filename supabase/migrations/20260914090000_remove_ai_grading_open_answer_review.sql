-- Remove AI grading of open answers: pending-review model + instructor-only AI drafts.
--
-- The AI no longer assigns grades anywhere. Open answers (practice written mode
-- and study-guide pieces) are now recorded like open answers inside a quiz have
-- always been: stored for instructor review, never auto-scored. The model still
-- reads the answer and writes a QUALITATIVE draft (feedback, strengths, areas
-- for improvement — no number) as an aid for the instructor.
--
-- That draft must not be readable by the student: `open_question_grades` and
-- `study_guide_answers` both carry "Students see their own rows" policies, so
-- anything stored on those rows is student-visible at the API layer, whatever
-- the UI hides. The draft therefore lives in its own table with manager-only
-- SELECT and no student policy at all. The student-visible grade/feedback
-- columns stay NULL until an instructor writes them.
--
-- Three pieces:
--   1. `open_answer_ai_drafts` — instructor-only AI draft per (question, student).
--   2. A manager UPDATE policy on `study_guide_answers` — instructors could
--      never grade study-guide answers from the client (grading used to be the
--      AI's job, applied by the service role). Manual review needs a write path.
--   3. The erasure-registry/export bookkeeping for the new table.

-- ---------------------------------------------------------------------------
-- 1. open_answer_ai_drafts
-- ---------------------------------------------------------------------------

CREATE TABLE public.open_answer_ai_drafts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- NOT NULL on purpose: both writers resolve the offering the student is
  -- entitled through, and the SELECT policy leans on it for section scoping.
  offering_id uuid NOT NULL REFERENCES public.offerings(id) ON DELETE CASCADE,
  -- Which surface produced the submission the draft is about.
  source text NOT NULL CHECK (source IN ('practice', 'study_guide')),
  feedback text NOT NULL,
  strengths text[],
  areas_for_improvement text[],
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  -- One draft per submission. Submissions are one-shot per (question,
  -- student, offering) — a study guide reused across offerings, or a
  -- question appearing on both surfaces, must not collide with an earlier
  -- draft about a different answer.
  UNIQUE (question_id, user_id, offering_id, source)
);

CREATE INDEX idx_open_answer_ai_drafts_course ON public.open_answer_ai_drafts(course_id);
CREATE INDEX idx_open_answer_ai_drafts_user ON public.open_answer_ai_drafts(user_id);

ALTER TABLE public.open_answer_ai_drafts ENABLE ROW LEVEL SECURITY;

-- Managers only, through the section-aware offering boundary: a
-- section-restricted instructor must not read review notes about students in
-- sections they do not teach (`can_manage_offering` also admits institution
-- admins and super admins). Deliberately NO student policy: the entire point
-- of this table is that the draft is invisible to the student until an
-- instructor turns it into a real grade + feedback on the student-visible
-- row. Written exclusively by the service role (submit-open-answer,
-- submit-study-guide-piece), so no INSERT/UPDATE/DELETE policies either.
CREATE POLICY "Managers can view AI drafts"
ON public.open_answer_ai_drafts
FOR SELECT
USING (public.can_manage_offering(offering_id));

-- ---------------------------------------------------------------------------
-- 2. Manual grading of study-guide answers
-- ---------------------------------------------------------------------------

-- The original policy set left UPDATE out on purpose: answers are immutable
-- and grading was applied by the service role. With AI grading removed, the
-- instructor is the grader, and needs a client-side write path for the
-- grading columns.
CREATE POLICY "Managers can grade study guide answers"
  ON public.study_guide_answers
  FOR UPDATE
  USING (public.can_manage_offering(offering_id))
  WITH CHECK (public.can_manage_offering(offering_id));

-- RLS cannot scope an UPDATE to specific columns, so the policy alone would
-- let a manager rewrite the student's immutable submission or reassign the
-- row. This trigger closes that hole for every writer: only the grading
-- columns (grade, feedback, strengths, areas_for_improvement, graded_at,
-- is_correct) may change after insert. The existing tuple trigger already
-- pins (piece_id, study_guide_id, question_id); this one pins the rest.
CREATE OR REPLACE FUNCTION public.study_guide_answers_grading_columns_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.study_guide_id IS DISTINCT FROM OLD.study_guide_id
    OR NEW.offering_id IS DISTINCT FROM OLD.offering_id
    OR NEW.piece_id IS DISTINCT FROM OLD.piece_id
    OR NEW.question_id IS DISTINCT FROM OLD.question_id
    OR NEW.submission::text IS DISTINCT FROM OLD.submission::text
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'study_guide_answers: only the grading columns may change after submission';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER study_guide_answers_grading_columns_only
  BEFORE UPDATE ON public.study_guide_answers
  FOR EACH ROW EXECUTE FUNCTION public.study_guide_answers_grading_columns_only();

-- ---------------------------------------------------------------------------
-- 3. Erasure registry
-- ---------------------------------------------------------------------------

-- Replaces the whole function, rebased on 20260913090000 — the newest
-- definition — because that is how this map has always been edited.
-- One addition: open_answer_ai_drafts (AI-drafted feedback about the
-- subject's answer; model output about a person is that person's data).
CREATE OR REPLACE FUNCTION public.user_reference_map()
RETURNS TABLE (tbl text, col text, kind text, fk_action text, note text)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT *
  FROM (VALUES
    -- ── Account ───────────────────────────────────────────────────────────
    ('profiles'::text,              'user_id'::text,    'uuid'::text, 'CASCADE'::text, 'Name, email, role'::text),
    ('user_institutions',           'user_id',          'uuid', 'CASCADE',  'Membership; user_institution_grades cascades from it'),
    ('login_history',               'user_id',          'uuid', 'CASCADE',  'IP address + user agent — the hole this issue opened on'),
    ('failed_login_attempts',       'user_id',          'uuid', 'CASCADE',  'IP + user agent of failed sign-ins — same rule as login_history'),
    ('notifications',               'user_id',          'uuid', 'CASCADE',  'Already correct'),
    ('super_admins',                'email',            'email', NULL,      'Keyed by email only — no user id column'),

    -- ── Enrolment / assignment ────────────────────────────────────────────
    ('class_enrollments',           'user_id',          'uuid', 'CASCADE',  NULL),
    ('course_instructors',          'user_id',          'uuid', 'CASCADE',  'course_instructor_sections cascades from it'),
    ('course_instructor_sections',  'user_id',          'uuid', NULL,       'Covered by its composite FK to course_instructors(course_id, user_id); swept, not repaired'),
    ('course_evaluators',           'user_id',          'uuid', 'CASCADE',  NULL),
    ('offering_group_members',      'user_id',          'uuid', 'CASCADE',  'Already correct'),
    ('offering_groups',             'owner_user_id',    'uuid', 'CASCADE',  'Already correct — individual groups are per-student'),

    -- ── Assessment activity and its results ───────────────────────────────
    ('quiz_sessions',               'user_id',          'uuid', 'CASCADE',  'quiz_session_questions cascades from it'),
    ('quiz_answers',                'user_id',          'uuid', 'CASCADE',  NULL),
    ('question_votes',              'user_id',          'uuid', 'CASCADE',  NULL),
    ('open_question_grades',        'user_id',          'uuid', 'CASCADE',  NULL),
    ('open_answer_ai_drafts',       'user_id',          'uuid', 'CASCADE',  'AI-drafted feedback about the subject''s answer — instructor-only'),
    ('open_question_progress',      'user_id',          'uuid', 'CASCADE',  NULL),
    ('student_evaluations',         'user_id',          'uuid', 'CASCADE',  'evaluation_competency_scores cascades from it'),
    ('evaluation_timeline_cache',   'user_id',          'uuid', 'CASCADE',  NULL),
    ('flashcard_sessions',          'user_id',          'uuid', 'CASCADE',  NULL),
    ('flashcard_reviews',           'user_id',          'uuid', 'CASCADE',  NULL),
    ('graded_tests',                'student_id',       'uuid', 'CASCADE',  'Was SET NULL — the scan, OCR text and student name are the subject''s'),

    -- ── Tutoring / chat: the subject's own words ──────────────────────────
    ('chat_sessions',               'user_id',          'uuid', 'CASCADE',  'Unified tutoring session; chat_messages, chat_session_state and chat_state_history all cascade from it'),
    ('chat_messages',               'sender_user_id',   'uuid', 'SET NULL', 'Instructor replies in a student''s thread outlive the instructor'),
    ('open_question_chats',         'user_id',          'uuid', 'CASCADE',  NULL),
    ('textbook_chat_messages',      'user_id',          'uuid', 'CASCADE',  NULL),
    ('copilot_sessions',            'user_id',          'uuid', 'CASCADE',  'messages jsonb'),
    ('socratic_session_state',      'user_id',          'uuid', 'CASCADE',  'Already correct; socratic_state_history cascades from it'),
    ('study_tutor_session_state',   'user_id',          'uuid', 'CASCADE',  'Already correct; study_tutor_state_history cascades from it'),
    ('student_study_progress',      'user_id',          'uuid', 'CASCADE',  'study_session_messages cascades from it'),
    ('agent_interaction_logs',      'user_id',          'uuid', 'CASCADE',  'Carries user_message + model output, so anonymising is not enough'),

    -- ── Study guides (#977/#978 — landed after this map, backfilled 20260824) ──
    ('study_guide_answers',         'user_id',          'uuid', 'CASCADE',  'The subject''s own answers — immutable, one row per (student, offering, question)'),
    ('study_guide_progress',        'user_id',          'uuid', 'CASCADE',  'Per-piece progress and draft answers'),

    -- ── Administrative records about the subject ──────────────────────────
    ('admin_notifications',         'student_id',       'uuid', 'CASCADE',  'Already correct'),
    ('announcement_reads',          'user_id',          'uuid', 'CASCADE',  'Already correct'),
    ('student_admin_notes',         'student_user_id',  'uuid', 'CASCADE',  'Already correct'),
    ('student_admin_notes_audit',   'student_user_id',  'uuid', 'CASCADE',  'Audit of notes ABOUT the subject — goes with the notes'),
    ('question_evaluations',        'evaluator_id',     'uuid', 'CASCADE',  'Already correct'),
    ('question_evaluation_sessions','evaluator_id',     'uuid', 'CASCADE',  'Already correct'),
    ('rights_requests',             'subject_user_id',  'uuid', 'SET NULL', 'Accountability evidence (Art. 5(2)) outlives the subject; subject_label cleared by erase_user_unlinked_data'),

    -- ── Authorship: the row survives, the attribution does not ────────────
    ('courses',                     'created_by',       'uuid', 'SET NULL', NULL),
    ('classes',                     'created_by',       'uuid', 'SET NULL', NULL),
    ('questions',                   'created_by',       'uuid', 'SET NULL', NULL),
    ('quizzes',                     'created_by',       'uuid', 'SET NULL', NULL),
    ('tests',                       'created_by',       'uuid', 'SET NULL', NULL),
    ('study_sessions',              'created_by',       'uuid', 'SET NULL', NULL),
    ('study_guides',                'created_by',       'uuid', 'SET NULL', 'Authored guide outlives its author (#977/#978)'),
    ('course_materials',            'uploaded_by',      'uuid', 'SET NULL', NULL),
    ('course_exercise_pdfs',        'uploaded_by',      'uuid', 'SET NULL', NULL),
    ('course_chapter_progress',     'completed_by',     'uuid', 'SET NULL', NULL),
    ('class_announcements',         'author_id',        'uuid', 'SET NULL', 'Already correct'),
    ('course_notes',                'author_id',        'uuid', 'SET NULL', 'Distributed note outlives its author; the file stays for the class'),
    ('open_question_mode_changes',  'changed_by',       'uuid', 'SET NULL', 'Already correct'),
    ('open_question_chats',         'sender_user_id',   'uuid', 'SET NULL', 'Already correct — instructor replies in a student''s thread'),
    ('study_session_messages',      'sender_user_id',   'uuid', 'SET NULL', 'Already correct — same'),
    ('student_admin_notes',         'created_by',       'uuid', 'SET NULL', 'Already correct'),
    ('student_admin_notes',         'updated_by',       'uuid', 'SET NULL', 'Already correct'),
    ('student_admin_notes_audit',   'actor',            'uuid', 'SET NULL', NULL),
    ('offering_groups',             'created_by',       'uuid', 'SET NULL', 'Already correct'),
    ('offering_group_members',      'added_by',         'uuid', 'SET NULL', 'Already correct'),
    ('graded_tests',                'created_by',       'uuid', 'SET NULL', NULL),
    ('graded_tests',                'graded_by',        'uuid', 'SET NULL', NULL),
    ('jobs',                        'created_by',       'uuid', 'SET NULL', 'Already correct'),
    ('system_config',               'updated_by',       'uuid', 'SET NULL', NULL),
    ('invitations',                 'invited_by',       'uuid', 'SET NULL', NULL),
    ('rights_requests',             'created_by',       'uuid', 'SET NULL', 'The admin who logged the request'),
    ('rights_requests',             'closed_by',        'uuid', 'SET NULL', 'The admin who closed it'),

    -- ── Aggregate counters: keep the row, drop the attribution ────────────
    ('ai_usage_logs',               'user_id',          'uuid', 'SET NULL', 'Token counts and cost — no content'),
    ('ai_rate_limit_events',        'user_id',          'uuid', 'SET NULL', 'Provider rate-limit events — no content'),
    ('bug_reports',                 'reporter_id',      'uuid', 'SET NULL', 'Already correct — the defect record outlives the reporter'),

    -- ── Not reachable by foreign key (handled in delete-user) ─────────────
    ('invitations',                 'email',            'email', NULL,      'Pending/accepted invitation carries email + name'),
    ('bug_reports',                 'reporter_email',   'email', NULL,      'Anonymised: reporter_id is SET NULL, email cleared, screenshots removed'),
    ('profiles',                    'email',            'email', NULL,      'Goes with the profile row; listed so the sweep checks it'),
    ('failed_login_attempts',       'email_attempted',  'email', NULL,      'Attempts that resolved to no account keep the address but no user id'),
    ('flagged_content',             'data',             'json_uuid', NULL,  'Moderation payload embeds user_id + an excerpt of the content'),
    ('storage.objects',             'name',             'storage_prefix', NULL, 'bug-reports / graded-tests objects under a `<user id>/` prefix'),

    -- ── Free-text names typed by instructors (reviewed, never auto-cleared) ──
    ('graded_tests',                'student_name',     'name', NULL,       'Typed on unattributed scans; find_erasure_name_matches() lists survivors for review'),
    ('student_evaluations',         'student_name',     'name', NULL,       'user_id cascades, so a surviving match is another account carrying the name')
  ) AS t(tbl, col, kind, fk_action, note);
$$;

COMMENT ON FUNCTION public.user_reference_map() IS
  'Every column referencing a user and its erasure rule. Source of truth for the '
  'FK repair in 20260726000000, for public.user_data_footprint(), and for the '
  'per-user export coverage guard in '
  'supabase/tests/rls/__tests__/export-coverage.test.ts. Adding a personal-data '
  'table means adding it here AND to supabase/functions/export-data/user-export.ts; '
  'the guard fails when the two disagree. Edited by replacing the whole function — '
  'always start from the newest definition. audit_logs is deliberately absent — see '
  '20260725064858. See docs/compliance/user-erasure.md.';
