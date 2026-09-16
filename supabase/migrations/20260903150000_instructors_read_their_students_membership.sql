-- Instructors could not open a student's profile at all.
--
-- `/student/:userId/profile` begins by reading the student's `user_institutions`
-- row — it needs the institution to scope every subsequent query, and the grade
-- level and joined-at date to render the header. Nothing returns that row to an
-- instructor: the SELECT policies on `user_institutions` are "your own row"
-- (20251206091421) and "admins can view memberships" (20251206103044), and no
-- third one was ever added. RLS filters rather than errors, so the page sees an
-- empty result and concludes the student does not exist — the "Student not
-- found" screen, shown to the very instructor who teaches them.
--
-- The page has an instructor branch in its access check, so the intent was
-- always that instructors reach it. The table was simply never opened to them.
--
-- ============================================================
-- The relationship
-- ============================================================
--
-- "This instructor teaches this student" is not expressible as one join, and
-- writing it inline in a policy would make it the third place in the codebase
-- with its own idea of the answer. It gets a function, which the policy below
-- and the page's own access check (via rpc) both call:
--
--   the student is enrolled as a student in a class,
--   that class has an offering of a course the caller instructs,
--   and section restrictions do not exclude that class.
--
-- `instructor_can_access_section` is the #59 semantic: no restriction rows for
-- (course, instructor) means unrestricted, which is why this is not simply an
-- intersection with `course_instructor_sections` — an unrestricted instructor
-- has no rows there, and intersecting against them denies the very people who
-- are allowed everything. (The page's access check has that bug today, and is
-- fixed alongside this migration.)
--
-- The institution is a parameter rather than something the function derives,
-- so the policy can pin the row it is deciding: a student may hold memberships
-- in more than one institution, and teaching them in one is not a reason to
-- learn that the other exists.
--
-- ============================================================
-- Why the instructor is NOT a parameter
-- ============================================================
--
-- Its siblings — `instructor_can_access_student`, `is_institution_admin` and
-- the rest — all take `_user_id`, and this function was written the same way
-- until review pointed out what that shape costs a *new* function. Every
-- SECURITY DEFINER function in `public` is reachable over PostgREST as an rpc,
-- and one that trusts a caller-supplied identity answers questions about other
-- people: hand it any two ids and it reports whether that instructor teaches
-- that student, under definer privileges, with no policy in the way. The
-- existing functions carry that already; there is no reason to add another.
--
-- Reading the caller from `auth.uid()` instead costs nothing at either call
-- site — the policy passed `auth.uid()` and the page passed its own user id —
-- and the boolean now describes only the person asking.

-- The policy goes first: on a database that applied an earlier draft of this
-- file, it depends on the three-argument function and would block the drop.
DROP POLICY IF EXISTS "Instructors can view their students' memberships" ON public.user_institutions;
DROP FUNCTION IF EXISTS public.instructor_teaches_student(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.instructor_teaches_student(
  _student_id uuid,
  _institution_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM class_enrollments ce
    JOIN classes cl
      ON cl.id = ce.class_id
      AND cl.institution_id = _institution_id
    JOIN offerings o
      ON o.class_id = ce.class_id
    JOIN course_instructors ci
      ON ci.course_id = o.course_id
      AND ci.user_id = auth.uid()
    WHERE ce.user_id = _student_id
    AND ce.role = 'student'
    AND instructor_can_access_section(o.course_id, ce.class_id, auth.uid())
  )
$$;

COMMENT ON FUNCTION public.instructor_teaches_student(uuid, uuid) IS
  'True when the CALLER instructs a course offered to a class this student '
  'sits in, within the given institution, and section restrictions do not '
  'exclude that class. The instructor is read from auth.uid() rather than '
  'taken as an argument, so the rpc cannot be asked about anybody else. One '
  'definition of "teaches", shared by the user_institutions SELECT policy and '
  'the student profile page''s access check.';

-- ============================================================
-- The policy
-- ============================================================
--
-- Permissive, so it adds to the existing two rather than replacing either.
--
-- Narrow on both axes deliberately. `role = 'student'` because what an
-- instructor needs is the student's own membership; teaching someone is no
-- reason to see which institutions a colleague belongs to, and the profile page
-- reads student rows only. The institution comes from the row itself, so a
-- second membership elsewhere stays invisible.

DROP POLICY IF EXISTS "Instructors can view their students' memberships" ON public.user_institutions;
CREATE POLICY "Instructors can view their students' memberships"
ON public.user_institutions
FOR SELECT
TO authenticated
USING (
  role = 'student'
  AND instructor_teaches_student(user_id, institution_id)
);
