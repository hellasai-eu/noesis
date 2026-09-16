-- Finish unblocking instructor/admin messages in student chat sessions.
-- PR #312 added 'instructor' to the role CHECK but still blocks two paths:
--   1. socratic-chat edge function logs moderation events with role='system' and
--      hits the CHECK constraint, which now needs 'system' too.
--   2. The instructor INSERT policy only authorizes course instructors via
--      is_course_instructor(); institution admins viewing Student360 fail the
--      WITH CHECK and see "new row violates row-level security policy".
--
-- Security fix: restrict the user INSERT policies to role='user' so that
-- authenticated students cannot spoof 'instructor' or 'system' role values.

-- ============================================================
-- open_question_chats
-- ============================================================

ALTER TABLE public.open_question_chats
  DROP CONSTRAINT IF EXISTS open_question_chats_role_check;

ALTER TABLE public.open_question_chats
  ADD CONSTRAINT open_question_chats_role_check
  CHECK (role IN ('user', 'assistant', 'instructor', 'system'));

-- Restrict user inserts to role='user' only; edge functions use service role key
-- and bypass RLS, so 'assistant'/'system'/'instructor' must not be insertable by users.
DROP POLICY IF EXISTS "Users can insert their own chat messages" ON public.open_question_chats;
CREATE POLICY "Users can insert their own chat messages"
ON public.open_question_chats
FOR INSERT
WITH CHECK (auth.uid() = user_id AND role = 'user');

DROP POLICY IF EXISTS "Instructors can insert instructor messages" ON public.open_question_chats;
CREATE POLICY "Instructors can insert instructor messages"
ON public.open_question_chats
FOR INSERT
WITH CHECK (
  role = 'instructor'
  AND sender_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.courses c
    WHERE c.id = open_question_chats.course_id
    AND (
      public.is_course_instructor(c.id, auth.uid())
      OR public.is_institution_admin(auth.uid(), c.institution_id)
    )
  )
);

-- ============================================================
-- study_session_messages
-- ============================================================

-- Split the FOR ALL policy into SELECT (keep permissive) + INSERT (restrict role).
-- This closes the same spoofing hole as open_question_chats above.
DROP POLICY IF EXISTS "Users can manage their own messages" ON public.study_session_messages;
CREATE POLICY "Users can view their own messages"
ON public.study_session_messages
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.student_study_progress p
    WHERE p.id = study_session_messages.progress_id
    AND p.user_id = auth.uid()
  )
);
CREATE POLICY "Users can insert their own messages"
ON public.study_session_messages
FOR INSERT
WITH CHECK (
  role = 'user'
  AND EXISTS (
    SELECT 1 FROM public.student_study_progress p
    WHERE p.id = study_session_messages.progress_id
    AND p.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Instructors can insert instructor messages" ON public.study_session_messages;
CREATE POLICY "Instructors can insert instructor messages"
ON public.study_session_messages
FOR INSERT
WITH CHECK (
  role = 'instructor'
  AND sender_user_id = auth.uid()
  AND EXISTS (
    SELECT 1
    FROM public.student_study_progress ssp
    JOIN public.courses c ON c.id = ssp.course_id
    WHERE ssp.id = study_session_messages.progress_id
    AND (
      public.is_course_instructor(c.id, auth.uid())
      OR public.is_institution_admin(auth.uid(), c.institution_id)
    )
  )
);
