-- Issue #1104 (part of #1097): section-scope graded test scans, and close the
-- storage policies behind them.
--
-- `graded_tests` rows carry a photograph of a minor's handwritten paper, the
-- OCR of it, and their name as read off the page —
-- 20260726000000_complete_user_erasure.sql calls this out when moving
-- `graded_tests.student_id` from SET NULL to CASCADE: "the scan, OCR text and
-- student name are the subject's". It is the most directly identifying
-- artefact in the schema.
--
-- ============================================================
-- The two layers, and which one was worse
-- ============================================================
--
-- Row level (`20251212071817:60`, `:78`) authorised
-- `ui.role = 'admin' OR is_course_instructor(c.id, auth.uid())` — course-wide,
-- so a section-restricted instructor read every other section's papers. That
-- is the bug #1104 describes.
--
-- Storage level (`:125`, `:137`, `:149`) was worse than the issue anticipated,
-- and the live database confirmed it:
--
--   bucket_id = 'graded-tests' AND (
--     is_super_admin(auth.uid())
--     OR EXISTS (SELECT 1 FROM user_institutions ui
--                WHERE ui.user_id = auth.uid()
--                AND (ui.role = 'admin' OR ui.role = 'instructor'))
--   )
--
-- No course. No section. No institution — not even a requirement that the
-- reader's institution match the file's. Any user holding an instructor row in
-- *any* institution could read, overwrite and delete every scan in the bucket,
-- across every tenant. That makes the row-level policy decorative, exactly as
-- the issue predicted, and it is a cross-institution hole rather than a
-- cross-section one.
--
-- One thing this migration deliberately does NOT change: students still have
-- no storage access at all. They can read their own `graded_tests` row but not
-- fetch the image of their own paper. That asymmetry predates this issue, and
-- granting it here would be a widening in the middle of a tightening — worth
-- recording, not worth smuggling in. Note in particular that the rule below
-- must not become "anyone may act under their own prefix": that would let a
-- student upload a forged scan or delete their own marked paper.
--
-- ============================================================
-- How the section is resolved
-- ============================================================
--
-- `graded_tests` has `course_id` and `student_id` and — confirmed against the
-- live schema — no `offering_id` and no `class_id`. So `can_manage_offering`
-- is unavailable and the predicate resolves the student's class through
-- `class_enrollments`, which is what `instructor_can_access_student` (added by
-- the quiz-results migration in this epic) already does.
--
-- `student_id` is nullable: a scan that has been uploaded but not yet matched
-- to a student. Those rows have no section to check, so they stay visible to
-- any instructor of the course — a scan in the marking queue is the
-- instructor's own working set, and there is no student identity to protect it
-- on behalf of yet. It is called out here because it is a deliberate hole in
-- an otherwise total rule, and because matching a scan to a student is what
-- closes it.
--
-- Storage has neither column, only the object name — and the name has to carry
-- enough to answer the same question, or the storage layer stays looser than
-- the row layer and the row policy goes on being decorative.
--
-- Today's layout is `<user id>/<file>`: the prefix `delete-user/erasure.ts`
-- walks (`USER_PREFIXED_BUCKETS`) and the retention config records
-- (20260726000000:138). The student it names is not sufficient on its own. A
-- scan belongs to one *course*, and a policy that asks only "may this user
-- reach this student anywhere?" authorises the Maths teacher to open the same
-- student's Physics paper — a cross-course leak of the kind this epic exists
-- to close, and one the row-level policy does not have because `graded_tests`
-- carries `course_id`.
--
-- So the layout gains a second segment: `<student id>/<course id>/<file>`. The
-- first segment is unchanged, which is what matters — the retention description
-- stays true, and erasure still finds everything under `<user id>/`: its
-- `listAll` recurses into folders up to MAX_LIST_DEPTH = 3
-- (delete-user/erasure.ts:39, :99), so one extra level is well inside the walk
-- it already performs. Checked, because a layout change that quietly stranded a
-- minor's paper outside the erasure path would be a worse bug than the one this
-- migration fixes. The second segment lets the policy name the course and apply
-- exactly the rule the row policy applies. Anything that is not two well-formed uuids is denied, so a
-- malformed name fails closed rather than raising on the cast.
--
-- Defining a layout here rather than inheriting one is possible because the
-- feature is dormant: `export-data` reads the tables and `delete-user` walks
-- the prefix, but there is no upload path in the frontend or in any edge
-- function, so the bucket is empty and no object has to be migrated. Whatever
-- eventually writes these files has to follow the convention; the policies
-- refuse anything that does not, which is the enforcement rather than a
-- comment asking nicely.

-- ============================================================
-- Helper: reach a student's scan without naming a course
-- ============================================================

CREATE OR REPLACE FUNCTION public.instructor_can_access_graded_test_scan(
  _object_name text,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH parsed AS (
    SELECT
      CASE
        WHEN split_part(_object_name, '/', 1)
             ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN split_part(_object_name, '/', 1)::uuid
      END AS student_id,
      CASE
        WHEN split_part(_object_name, '/', 2)
             ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN split_part(_object_name, '/', 2)::uuid
      END AS course_id
  )
  SELECT
    p.student_id IS NOT NULL
    AND p.course_id IS NOT NULL
    -- Exactly the rule the `graded_tests` row policy applies, on the course the
    -- object names. Note what this does NOT admit: the student themselves.
    -- These policies cover upload and delete as well as read, so keying on the
    -- prefix alone would let a student add a forged scan or remove their own
    -- marked paper.
    AND instructor_can_access_student(p.course_id, p.student_id, _user_id)
  FROM parsed p
$$;

COMMENT ON FUNCTION public.instructor_can_access_graded_test_scan(text, uuid) IS
  'True when the user may reach the graded-tests object named _object_name. '
  'Objects are laid out `<student id>/<course id>/<file>`: the first segment is '
  'the prefix erasure.ts walks, the second names the course so the same rule '
  'the graded_tests row policy applies can be applied here. Denies any name '
  'that is not two well-formed uuids. Staff only by design — it also gates '
  'upload and delete, so it must never admit the subject themselves (#1104).';

-- ============================================================
-- graded_tests
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can manage graded tests" ON public.graded_tests;
CREATE POLICY "Admins and instructors can manage graded tests"
ON public.graded_tests
FOR ALL
USING (
  CASE
    WHEN student_id IS NULL THEN is_course_instructor(course_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = graded_tests.course_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
    ELSE instructor_can_access_student(course_id, student_id, auth.uid())
  END
)
WITH CHECK (
  CASE
    WHEN student_id IS NULL THEN is_course_instructor(course_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM courses c
        WHERE c.id = graded_tests.course_id
        AND is_institution_admin(auth.uid(), c.institution_id)
      )
    ELSE instructor_can_access_student(course_id, student_id, auth.uid())
  END
);

-- ============================================================
-- graded_test_questions — via the parent scan
-- ============================================================
-- Self-sufficient rather than inheriting the parent's visibility: a boundary
-- enforced only by another table's policy is what #1101 turned out to rest on.

DROP POLICY IF EXISTS "Admins and instructors can manage test questions" ON public.graded_test_questions;
CREATE POLICY "Admins and instructors can manage test questions"
ON public.graded_test_questions
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM graded_tests gt
    WHERE gt.id = graded_test_questions.graded_test_id
    AND CASE
      WHEN gt.student_id IS NULL THEN is_course_instructor(gt.course_id, auth.uid())
        OR EXISTS (
          SELECT 1 FROM courses c
          WHERE c.id = gt.course_id
          AND is_institution_admin(auth.uid(), c.institution_id)
        )
      ELSE instructor_can_access_student(gt.course_id, gt.student_id, auth.uid())
    END
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM graded_tests gt
    WHERE gt.id = graded_test_questions.graded_test_id
    AND CASE
      WHEN gt.student_id IS NULL THEN is_course_instructor(gt.course_id, auth.uid())
        OR EXISTS (
          SELECT 1 FROM courses c
          WHERE c.id = gt.course_id
          AND is_institution_admin(auth.uid(), c.institution_id)
        )
      ELSE instructor_can_access_student(gt.course_id, gt.student_id, auth.uid())
    END
  )
);

-- ============================================================
-- storage.objects — the scans themselves
-- ============================================================

DROP POLICY IF EXISTS "Admins and instructors can view test files" ON storage.objects;
CREATE POLICY "Admins and instructors can view test files"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'graded-tests'
  AND instructor_can_access_graded_test_scan(name, auth.uid())
);

DROP POLICY IF EXISTS "Admins and instructors can upload test files" ON storage.objects;
CREATE POLICY "Admins and instructors can upload test files"
ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'graded-tests'
  AND instructor_can_access_graded_test_scan(name, auth.uid())
);

DROP POLICY IF EXISTS "Admins and instructors can delete test files" ON storage.objects;
CREATE POLICY "Admins and instructors can delete test files"
ON storage.objects
FOR DELETE
USING (
  bucket_id = 'graded-tests'
  AND instructor_can_access_graded_test_scan(name, auth.uid())
);
