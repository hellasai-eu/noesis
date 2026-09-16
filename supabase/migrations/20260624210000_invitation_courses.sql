-- Invitation-time course scoping for evaluator invites (issue #666, epic #663).
-- Evaluators are scoped to multiple courses, but the existing invitations row
-- carries only a single course_id and course_evaluators requires a real user_id
-- (which doesn't exist until the invite is accepted). A junction table bridges
-- the gap: admins persist chosen course IDs at invite time, accept-invitation
-- replays them into course_evaluators when the user signs up.
--
-- DDL is idempotent: an earlier revision of this migration shared the
-- 20260624200000 timestamp with evaluator_course_materials_rls.sql (merged from
-- main), and Supabase preview branches that ran the first revision already have
-- the table. Re-running against that state must succeed.

CREATE TABLE IF NOT EXISTS public.invitation_courses (
  invitation_id UUID NOT NULL REFERENCES public.invitations(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  PRIMARY KEY (invitation_id, course_id)
);

ALTER TABLE public.invitation_courses ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_invitation_courses_invitation
  ON public.invitation_courses(invitation_id);

-- Mirror the course_evaluators management policy: admins of the invitation's
-- institution (or super-admins) can manage rows. Cross-institution writes are
-- rejected because the course's institution must match the invitation's.
DROP POLICY IF EXISTS "Admins can manage invitation courses" ON public.invitation_courses;
CREATE POLICY "Admins can manage invitation courses"
  ON public.invitation_courses FOR ALL
  USING (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM invitations i
      JOIN courses c ON c.id = invitation_courses.course_id
      WHERE i.id = invitation_courses.invitation_id
      AND c.institution_id = i.institution_id
      AND is_institution_admin(auth.uid(), i.institution_id)
    )
  )
  WITH CHECK (
    is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM invitations i
      JOIN courses c ON c.id = invitation_courses.course_id
      WHERE i.id = invitation_courses.invitation_id
      AND c.institution_id = i.institution_id
      AND is_institution_admin(auth.uid(), i.institution_id)
    )
  );

DROP POLICY IF EXISTS "Institution members can view invitation courses" ON public.invitation_courses;
CREATE POLICY "Institution members can view invitation courses"
  ON public.invitation_courses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM invitations i
      JOIN user_institutions ui ON ui.institution_id = i.institution_id
      WHERE i.id = invitation_courses.invitation_id
      AND ui.user_id = auth.uid()
    )
  );
