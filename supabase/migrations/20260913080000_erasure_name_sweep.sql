-- Tooling for the erasure "manual step": instructor-typed student names.
--
-- `docs/compliance/user-erasure.md` requires that an erasure request is only
-- confirmed complete after `graded_tests.student_name` and
-- `student_evaluations.student_name` have been searched for the subject's name
-- and the matches cleared. Until now that step existed only as a sentence in
-- the document — nothing ran the search, and nothing in
-- `public.user_data_footprint()` would catch it being skipped. An erasure
-- could therefore be reported complete while rows carrying the subject's name
-- remained.
--
-- This migration makes the step detectable:
--
--   1. `public.normalize_person_name()` — case-, accent- and
--      punctuation-insensitive normalisation, so «Παπαδόπουλος» matches
--      «παπαδοπουλος» and "Γ. Παπαδόπουλος" tokenises usefully.
--   2. `public.find_erasure_name_matches(_name)` — every row in the two
--      free-text columns whose typed name matches the subject's. Called by
--      `delete-user` AFTER the auth user is deleted, so rows that cascaded
--      with the account are already gone and only the leftovers are listed.
--   3. `user_reference_map()` gains the two columns under a new kind, 'name'.
--      `fk_action` stays NULL: no foreign key can enforce this.
--   4. `user_data_footprint()` gains `_name` and counts the same matches, so
--      the proof query itself now reports the leftovers (-1 when called
--      without a name, following the `_email` convention).
--
-- WHY DETECT RATHER THAN DELETE. A typed name is not a key. A surviving match
-- is either (a) an unlinked row that really is the subject's — clear it — or
-- (b) a row belonging to a DIFFERENT student who shares the name, which must
-- not be touched. `student_evaluations.user_id` is NOT NULL and cascades, so
-- every match there belongs to another live account; `graded_tests` matches
-- may be unattributed scans. Only a person can tell these apart, so the
-- matches are returned for review, never auto-cleared — and a footprint count
-- that stays above zero after review means "attested as another person's",
-- not "erasure failed". docs/compliance/user-erasure.md carries the procedure.
--
-- MATCHER LIMITS, documented rather than hidden: matching is token-based with
-- two-way prefixes ("Γ. Παπαδόπουλος" ~ "Γιώργος Παπαδόπουλος"), but it cannot
-- see Greek declension («Παπαδοπούλου» as the genitive of «Παπαδόπουλος»),
-- transliteration ("Papadopoulos"), or nicknames. The reviewer's eye is still
-- part of the procedure; the tool replaces the unassisted search, not the
-- judgement.

-- ---------------------------------------------------------------------------
-- 1. Normalisation
-- ---------------------------------------------------------------------------

-- lower → strip Greek tonos/dialytika and fold final sigma → punctuation to
-- spaces → collapse whitespace. No unaccent extension: the mapping this needs
-- is small and Greek-specific, and an IMMUTABLE translate() keeps the function
-- usable in any environment without an extension prerequisite.
CREATE OR REPLACE FUNCTION public.normalize_person_name(_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        translate(lower(coalesce(_raw, '')), 'άέήίόύώϊϋΐΰς', 'αεηιουωιυιυσ'),
        -- A POSITIVE punctuation class, not [^[:alnum:]]: under a C ctype the
        -- alnum class is ASCII-only and would have erased the Greek letters
        -- themselves. Punctuation is punctuation in every locale.
        '[[:punct:]]', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION public.normalize_person_name(text) IS
  'Case/accent/punctuation-insensitive form of a person name, for the erasure name sweep. Greek tonos and final sigma folded; not a transliterator.';

-- ---------------------------------------------------------------------------
-- 2. The search
-- ---------------------------------------------------------------------------

-- Every free-text-name row that plausibly refers to the subject. A row
-- matches when every token of the subject's normalised name (2+ characters)
-- prefix-matches some token of the typed name, in either direction — so an
-- initial or a truncation on either side still matches. Prefix comparison is
-- done with left(), not LIKE: a typed name is user input and must not become
-- a pattern (the same reasoning that put erase_user_unlinked_data in SQL).
--
-- A name that yields NO usable token ("Γ. Π.", empty, punctuation only) is an
-- ERROR (22023), not an empty result: an empty result means "searched, found
-- nothing", and a degenerate name was never searched. Callers translate the
-- error into "not checked" — delete-user into a `name` warning, the footprint
-- into -1 — so a subject with an initials-only profile name cannot produce a
-- silently clean sweep.
CREATE OR REPLACE FUNCTION public.find_erasure_name_matches(_name text)
RETURNS TABLE (
  source_table   text,
  row_id         uuid,
  student_name   text,
  linked_user_id uuid,
  course_id      uuid,
  created_at     timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_toks text[];
BEGIN
  SELECT array_agg(t) INTO v_toks
    FROM unnest(string_to_array(public.normalize_person_name(_name), ' ')) AS t
   WHERE length(t) >= 2;

  IF v_toks IS NULL THEN
    RAISE EXCEPTION 'name yields no usable tokens (2+ characters): free-text name columns cannot be searched'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT 'graded_tests'::text AS source_table, g.id AS row_id,
           g.student_name, g.student_id AS linked_user_id,
           g.course_id, g.created_at
      FROM public.graded_tests g
     WHERE g.student_name IS NOT NULL
    UNION ALL
    SELECT 'student_evaluations', e.id, e.student_name, e.user_id,
           e.course_id, e.created_at
      FROM public.student_evaluations e
     WHERE e.student_name IS NOT NULL
  )
  SELECT c.*
    FROM candidates c
   WHERE NOT EXISTS (
       SELECT 1
         FROM unnest(v_toks) AS st
        WHERE NOT EXISTS (
          SELECT 1
            FROM unnest(string_to_array(public.normalize_person_name(c.student_name), ' ')) AS nt
           WHERE nt <> '' AND (left(nt, length(st)) = st OR left(st, length(nt)) = nt)
        )
     );
END;
$$;

COMMENT ON FUNCTION public.find_erasure_name_matches(text) IS
  'Rows in graded_tests.student_name / student_evaluations.student_name matching a subject''s name, for post-erasure review. Detection only — see the header of 20260913080000 for why nothing is auto-cleared.';

-- Reads names across every tenant: service role only, like the footprint.
REVOKE ALL ON FUNCTION public.normalize_person_name(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_erasure_name_matches(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_person_name(text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.find_erasure_name_matches(text) TO postgres, service_role;

-- ---------------------------------------------------------------------------
-- 3. The map
-- ---------------------------------------------------------------------------

-- Replaces the whole function, rebased on 20260909000000 — the newest
-- definition — because that is how this map has always been edited. New kind:
--
--   kind = 'name'   free-text column that may hold the subject's typed name;
--                   no key, no FK — swept by find_erasure_name_matches() and
--                   reviewed by a person.
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

-- ---------------------------------------------------------------------------
-- 4. The sweep
-- ---------------------------------------------------------------------------

-- Same function as 20260726000000 plus the `_name` argument and the 'name'
-- kind. Dropped rather than replaced: CREATE OR REPLACE with a new argument
-- would leave the old two-argument signature behind as an ambiguous overload.
DROP FUNCTION IF EXISTS public.user_data_footprint(uuid, text);

CREATE OR REPLACE FUNCTION public.user_data_footprint(
  _user_id uuid,
  _email   text DEFAULT NULL,
  _name    text DEFAULT NULL
)
RETURNS TABLE (source_table text, source_column text, match_kind text, row_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r             record;
  v_count       bigint;
  v_name_counts jsonb;
BEGIN
  -- One sweep serves every name-kind row: find_erasure_name_matches() scans
  -- both free-text columns per call, so calling it per map row would scan the
  -- tables once per row. An unusable name (22023) means "not checked", which
  -- the loop reports as -1 — the same contract as a missing email.
  IF _name IS NOT NULL THEN
    BEGIN
      SELECT coalesce(jsonb_object_agg(f.source_table, f.cnt), '{}'::jsonb)
        INTO v_name_counts
        FROM (
          SELECT m.source_table, count(*) AS cnt
            FROM public.find_erasure_name_matches(_name) m
           GROUP BY m.source_table
        ) f;
    EXCEPTION WHEN invalid_parameter_value THEN
      v_name_counts := NULL;
    END;
  END IF;

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

    ELSIF r.kind = 'name' THEN
      -- A count above zero after erasure is a REVIEW obligation, not
      -- necessarily a hole: the match may be a different student who shares
      -- the name. -1 covers both "no name given" and "name unusable" — either
      -- way these columns were not checked. See find_erasure_name_matches().
      IF v_name_counts IS NULL THEN
        v_count := -1;
      ELSE
        v_count := coalesce((v_name_counts ->> r.tbl)::bigint, 0);
      END IF;
    END IF;

    source_table  := r.tbl;
    source_column := r.col;
    match_kind    := r.kind;
    row_count     := v_count;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.user_data_footprint(uuid, text, text) IS
  'Counts every remaining reference to a user. All zero = erasure complete. -1 means "not checked" (email- or name-keyed source called without that argument). A name-kind count above zero means matches awaiting human review, which may belong to a same-named other person.';

REVOKE ALL ON FUNCTION public.user_data_footprint(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_data_footprint(uuid, text, text) TO postgres, service_role;
