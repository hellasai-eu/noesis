-- Rights-request register — GDPR Art. 12(3) deadline tracking.
--
-- The compliance reassessment's "Rights-request execution doesn't scale"
-- finding: requests arrive at the school (institution admins), execution
-- lives with super admins, and NOTHING tracks a request or its one-month
-- statutory clock. A request that is quietly forgotten looks identical to a
-- request that never existed.
--
-- This table is the register: one row per data-subject request, per
-- institution, with the deadline arithmetic in the schema so the UI cannot
-- get it wrong. Institution admins keep their own register (they are the
-- ones a parent phones); super admins see all of them.
--
-- DATA-MINIMISATION RULES, because the register is itself personal data:
--
--   * `subject_label` (the name/email as received) exists for working the
--     request, not for keeping. A trigger clears it the moment an ERASURE
--     request is marked completed — the register must not be the last place
--     the erased name survives. For the same reason `delete-user` clears it
--     on every request row linked to an account being deleted (the
--     erase_user_unlinked_data extension below).
--   * `subject_user_id` is ON DELETE SET NULL: the register survives the
--     subject's erasure as accountability evidence (Art. 5(2)) — dates, type,
--     outcome — with the identity gone.
--   * No DELETE policy for anyone: evidence is not deletable from the app.
--
-- What this deliberately does NOT do: notify. Overdue requests surface in
-- the UI (the register page sorts by effective due date and badges overdue
-- rows); a scheduled reminder can come later without touching the schema.

CREATE TABLE public.rights_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id   uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,

  -- Who the request is about. The label is what the school received ("mother
  -- of Γιώργος Π., 2nd grade"); the account link is optional but is what lets
  -- export/erasure execution and the subject's own export find the row.
  subject_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  subject_label    text CHECK (char_length(subject_label) <= 200),

  request_type     text NOT NULL CHECK (request_type IN
                     ('access', 'export', 'erasure', 'rectification', 'restriction', 'objection')),
  details          text CHECK (char_length(details) <= 2000),

  -- The clock. Art. 12(3): respond within one month of receipt, extendable by
  -- two further months for complex/numerous requests, informing the subject
  -- of the extension and its reasons within the first month. `due_at` is
  -- GENERATED so no client can set a different clock; the only lawful change
  -- is the explicit extension below.
  received_at      date NOT NULL DEFAULT current_date,
  due_at           date NOT NULL GENERATED ALWAYS AS ((received_at + interval '1 month')::date) STORED,
  extended_due_at  date,
  extension_reason text CHECK (char_length(extension_reason) <= 1000),
  CONSTRAINT rights_requests_extension_within_art12
    CHECK (extended_due_at IS NULL
           OR (btrim(coalesce(extension_reason, '')) <> ''
               AND extended_due_at > due_at
               AND extended_due_at <= (received_at + interval '3 months')::date)),

  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'refused')),
  -- What was done (or why refused — Art. 12(4) requires stating the reasons
  -- and the complaint routes). Required whenever the request leaves 'open'.
  resolution_note  text CHECK (char_length(resolution_note) <= 2000),
  CONSTRAINT rights_requests_resolution_stated
    CHECK (status = 'open' OR btrim(coalesce(resolution_note, '')) <> ''),
  closed_at        timestamptz,
  closed_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rights_requests_institution ON public.rights_requests (institution_id, status, due_at);
CREATE INDEX idx_rights_requests_subject ON public.rights_requests (subject_user_id);

COMMENT ON TABLE public.rights_requests IS
  'Register of GDPR data-subject requests, one row per request per institution. Deadline arithmetic (Art. 12(3)) is enforced here; subject_label is scrubbed on erasure completion and on account deletion. See docs/compliance/user-erasure.md.';

-- Register integrity, in the schema rather than the UI:
--   * `received_at` is immutable after recording — `due_at` is generated from
--     it, so an editable receipt date would be an editable deadline. A
--     mis-recorded date is corrected by refusing the row (with a note saying
--     so) and recording it again; the register keeps both, which is the point.
--   * provenance (`institution_id`, `created_by`, `created_at`) is frozen on
--     update rather than trusted from the client.
--   * `closed_at` / `closed_by` are stamped by this trigger on the transition
--     out of 'open' — client-supplied values are overwritten, an already
--     closed row keeps its original stamp, and reopening clears it.
--   * completing an ERASURE request clears the label; the row keeps proving a
--     request was handled without re-stating who it erased.
CREATE OR REPLACE FUNCTION public.rights_requests_maintain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.received_at <> OLD.received_at THEN
      RAISE EXCEPTION 'received_at is immutable: the Art. 12(3) clock runs from receipt. Refuse the mis-recorded request and record it again.';
    END IF;
    NEW.institution_id := OLD.institution_id;
    NEW.created_by     := OLD.created_by;
    NEW.created_at     := OLD.created_at;
    -- A closed row keeps its type: recharacterising a COMPLETED erasure as
    -- something else would dodge the label scrub below and let the erased
    -- name be written back. Reopen first if the type is genuinely wrong.
    IF OLD.status <> 'open' THEN
      NEW.request_type := OLD.request_type;
    END IF;
  END IF;

  IF NEW.status <> 'open' THEN
    IF TG_OP = 'INSERT' OR OLD.status = 'open' THEN
      NEW.closed_at := now();
      NEW.closed_by := auth.uid();
    ELSE
      NEW.closed_at := OLD.closed_at;
      NEW.closed_by := OLD.closed_by;
    END IF;
    IF NEW.status = 'completed' AND NEW.request_type = 'erasure' THEN
      NEW.subject_label := NULL;
    END IF;
  ELSE
    NEW.closed_at := NULL;
    NEW.closed_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rights_requests_maintain_trg
  BEFORE INSERT OR UPDATE ON public.rights_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.rights_requests_maintain();

CREATE TRIGGER update_rights_requests_updated_at
  BEFORE UPDATE ON public.rights_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- RLS: the register belongs to the institution's admins
-- ---------------------------------------------------------------------------

ALTER TABLE public.rights_requests ENABLE ROW LEVEL SECURITY;

-- Institution admins manage their own institution's register; super admins
-- see and manage all of them. Students and instructors have no access — a
-- subject asks their school, per the privacy policy; the register is the
-- school's worksheet, and one register row can name ANOTHER subject (a
-- parent's request about a sibling), so subject read access is not simply
-- "rows where subject_user_id = auth.uid()".
CREATE POLICY "Institution admins manage their rights requests"
  ON public.rights_requests
  FOR SELECT
  USING (
    public.is_institution_admin(auth.uid(), institution_id)
    OR public.is_super_admin(auth.uid())
  );

-- A linked account must belong to the register's own institution: a request
-- naming another school's student would surface in THAT subject's Art. 15
-- export attributed to an institution they may have no relation with. The
-- check reads user_institutions directly rather than through the authz
-- helpers, because a SUSPENDED membership must still qualify — a suspended
-- or about-to-leave student is exactly who rights requests are about.
CREATE POLICY "Institution admins record rights requests"
  ON public.rights_requests
  FOR INSERT
  WITH CHECK (
    (public.is_institution_admin(auth.uid(), institution_id)
     OR public.is_super_admin(auth.uid()))
    AND created_by = auth.uid()
    AND (subject_user_id IS NULL
         OR EXISTS (SELECT 1 FROM public.user_institutions ui
                     WHERE ui.user_id = subject_user_id
                       AND ui.institution_id = rights_requests.institution_id))
  );

CREATE POLICY "Institution admins update their rights requests"
  ON public.rights_requests
  FOR UPDATE
  USING (
    public.is_institution_admin(auth.uid(), institution_id)
    OR public.is_super_admin(auth.uid())
  )
  WITH CHECK (
    (public.is_institution_admin(auth.uid(), institution_id)
     OR public.is_super_admin(auth.uid()))
    AND (subject_user_id IS NULL
         OR EXISTS (SELECT 1 FROM public.user_institutions ui
                     WHERE ui.user_id = subject_user_id
                       AND ui.institution_id = rights_requests.institution_id))
  );

-- No DELETE policy: the register is accountability evidence (Art. 5(2)).

-- ---------------------------------------------------------------------------
-- Erasure integration
-- ---------------------------------------------------------------------------

-- Same function as 20260726010000 plus one step: when an account is being
-- deleted, clear `subject_label` on every register row linked to it. The FK
-- nulls `subject_user_id` when the auth user goes; the label would otherwise
-- keep the name on rows the account link no longer explains (e.g. a completed
-- ACCESS request from last term). Runs before auth deletion, like the rest.
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
  v_paths  text[] := '{}';
  v_bug    integer := 0;
  v_inv    integer := 0;
  v_admin  integer := 0;
  v_flag   integer := 0;
  v_rights integer := 0;
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
  END IF;

  -- `data` embeds the user id and up to 500 characters of what they wrote, so
  -- the row goes rather than being anonymised.
  DELETE FROM public.flagged_content WHERE data ->> 'user_id' = _user_id::text;
  GET DIAGNOSTICS v_flag = ROW_COUNT;

  -- The rights-request register keeps its rows (accountability evidence) but
  -- not the subject's name: the FK is about to null subject_user_id, and the
  -- free-text label must go with it.
  UPDATE public.rights_requests
     SET subject_label = NULL
   WHERE subject_user_id = _user_id
     AND subject_label IS NOT NULL;
  GET DIAGNOSTICS v_rights = ROW_COUNT;

  RETURN jsonb_build_object(
    'bug_reports',      v_bug,
    'invitations',      v_inv,
    'super_admins',     v_admin,
    'flagged_content',  v_flag,
    'rights_requests',  v_rights,
    -- FALSE means the email-keyed rows were not touched at all, which the
    -- caller must report as an incomplete erasure rather than a clean one.
    'email_checked',    _email IS NOT NULL,
    'screenshot_paths', to_jsonb(v_paths)
  );
END;
$$;

COMMENT ON FUNCTION public.erase_user_unlinked_data(uuid, text) IS
  'Erases the personal data no foreign key can reach (email-keyed rows, flagged_content payloads, rights_requests labels) and returns the storage paths the caller must delete. Called by the delete-user edge function before auth.admin.deleteUser.';

REVOKE ALL ON FUNCTION public.erase_user_unlinked_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erase_user_unlinked_data(uuid, text) TO postgres, service_role;

-- ---------------------------------------------------------------------------
-- Erasure registry
-- ---------------------------------------------------------------------------

-- Replaces the whole function, rebased on 20260913080000 — the newest
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
