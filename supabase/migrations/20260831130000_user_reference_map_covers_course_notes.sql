-- `course_notes` (instructor-distributed PDF/DOC/TXT notes, 20260831120000)
-- joins the erasure registry.
--
-- The table carries `author_id uuid REFERENCES auth.users ON DELETE SET NULL`,
-- so erasure itself was already correct at creation. What needs widening is the
-- PROOF: `public.user_data_footprint()` is built from this map, so until the
-- column is listed here the sweep reports a clean erasure without ever looking
-- at it — the same gap 20260824150000 closed for the study-guide tables.
--
-- Deliberately a SET NULL rather than a cascade. The note is a document handed
-- to a class; deleting the teacher's account must not take the class's material
-- with it. The bytes in the `course-notes` bucket are keyed by course, not by
-- user, so they are outside the `<user id>/` storage prefix rule and stay put
-- with the row.
--
-- Replaces the whole function, rebased on 20260824150000 — the newest
-- definition — because that is how this map has always been edited.

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
    ('open_question_progress',      'user_id',          'uuid', 'CASCADE',  NULL),
    ('student_evaluations',         'user_id',          'uuid', 'CASCADE',  'evaluation_competency_scores cascades from it'),
    ('evaluation_timeline_cache',   'user_id',          'uuid', 'CASCADE',  NULL),
    ('student_horizontal_scores',   'student_id',       'uuid', 'CASCADE',  'Already correct'),
    ('flashcard_sessions',          'user_id',          'uuid', 'CASCADE',  NULL),
    ('flashcard_reviews',           'user_id',          'uuid', 'CASCADE',  NULL),
    ('graded_tests',                'student_id',       'uuid', 'CASCADE',  'Was SET NULL — the scan, OCR text and student name are the subject''s'),

    -- ── Tutoring / chat: the subject's own words ──────────────────────────
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
    ('storage.objects',             'name',             'storage_prefix', NULL, 'bug-reports / graded-tests objects under a `<user id>/` prefix')
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
