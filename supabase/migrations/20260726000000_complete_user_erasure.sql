-- Complete user erasure — FK audit, cascade repair and a footprint sweep
-- (issue #932, epic #931).
--
-- `delete-user` deleted `user_institutions` + `profiles` and then called
-- `auth.admin.deleteUser`, trusting foreign-key cascades for everything else.
-- That trust was misplaced: migration 20251206101851 dropped and recreated the
-- core tables WITHOUT their foreign keys to `auth.users`, and most tables added
-- since never had one. `login_history` (IP + user agent) was only the most
-- visible survivor — `profiles.user_id` itself had no FK either, and the
-- explicit delete in the handler was the only thing removing it.
--
-- This migration makes the schema, rather than a hand-maintained list in an
-- edge function, the thing that guarantees erasure:
--
--   1. `public.user_reference_map()` — the single source of truth for every
--      place a user is referenced, and what must happen to it on erasure.
--   2. A repair pass that brings every FK in that map in line with the map.
--   3. `public.user_data_footprint()` — a sweep that counts what is left of a
--      user across every reference, for verifying an erasure actually landed.
--
-- WHAT IS NOT REACHABLE BY FOREIGN KEY, and so stays in the edge function
-- (`supabase/functions/delete-user/erasure.ts`): rows keyed by the subject's
-- EMAIL rather than their id (`invitations`, `super_admins`,
-- `bug_reports.reporter_email`), the user id buried in `flagged_content.data`
-- JSON, and storage objects. The map lists all of them so the sweep still
-- covers them; only the repair pass skips them.
--
-- DELIBERATELY NOT ERASED: `audit_logs.actor_user_id` / `actor_email`. Per
-- 20260725064858 the audit trail must survive the deletion it records — the
-- subject there is a bare uuid, and the email belongs to the acting admin, not
-- to the erased user. See docs/compliance/user-erasure.md.

-- ---------------------------------------------------------------------------
-- 1. The map
-- ---------------------------------------------------------------------------

-- Every column in the schema that points at a user, and the erasure rule for
-- it. Adding a personal-data table means adding it here — and to
-- `supabase/functions/export-data/user-export.ts`, its export counterpart.
--
--   kind = 'uuid'           column holds auth.users.id
--          'email'          column holds the subject's email address
--          'json_uuid'      jsonb column with a top-level "user_id" key
--          'storage_prefix' storage objects under a `<user id>/` prefix
--
--   fk_action = 'CASCADE'   the row is ABOUT the subject: delete it
--               'SET NULL'  the row outlives the subject (authorship,
--                           aggregate counters); drop the attribution only
--               NULL        no foreign key is possible; the edge function
--                           handles it
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
    ('flagged_content',             'data',             'json_uuid', NULL,  'Moderation payload embeds user_id + an excerpt of the content'),
    ('storage.objects',             'name',             'storage_prefix', NULL, 'bug-reports / graded-tests objects under a `<user id>/` prefix')
  ) AS t(tbl, col, kind, fk_action, note);
$$;

COMMENT ON FUNCTION public.user_reference_map() IS
  'Every column referencing a user and its erasure rule. Source of truth for the FK repair in 20260726000000 and for public.user_data_footprint(). See docs/compliance/user-erasure.md.';

-- ---------------------------------------------------------------------------
-- 2. Repair
-- ---------------------------------------------------------------------------

-- Bring every foreign key in the map in line with the map.
--
-- For each entry: clear whatever the FK would have cleared already (orphans
-- from users deleted before this migration — precisely the GDPR leftovers this
-- issue is about), then create or replace the constraint. Existing constraints
-- with the right delete rule are left alone, so re-running is a no-op.
--
-- Pre-cleaning is what lets the constraint be created VALID: an orphaned row
-- would otherwise abort the ALTER. The anti-joins are sequential scans on
-- tables without an index on the user column; at this schema's size that is
-- seconds, and it happens once.
DO $repair$
DECLARE
  r            record;
  v_conname    text;
  v_deltype    "char";
  v_want       "char";
  v_attnum     smallint;
  v_new_name   text;
  v_count      bigint;
BEGIN
  FOR r IN
    SELECT * FROM public.user_reference_map()
     WHERE fk_action IS NOT NULL
     ORDER BY tbl, col
  LOOP
    -- Schema drift: a table listed in the map may not exist in every
    -- environment (or may have been dropped since). Skip rather than abort —
    -- a missing table holds no personal data.
    IF to_regclass(format('public.%I', r.tbl)) IS NULL THEN
      RAISE NOTICE 'user erasure: skipping missing table %', r.tbl;
      CONTINUE;
    END IF;

    SELECT a.attnum INTO v_attnum
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', r.tbl)::regclass
       AND a.attname  = r.col
       AND a.attnum > 0
       AND NOT a.attisdropped;

    IF v_attnum IS NULL THEN
      RAISE NOTICE 'user erasure: skipping missing column %.%', r.tbl, r.col;
      CONTINUE;
    END IF;

    v_want := CASE r.fk_action WHEN 'CASCADE' THEN 'c' ELSE 'n' END;

    -- An existing FK from exactly this column to auth.users, whatever it is
    -- named. Matching on conkey rather than on a name convention: these
    -- constraints were created by a dozen different migrations.
    SELECT c.conname, c.confdeltype
      INTO v_conname, v_deltype
      FROM pg_constraint c
     WHERE c.conrelid  = format('public.%I', r.tbl)::regclass
       AND c.confrelid = 'auth.users'::regclass
       AND c.contype   = 'f'
       AND c.conkey    = ARRAY[v_attnum]::smallint[];

    IF v_conname IS NOT NULL AND v_deltype = v_want THEN
      CONTINUE;
    END IF;

    IF v_conname IS NOT NULL THEN
      RAISE NOTICE 'user erasure: replacing % on %.% (% -> %)',
        v_conname, r.tbl, r.col, v_deltype, r.fk_action;
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, v_conname);
    END IF;

    IF r.fk_action = 'CASCADE' THEN
      EXECUTE format(
        'DELETE FROM public.%I t
           WHERE t.%I IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.%I)',
        r.tbl, r.col, r.col
      );
    ELSE
      EXECUTE format(
        'UPDATE public.%I t
            SET %I = NULL
          WHERE t.%I IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.%I)',
        r.tbl, r.col, r.col, r.col
      );
    END IF;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      RAISE NOTICE 'user erasure: cleared % orphaned row(s) from %.%',
        v_count, r.tbl, r.col;
    END IF;

    -- Truncated to Postgres' 63-byte identifier limit; the map's longest entry
    -- is comfortably under it, but a future one need not be.
    v_new_name := left(format('fk_%s_%s_auth_users', r.tbl, r.col), 63);

    EXECUTE format(
      'ALTER TABLE public.%I
         ADD CONSTRAINT %I FOREIGN KEY (%I)
         REFERENCES auth.users(id) ON DELETE %s',
      r.tbl, v_new_name, r.col, r.fk_action
    );
  END LOOP;
END
$repair$;

-- ---------------------------------------------------------------------------
-- 3. Sweep
-- ---------------------------------------------------------------------------

-- What is left of a user, per reference. Every row must read 0 once erasure
-- has run; anything else is a hole. Used by the DB test suite
-- (`supabase/tests/rls/__tests__/user-erasure.test.ts`) and available to a
-- super admin answering "prove you deleted my data".
--
-- `_email` is optional: without it the email-keyed sources are reported as -1
-- ("not checked") rather than silently 0, so a caller cannot mistake a partial
-- sweep for a clean one.
--
-- SECURITY DEFINER to reach RLS-protected tables and `storage.objects`; it is
-- read-only, counts only, and EXECUTE is granted to no client role. Every
-- identifier comes from the hardcoded map and goes through format('%I').
CREATE OR REPLACE FUNCTION public.user_data_footprint(
  _user_id uuid,
  _email   text DEFAULT NULL
)
RETURNS TABLE (source_table text, source_column text, match_kind text, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       record;
  v_count bigint;
BEGIN
  FOR r IN SELECT * FROM public.user_reference_map() ORDER BY tbl, col LOOP
    v_count := 0;

    IF r.kind = 'storage_prefix' THEN
      SELECT count(*) INTO v_count
        FROM storage.objects o
       WHERE o.name LIKE _user_id::text || '/%';

    ELSIF to_regclass(format('public.%I', r.tbl)) IS NULL THEN
      CONTINUE;

    ELSIF r.kind = 'uuid' THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', r.tbl, r.col)
        INTO v_count USING _user_id;

    ELSIF r.kind = 'email' THEN
      IF _email IS NULL THEN
        v_count := -1;
      ELSE
        EXECUTE format('SELECT count(*) FROM public.%I WHERE lower(%I) = lower($1)', r.tbl, r.col)
          INTO v_count USING _email;
      END IF;

    ELSIF r.kind = 'json_uuid' THEN
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I ->> ''user_id'' = $1', r.tbl, r.col)
        INTO v_count USING _user_id::text;
    END IF;

    source_table  := r.tbl;
    source_column := r.col;
    match_kind    := r.kind;
    row_count     := v_count;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.user_data_footprint(uuid, text) IS
  'Counts every remaining reference to a user. All zero = erasure complete. -1 means "not checked" (email-keyed source called without an email).';

-- No client role gets either function: the map is schema metadata and the
-- footprint reads across every tenant. Edge functions call it with the service
-- role; the test suite connects as postgres.
REVOKE ALL ON FUNCTION public.user_reference_map() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.user_data_footprint(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_reference_map() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.user_data_footprint(uuid, text) TO postgres, service_role;
