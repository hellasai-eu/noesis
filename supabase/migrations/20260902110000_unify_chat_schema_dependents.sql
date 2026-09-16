-- Dependent objects for the unified chat schema.
--
-- Three SQL objects enumerate the chat tables by name and would otherwise go
-- on pointing at the legacy ones: the per-user reference map that drives
-- erasure and the export coverage guard, the question-reset RPC, and the
-- retention purge.
--
-- Each is replaced whole, starting from its newest definition on disk rather
-- than its original — replacing from the original would silently revert every
-- fix made since.
--
-- The legacy tables stay for now, so their entries stay too: until the
-- follow-up migration drops them they still hold the pre-migration rows and
-- an erasure that skipped them would leave personal data behind.

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

-- The reset RPC wiped five legacy tables; three of them are now one family
-- hanging off `chat_sessions`, so deleting the session takes its messages,
-- state and history with it by cascade. The per-table counts the audit log
-- records are preserved under their original keys so the edge function and
-- its log entries need no change.
CREATE OR REPLACE FUNCTION public.reset_open_question_progress(_question_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chats_count       integer;
  progress_count    integer;
  session_count     integer;
  history_count     integer;
  grades_count      integer;
BEGIN
  -- Counted before the delete: once the session row goes, the cascade has
  -- already removed the rows we would have counted.
  SELECT count(*) INTO history_count
  FROM public.chat_state_history h
  JOIN public.chat_sessions s ON s.id = h.session_id
  WHERE s.open_question_id = _question_id;

  SELECT count(*) INTO session_count
  FROM public.chat_session_state st
  JOIN public.chat_sessions s ON s.id = st.session_id
  WHERE s.open_question_id = _question_id;

  SELECT count(*) INTO chats_count
  FROM public.chat_messages m
  JOIN public.chat_sessions s ON s.id = m.session_id
  WHERE s.open_question_id = _question_id;

  WITH d AS (
    DELETE FROM public.open_question_grades
    WHERE open_question_id = _question_id
    RETURNING id
  )
  SELECT count(*) INTO grades_count FROM d;

  WITH d AS (
    DELETE FROM public.chat_sessions
    WHERE open_question_id = _question_id
    RETURNING id
  )
  SELECT count(*) INTO progress_count FROM d;

  RETURN jsonb_build_object(
    'open_question_chats',       chats_count,
    'open_question_progress',    progress_count,
    'socratic_session_state',    session_count,
    'socratic_state_history',    history_count,
    'open_question_grades',      grades_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_open_question_progress(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_open_question_progress(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reset_open_question_progress(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_open_question_progress(uuid) TO service_role;

-- Retention: the unified state history joins the two it replaces. The legacy
-- pair stays until their tables are dropped.
--
-- Sourced from 20260729000000, not from 20260725120000 where the function was
-- introduced: the later migration added `failed_login_attempts` to the target
-- list, and rebuilding from the original would silently stop purging it.
-- Extending retention also means updating docs/compliance/data-retention.md.
CREATE OR REPLACE FUNCTION public.purge_expired_operational_logs(
  _batch_cap integer DEFAULT 50000
)
-- OUT names are deliberately distinct from the ledger's column names: in
-- plpgsql a RETURNS TABLE column is a variable, and reusing `table_name` /
-- `cutoff` would shadow the columns it is written to.
RETURNS TABLE (purged_table text, deleted_count integer, cutoff_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- (table, timestamp column). Extending retention to a new table means
  -- adding it here AND to docs/compliance/data-retention.md.
  v_targets  text[][] := ARRAY[
    ['login_history',             'login_at'],
    ['failed_login_attempts',     'attempted_at'],
    ['ai_usage_logs',             'created_at'],
    ['agent_interaction_logs',    'created_at'],
    ['ai_rate_limit_events',      'created_at'],
    ['socratic_state_history',    'created_at'],
    ['study_tutor_state_history', 'created_at'],
    ['chat_state_history',        'created_at']
  ];
  v_table    text;
  v_column   text;
  v_months   integer;
  v_cutoff   timestamptz;
  v_deleted  integer;
  v_cap      integer;
  v_error    text;
  v_backlog  boolean;
BEGIN
  -- A non-positive cap would delete nothing while logging a clean run, which
  -- reads as "retention is working" when it is not.
  v_cap := GREATEST(COALESCE(_batch_cap, 50000), 1);

  FOR i IN 1 .. array_length(v_targets, 1) LOOP
    v_table  := v_targets[i][1];
    v_column := v_targets[i][2];
    v_months := public.get_retention_months(v_table);
    v_cutoff := now() - make_interval(months => v_months);

    -- Each table is purged in its own subtransaction. Without this the whole
    -- function is one transaction, so a lock or statement timeout on a large
    -- table would roll back the tables already purged in this run — and a
    -- table that times out every night would block every other table forever.
    -- The failure is written to the ledger rather than swallowed, so a
    -- persistently failing table is visible instead of looking untouched.
    BEGIN
      EXECUTE format(
        'DELETE FROM public.%I
           WHERE ctid IN (
             SELECT ctid FROM public.%I WHERE %I < $1 LIMIT $2
           )',
        v_table, v_table, v_column
      )
      USING v_cutoff, v_cap;

      GET DIAGNOSTICS v_deleted = ROW_COUNT;

      -- Ask the table whether anything expired is left rather than inferring
      -- it from the row count. Index-supported and bounded by EXISTS.
      EXECUTE format(
        'SELECT EXISTS (SELECT 1 FROM public.%I WHERE %I < $1)',
        v_table, v_column
      )
      INTO v_backlog
      USING v_cutoff;

      v_error := NULL;
    EXCEPTION WHEN OTHERS THEN
      v_deleted := 0;
      -- Nothing was purged, so by definition the backlog stands.
      v_backlog := true;
      v_error   := SQLSTATE || ': ' || SQLERRM;
      RAISE WARNING 'retention purge failed for %: %', v_table, v_error;
    END;

    INSERT INTO public.retention_purge_runs
      (table_name, cutoff, retention_months, rows_deleted, backlog_remaining, error)
    VALUES
      (v_table, v_cutoff, v_months, v_deleted, v_backlog, v_error);

    purged_table  := v_table;
    deleted_count := v_deleted;
    cutoff_at     := v_cutoff;
    RETURN NEXT;
  END LOOP;
END;
$$;
