-- ============================================================================
-- Let a teacher's message reach the student without a reload.
--
-- An instructor can write into a student's tutoring session from Student 360
-- (`role='instructor'`, see OpenQuestionChatHistory). The student's panel only
-- ever read that row on load, so a message sent to a pupil sitting in the
-- session arrived whenever they next happened to refresh — which, in a surface
-- they stay on for a whole session, is "not at all".
--
-- The obvious fix is to put `chat_messages` back in the Realtime publication.
-- 20260903140000 took it *out* on purpose, and the reason still holds: that
-- table is written twice per tutoring turn, so publishing it makes every
-- connected pupil's subscription an RLS check on every other pupil's turn.
-- Nothing about this feature needs that firehose — an instructor message is a
-- rare event, and it is the only kind of row the panel cannot already see.
--
-- So the *session* row carries the signal instead. `chat_sessions` is already
-- published (20260903130000) and the panel is already subscribed to its own
-- row for the moderation pause, so this costs no new subscription, no new
-- channel and no per-turn traffic: the trigger below fires only for an
-- instructor's message.
--
-- This is deliberately a notification, not a fact to be correlated. The panel
-- re-reads the transcript when the timestamp changes and takes what it finds
-- there; it never reconstructs the message from this column. That is what keeps
-- it clear of the two-rows-commit-separately trap 20260903140000 was written
-- about — there is no second fact here to interleave with, only a nudge.
-- ============================================================================

ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS last_instructor_message_at TIMESTAMPTZ;

-- SECURITY DEFINER because raising the signal must not depend on the writer
-- also holding UPDATE on the session row.
--
-- Today it would: `chat_messages` INSERT and `chat_sessions` UPDATE are both
-- gated on `instructor_can_access_student_work`, so anyone who can write the
-- message can write the row. But those are two separate policies that happen to
-- agree, and if they ever diverge a non-definer trigger stops signalling
-- *silently* — RLS refuses an UPDATE by matching zero rows, not by raising — so
-- the teacher is told their message was sent and the pupil's screen never
-- changes. That is the exact bug this column exists to fix, restored in a form
-- nothing reports.
--
-- It is not a way in. The trigger only runs on an INSERT that already passed
-- the message table's own policy, and it touches one column on the single row
-- named by that message's `session_id`, so a caller cannot steer it.
CREATE OR REPLACE FUNCTION public.signal_instructor_chat_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.chat_sessions
     SET last_instructor_message_at = NEW.created_at
   WHERE id = NEW.session_id;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.signal_instructor_chat_message() FROM PUBLIC;

DROP TRIGGER IF EXISTS chat_messages_signal_instructor ON public.chat_messages;

-- Gated in the trigger, not in the function body: an `AFTER INSERT` that fires
-- on every row would put a `chat_sessions` UPDATE — and therefore a Realtime
-- broadcast — behind every tutoring turn, which is the cost this whole approach
-- exists to avoid.
CREATE TRIGGER chat_messages_signal_instructor
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW
  WHEN (NEW.role = 'instructor')
  EXECUTE FUNCTION public.signal_instructor_chat_message();
