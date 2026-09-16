-- Allow instructors to post messages into student chat sessions.
-- Adds 'instructor' as a valid role on open_question_chats, records which
-- instructor authored a message via sender_user_id on both chat tables, and
-- grants instructors INSERT access gated by is_course_instructor(course_id, auth.uid()).

-- ============================================================
-- open_question_chats
-- ============================================================

ALTER TABLE public.open_question_chats
  DROP CONSTRAINT IF EXISTS open_question_chats_role_check;

ALTER TABLE public.open_question_chats
  ADD CONSTRAINT open_question_chats_role_check
  CHECK (role IN ('user', 'assistant', 'instructor'));

ALTER TABLE public.open_question_chats
  ADD COLUMN IF NOT EXISTS sender_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.open_question_chats
  DROP CONSTRAINT IF EXISTS open_question_chats_instructor_sender_check;

ALTER TABLE public.open_question_chats
  ADD CONSTRAINT open_question_chats_instructor_sender_check
  CHECK (role <> 'instructor' OR sender_user_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_open_question_chats_sender
  ON public.open_question_chats(sender_user_id);

DROP POLICY IF EXISTS "Instructors can insert instructor messages" ON public.open_question_chats;
CREATE POLICY "Instructors can insert instructor messages"
ON public.open_question_chats
FOR INSERT
WITH CHECK (
  role = 'instructor'
  AND sender_user_id = auth.uid()
  AND public.is_course_instructor(course_id, auth.uid())
);

-- ============================================================
-- study_session_messages
-- ============================================================

ALTER TABLE public.study_session_messages
  ADD COLUMN IF NOT EXISTS sender_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.study_session_messages
  DROP CONSTRAINT IF EXISTS study_session_messages_instructor_sender_check;

ALTER TABLE public.study_session_messages
  ADD CONSTRAINT study_session_messages_instructor_sender_check
  CHECK (role <> 'instructor' OR sender_user_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_study_session_messages_sender
  ON public.study_session_messages(sender_user_id);

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
    WHERE ssp.id = study_session_messages.progress_id
    AND public.is_course_instructor(ssp.course_id, auth.uid())
  )
);
