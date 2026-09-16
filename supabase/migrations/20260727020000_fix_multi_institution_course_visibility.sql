-- Make `courses` visibility work for users who belong to two institutions.
--
-- `user_institutions` is many-to-many and carries a per-institution role, but
-- the courses SELECT policy (last written in 20260401000000) collapsed the
-- caller to a single institution:
--
--   institution_id = get_user_institution_id(auth.uid())
--   AND (is_admin(auth.uid()) OR is_course_instructor(id, auth.uid())
--        OR user_has_class_course_access(id, auth.uid()))
--
-- Two separate defects:
--
--   1. get_user_institution_id() is `SELECT institution_id FROM
--      user_institutions WHERE user_id = _user_id LIMIT 1` — no ORDER BY, so
--      it returns an arbitrary one of the caller's institutions. A student
--      enrolled at both A and B could only ever see courses from whichever
--      row Postgres returned first; in the other institution the class list
--      rendered (classes uses user_belongs_to_institution) but every course
--      query came back empty.
--
--   2. is_admin() is true if the caller is an admin of ANY institution. An
--      admin at A who is merely a student at B was therefore handed the whole
--      course catalogue of whichever institution (1) happened to pick.
--
-- Both are replaced with the per-institution helpers this schema already uses
-- elsewhere (classes, offerings, institutions): user_belongs_to_institution()
-- and is_institution_admin(), each evaluated against THIS row's
-- institution_id. Single-institution users are unaffected — for them the old
-- and new expressions agree.

DROP POLICY IF EXISTS "Users can view courses in their institution" ON public.courses;

CREATE POLICY "Users can view courses in their institution"
ON public.courses FOR SELECT
USING (
  is_super_admin(auth.uid())
  OR (
    user_belongs_to_institution(auth.uid(), institution_id)
    AND (
      is_institution_admin(auth.uid(), institution_id)
      OR is_course_instructor(id, auth.uid())
      OR user_has_class_course_access(id, auth.uid())
    )
  )
);

-- Leave the two legacy helpers in place (app code still calls is_admin() as a
-- coarse "admin somewhere" check) but mark them, so the next policy author
-- doesn't reach for them by accident.
COMMENT ON FUNCTION public.get_user_institution_id(uuid) IS
  'DEPRECATED for authorization: returns an ARBITRARY single institution '
  '(LIMIT 1, no ORDER BY) and is wrong for users in more than one. Use '
  'user_belongs_to_institution(user, institution) / get_user_institution_ids(user).';

COMMENT ON FUNCTION public.is_admin(uuid) IS
  'DEPRECATED for authorization: true if the user is an admin of ANY '
  'institution. Use is_institution_admin(user, institution) to scope the check '
  'to the institution owning the row.';
