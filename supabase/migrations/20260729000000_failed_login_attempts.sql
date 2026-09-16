-- Failed sign-in attempts, for brute-force / credential-stuffing visibility.
--
-- Nothing recorded a failed login anywhere. `login_history` is written by the
-- browser *after* a successful `signInWithPassword`, and the primary login path
-- never touches an edge function, so `withLogging`'s auth-failure record never
-- fires for it either. An account could be hammered indefinitely and leave no
-- trace in the product.
--
-- ⚠️  TRUST — READ THIS BEFORE TREATING IT AS A SECURITY CONTROL.
--
-- This data is UNVERIFIED IN BOTH DIRECTIONS. Do not build lockout,
-- alerting-that-pages, or any enforcement on it.
--
--   * Under-reporting. Rows arrive because OUR OWN UI reports its failures to
--     the `record-login-attempt` edge function. An attacker doing credential
--     stuffing will POST straight to `/auth/v1/token?grant_type=password` and
--     never call the reporter, so a determined attacker is INVISIBLE here.
--
--   * Over-reporting. The reporting endpoint cannot be authenticated — it is
--     called precisely when authentication failed, so there is no credential
--     to present and no signed proof from GoTrue that a sign-in was even
--     attempted. Anyone who can reach it can therefore submit any address and
--     have a row attributed to that user and institution. An isolate-wide cap
--     in the handler bounds the VOLUME of such rows; it does not make any one
--     of them true. (The per-IP cap alone could not: its key is a request
--     header, so a caller who rotates it gets a fresh bucket every time.)
--
-- What it is good for: "this account has 40 failed attempts today", a user
-- who has locked themselves out, a shared account being fought over — read by
-- a human who knows the above. Real rate limiting and brute-force protection
-- belong to Supabase Auth's own Attack Protection settings; this table does
-- not replace them.
--
-- Making the contents trustworthy would mean routing sign-in THROUGH an edge
-- function so the server observes the outcome itself, rather than being told
-- about it. That is a much larger change to the most safety-critical path in
-- the product and was deliberately not attempted here.
--
-- `ip_address` is read from the request headers rather than from the browser,
-- and is taken from the RIGHTMOST `x-forwarded-for` hop — the one our own
-- infrastructure appended, since a caller can prepend anything to the left. It
-- is better than `login_history.ip_address`, which the browser fetches from
-- api.ipify.org and is wholly client-chosen, but it is still best-effort and
-- must not be treated as forensic evidence.

CREATE TABLE IF NOT EXISTS public.failed_login_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lower-cased by the writer. Deliberately NOT constrained to a real account:
  -- attempts against an address that does not exist are exactly the signal
  -- that distinguishes credential stuffing from one user mistyping.
  email_attempted text,
  -- Resolved from the email server-side when it maps to a profile, else NULL.
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Copied from the resolved user so an institution admin can be shown their
  -- own tenant's attempts without a join to a table they may not read.
  institution_id  uuid REFERENCES public.institutions(id) ON DELETE SET NULL,
  ip_address      text,
  user_agent      text,
  -- 'invalid_credentials' | 'user_banned' | 'other'. Free text rather than an
  -- enum: it mirrors whatever GoTrue returned, and a new upstream code must
  -- not make the write fail — losing the record is worse than an unknown label.
  reason          text NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT now()
);

-- "How many failures for this address recently" and "what came from this IP
-- recently" are the two questions this table exists to answer.
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_email_at
  ON public.failed_login_attempts(lower(email_attempted), attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_ip_at
  ON public.failed_login_attempts(ip_address, attempted_at DESC);
-- Drives the retention purge and the institution-scoped admin view.
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_attempted_at
  ON public.failed_login_attempts(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_failed_login_attempts_institution
  ON public.failed_login_attempts(institution_id, attempted_at DESC);

ALTER TABLE public.failed_login_attempts ENABLE ROW LEVEL SECURITY;

-- Read-only from every client. There is NO insert policy on purpose: rows come
-- solely from the `record-login-attempt` edge function via the service role,
-- which bypasses RLS. That keeps the column shape under the writer's control
-- and stops clients writing arbitrary rows directly.
--
-- It does NOT make the contents trustworthy. The reporting endpoint has to be
-- unauthenticated — it is called precisely when authentication failed — so
-- anyone who can reach it can submit any address and have a row attributed to
-- that user and institution. Forging is volume-bounded by the isolate-wide cap
-- in the handler, not prevented. See the trust note at the top of this file.
DROP POLICY IF EXISTS "Super admins can read failed login attempts"
  ON public.failed_login_attempts;
CREATE POLICY "Super admins can read failed login attempts"
  ON public.failed_login_attempts
  FOR SELECT
  USING (public.is_super_admin(auth.uid()));

-- Institution admins see only attempts attributable to their own institution.
-- Rows with a NULL institution_id — an address matching no account — stay
-- super-admin only: they cannot be attributed to a tenant, and showing them to
-- every institution admin would leak one tenant's enumeration attempts (and
-- the addresses tried) to all the others.
DROP POLICY IF EXISTS "Institution admins can read their failed login attempts"
  ON public.failed_login_attempts;
CREATE POLICY "Institution admins can read their failed login attempts"
  ON public.failed_login_attempts
  FOR SELECT
  USING (
    failed_login_attempts.institution_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.user_institutions ui
      WHERE ui.user_id = auth.uid()
        AND ui.role = 'admin'
        AND ui.institution_id = failed_login_attempts.institution_id
    )
  );

COMMENT ON TABLE public.failed_login_attempts IS
  'Failed sign-in attempts SELF-REPORTED by our own UI via the record-login-attempt edge function. Unverified in both directions: an attacker calling GoTrue directly never appears here, and the reporting endpoint is necessarily unauthenticated so rows can be forged against any address. Operational visibility for a human only — never build lockout or enforcement on it. See the migration header.';

-- ---------------------------------------------------------------------------
-- Register with retention (20260725120000) and erasure (20260726000000)
-- ---------------------------------------------------------------------------
-- Both functions are reproduced in full with one entry added, because a SQL
-- function body cannot be appended to. The only changes from the originals are
-- the `failed_login_attempts` rows.

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
    ['study_tutor_state_history', 'created_at']
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
    ('failed_login_attempts',       'email_attempted',  'email', NULL,      'Attempts that resolved to no account keep the address but no user id'),
    ('flagged_content',             'data',             'json_uuid', NULL,  'Moderation payload embeds user_id + an excerpt of the content'),
    ('storage.objects',             'name',             'storage_prefix', NULL, 'bug-reports / graded-tests objects under a `<user id>/` prefix')
  ) AS t(tbl, col, kind, fk_action, note);
$$;


-- ---------------------------------------------------------------------------
-- Erasure of the email-keyed rows
-- ---------------------------------------------------------------------------
-- Rows whose `user_id` resolved cascade with the account. Rows that matched no
-- profile carry only the address, so no foreign key can reach them — the map
-- above lists them as 'email' kind, and this is the implementation of that
-- claim. Reproduced in full from 20260726010000 with one DELETE added.

CREATE OR REPLACE FUNCTION public.erase_user_unlinked_data(
  _user_id uuid,
  _email   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paths text[] := '{}';
  v_bug   integer := 0;
  v_inv   integer := 0;
  v_admin integer := 0;
  v_flag  integer := 0;
  v_fla   integer := 0;
BEGIN
  -- Bug reports are anonymised, not deleted: the defect record has value, the
  -- reporter does not. `reporter_id` is nulled by its own foreign key when the
  -- account goes; the email copy and the screenshots are cleared here.
  --
  -- The paths are collected BEFORE the update empties the column. Matching on
  -- `reporter_id` still works because this runs before the auth user is deleted.
  --
  -- NARROWER THAN THE UPDATE BELOW, deliberately. An address can be reassigned:
  -- someone changes their email, and the subject later registers the address
  -- they gave up. Their old reports still carry the stale `reporter_email`, so
  -- an email-only match would hand back attachments belonging to a LIVE user,
  -- which the caller then deletes from storage with the service role. Only rows
  -- the subject owns (`reporter_id`) or that have no owner at all — an account
  -- already deleted — can contribute paths.
  SELECT coalesce(array_agg(DISTINCT p) FILTER (WHERE p IS NOT NULL), '{}')
    INTO v_paths
    FROM (
      SELECT unnest(screenshot_paths) AS p
        FROM public.bug_reports
       WHERE reporter_id = _user_id
          OR (reporter_id IS NULL
              AND _email IS NOT NULL
              AND lower(reporter_email) = lower(_email))
    ) s;

  -- Clearing the ADDRESS stays broad: wherever the subject's email appears it
  -- is their personal data, even on a row a reassignment left with someone
  -- else. That costs the other owner nothing — a stale address they no longer
  -- hold. Clearing `screenshot_paths` follows the narrow rule instead, so the
  -- column is only emptied for rows whose objects are actually being deleted;
  -- otherwise a live user's report would keep its attachments in storage while
  -- losing every reference to them.
  UPDATE public.bug_reports
     SET reporter_email = NULL,
         screenshot_paths = CASE
           WHEN reporter_id IS NULL OR reporter_id = _user_id THEN '{}'
           ELSE screenshot_paths
         END
   WHERE reporter_id = _user_id
      OR (_email IS NOT NULL AND lower(reporter_email) = lower(_email));
  GET DIAGNOSTICS v_bug = ROW_COUNT;

  IF _email IS NOT NULL THEN
    -- A pending invitation carries the email and the name it was addressed to.
    -- Invitations the subject SENT keep their rows; `invited_by` is nulled by
    -- its foreign key, because those belong to the institution.
    DELETE FROM public.invitations WHERE lower(email) = lower(_email);
    GET DIAGNOSTICS v_inv = ROW_COUNT;

    -- Keyed by email alone. Leaving the row would retain the address AND
    -- re-grant super admin to whoever next registers it.
    DELETE FROM public.super_admins WHERE lower(email) = lower(_email);
    GET DIAGNOSTICS v_admin = ROW_COUNT;

    -- Failed sign-in attempts against the subject's address. Rows that
    -- resolved to their account cascade via `user_id`; these are the ones that
    -- did not — attempts made before they registered, or against a variant
    -- that matched no profile — which keep the address and nothing else.
    DELETE FROM public.failed_login_attempts
     WHERE user_id IS NULL AND lower(email_attempted) = lower(_email);
    GET DIAGNOSTICS v_fla = ROW_COUNT;
  END IF;

  -- `data` embeds the user id and up to 500 characters of what they wrote, so
  -- the row goes rather than being anonymised.
  DELETE FROM public.flagged_content WHERE data ->> 'user_id' = _user_id::text;
  GET DIAGNOSTICS v_flag = ROW_COUNT;

  RETURN jsonb_build_object(
    'bug_reports',      v_bug,
    'invitations',      v_inv,
    'super_admins',     v_admin,
    'flagged_content',  v_flag,
    'failed_login_attempts', v_fla,
    -- FALSE means the email-keyed rows were not touched at all, which the
    -- caller must report as an incomplete erasure rather than a clean one.
    'email_checked',    _email IS NOT NULL,
    'screenshot_paths', to_jsonb(v_paths)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.erase_user_unlinked_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_user_unlinked_data(uuid, text) TO postgres, service_role;
