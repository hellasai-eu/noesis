-- Bind `course_notes.author_id` to the authenticated writer.
--
-- 20260831120000 authorised writes by course alone, leaving `author_id` a
-- caller-controlled field. That is only cosmetic until you notice what reads
-- it: the per-user GDPR export in supabase/functions/export-data selects
-- `course_notes` by `author_id` with the service role, and derives the section
-- it files them under from the note's own course — never from the subject's
-- memberships. So a manager of course A could insert a note attributed to a
-- user who has no relationship to course A or its institution, and that user's
-- next subject access request would hand them the note's title, description
-- and file name from a tenant they do not belong to.
--
-- Fixed at the write, not at the read. Dropping `author_id` from the export
-- would close the disclosure but also lose the attribution a real author is
-- entitled to receive, and any future reader of the column would inherit the
-- same trap.
--
-- A separate migration rather than an edit to 20260831120000, because that file
-- has already been applied on this PR's Supabase preview branch: branches apply
-- migrations incrementally, so an edit to an applied file silently never runs
-- there and only a local `db reset` would appear to prove it fixed.
--
-- NULL stays allowed: `author_id` is `ON DELETE SET NULL`, so an erased author
-- must not make their notes unwritable. The service role bypasses RLS entirely,
-- which is what keeps seeds, tests and the export unaffected.
--
-- NOTE: public.class_announcements carries the identical shape — a caller-set
-- `author_id`, exported the same way. It is deliberately left alone here rather
-- than widened into this change; it predates this table and deserves its own
-- migration and its own tests.

DROP POLICY IF EXISTS "Managers manage course notes" ON public.course_notes;

CREATE POLICY "Managers manage course notes"
  ON public.course_notes
  FOR ALL
  USING (public.can_manage_course_notes(course_id))
  WITH CHECK (
    public.can_manage_course_notes(course_id)
    AND (author_id IS NULL OR author_id = auth.uid())
  );
