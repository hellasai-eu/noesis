-- Let the people who manage a course resolve each other's names.
--
-- `profiles` is SELECT-able for yourself (20251206101851), for admins of your
-- institution (20251224115023), and for instructors reading students they
-- teach (20260416000000). Nothing covers the sideways direction: one
-- instructor cannot read a co-instructor's profile. So every Author column
-- rendered "Unknown" for anything a colleague authored — and unlike the
-- missing-name case (#1257), there is no row to fall back to an email from.
-- RLS filters rather than errors, so the UI cannot tell "this profile is
-- hidden from you" apart from "this person has no name".
--
-- ============================================================
-- The relationship
-- ============================================================
--
-- An instructor may read the profile of anyone who manages a course they
-- instruct. "Manages a course" is the set the content-write policies already
-- use for it (20251206101851): its `course_instructors` rows, plus the admins
-- of the institution that owns it, who may create and edit content in every
-- course there and therefore appear as authors — restricted, on both sides,
-- to people whose membership of that institution is not suspended.
--
-- That is exactly the group an instructor already collaborates with on that
-- course, and no wider: not students, not instructors of other courses, not
-- anyone outside the institution. The admin direction is the only genuinely
-- new exposure — an instructor learns the name and email of their own
-- institution's admins, who can already read every profile in it.
--
-- SELECT only. Nothing here grants INSERT or UPDATE.
--
-- ============================================================
-- Why the viewer is NOT a parameter
-- ============================================================
--
-- Every SECURITY DEFINER function in `public` is reachable over PostgREST as
-- an rpc. One that took (_viewer, _target) would answer questions about other
-- people — hand it any two ids and it reports whether those two work together,
-- under definer privileges with no policy in the way. Reading the caller from
-- `auth.uid()` costs the one call site nothing and keeps the boolean about the
-- person asking. Same reasoning as `instructor_teaches_student`
-- (20260903150000).

-- The policy first: it depends on the function, and would block a re-run that
-- has to drop an earlier draft.
DROP POLICY IF EXISTS "Course managers can view each other's profiles" ON public.profiles;
DROP FUNCTION IF EXISTS public.shares_course_management(uuid, uuid);

-- SECURITY DEFINER is required, not stylistic: a policy body is subject to the
-- RLS of every table it reads, and `course_instructors` / `user_institutions`
-- are both RLS-protected. An inline EXISTS would see only the rows the viewer
-- may already read and quietly answer "no".
--
-- Suspension is honoured on BOTH sides. `is_suspended` (20260323000000)
-- preserves the role and marks the membership inactive, which is why every
-- canonical predicate — `is_institution_admin`, `user_belongs_to_institution`,
-- `get_user_role_in_institution` — excludes those rows. A suspended person
-- manages nothing:
--
--   * a suspended CALLER resolves nobody, even though `course_instructors`
--     still carries their assignment (suspension keeps the assignment and
--     removes the power, the same rule `reset-open-question-progress` applies);
--   * a suspended TARGET is resolved by nobody, admin or instructor alike.
--
-- Requiring an active membership on both sides also pins the pair to the
-- institution that owns the course, so this can never reach across one.
CREATE OR REPLACE FUNCTION public.shares_course_management(_target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    -- A course the caller instructs…
    FROM course_instructors mine
    JOIN courses c
      ON c.id = mine.course_id
    -- …with the caller an active member of the institution that owns it…
    JOIN user_institutions caller_ui
      ON caller_ui.institution_id = c.institution_id
     AND caller_ui.user_id = auth.uid()
     AND NOT caller_ui.is_suspended
    -- …and the target an active member of that same institution…
    JOIN user_institutions target_ui
      ON target_ui.institution_id = c.institution_id
     AND target_ui.user_id = _target
     AND NOT target_ui.is_suspended
    WHERE mine.user_id = auth.uid()
      AND (
        -- …who either instructs that course as well…
        EXISTS (
          SELECT 1
          FROM course_instructors theirs
          WHERE theirs.course_id = mine.course_id
            AND theirs.user_id = _target
        )
        -- …or administers the institution that owns it.
        OR target_ui.role = 'admin'
      )
  )
$$;

COMMENT ON FUNCTION public.shares_course_management(uuid) IS
  'True when the CALLER instructs a course that _target also manages — as a '
  'course instructor, or as an admin of the owning institution — and both '
  'hold an unsuspended membership of the institution that owns it. The caller '
  'is read from auth.uid() rather than taken as an argument, so the rpc '
  'cannot be asked about anybody else. Used by the profiles SELECT policy so '
  'course managers can resolve each other''s names in Author columns.';

-- Supabase grants EXECUTE on new public functions to anon/authenticated/
-- service_role by default privilege, so REVOKE FROM PUBLIC alone leaves anon
-- holding it. anon has no auth.uid(), so the function can only ever answer
-- false for them — revoked anyway rather than relying on that.
REVOKE ALL ON FUNCTION public.shares_course_management(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shares_course_management(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.shares_course_management(uuid) TO authenticated;

-- ============================================================
-- The policy
-- ============================================================
--
-- Permissive, so it adds to the existing policies rather than replacing any.
CREATE POLICY "Course managers can view each other's profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (shares_course_management(user_id));

-- `course_instructors` is keyed (course_id, user_id) with an index on user_id,
-- and `user_institutions` is UNIQUE (user_id, institution_id) — so every join
-- is an index lookup seeded by the caller's own rows. No new index.
