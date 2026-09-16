-- `user_reference_map()` had drifted, the same way the export specs did (#947).
--
-- The map is described in 20260726000000 as "every column in the schema that
-- points at a user", and its header tells the next author that adding a
-- personal-data table means adding it here AND to `user-export.ts`. The three
-- study-guide columns from #977/#978 were added to neither:
--
--   study_guides.created_by
--   study_guide_answers.user_id
--   study_guide_progress.user_id
--
-- The export half was repaired when `export-coverage.test.ts` was added; this
-- is the erasure half.
--
-- Erasure itself was never broken: all three were created with the correct
-- delete rule (`ON DELETE CASCADE` for the subject's own answers and progress,
-- `SET NULL` for authorship), so `delete-user` has always removed them. What
-- was broken is the PROOF. `public.user_data_footprint()` — "the sweep that
-- proves an erasure landed" — is built from this map, so it swept three columns
-- fewer than the schema had and reported a clean erasure without ever looking
-- at the subject's study-guide answers. A sweep that cannot see a table cannot
-- vouch for it.
--
-- Nothing here changes a constraint. The repair pass in 20260726000000 already
-- brought every FK in line with the map, and these three already agree with the
-- rules recorded below, so this migration only widens what the sweep inspects.
--
-- Rebased on the map as 20260729000000 left it — that migration replaced the
-- function to add both `failed_login_attempts` columns, so this file reproduces
-- its 68 entries and adds three. Replacing the whole function is how this map
-- has always been edited; the cost is that each replacement must start from the
-- newest version, not the original.
--
-- `audit_logs` is deliberately still absent — see 20260725064858 and the
-- DELIBERATELY NOT ERASED note in 20260726000000. Its user columns are bare
-- uuids with no FK on purpose, so that the record of a deletion survives the
-- deletion, and adding it here would make `user_data_footprint()` report the
-- audit trail as un-erased leftovers.

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
