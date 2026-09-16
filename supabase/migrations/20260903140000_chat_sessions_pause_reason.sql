-- ============================================================================
-- Make a pause say why it happened.
--
-- Review of #1248 found the same bug four times in different clothes, and they
-- share one cause: the pupil-facing "your tutor's reply was withheld" state was
-- inferred by correlating two rows that commit separately — a `role='moderation'`
-- message and `chat_sessions.status`. Every interleaving of those two writes,
-- and of the reads and Realtime events observing them, was its own defect:
--
--   * a flag recorded but the row never read back on reload
--   * an old flag mistaken for the cause of a later, unrelated pause
--   * a verdict landing between the transcript read and the subscription
--   * a reconcile reading between the moderation row and the pause commits
--   * the moderation row failing to write at all, leaving nothing to read
--
-- None of those is fixable by ordering the reads more cleverly, because the two
-- facts genuinely are not atomic. So the reason moves onto the row that already
-- carries the pause. `status` and `pause_reason` commit in one UPDATE, arrive in
-- one Realtime payload, and are read in one query. There is no interleaving left
-- to get wrong, and the pupil's warning no longer depends on a second write
-- succeeding.
--
-- `chat_messages` leaves the Realtime publication in the same breath: it was
-- added earlier in this PR only to carry that warning, and nothing subscribes to
-- it now. Publishing a table written on every tutoring turn to no subscriber is
-- pure WAL and fan-out cost.
-- ============================================================================

ALTER TABLE public.chat_sessions
  ADD COLUMN IF NOT EXISTS pause_reason TEXT;

-- Named reasons only. A typo would otherwise read as "some pause we cannot
-- explain", which is precisely the state this column exists to abolish.
ALTER TABLE public.chat_sessions
  DROP CONSTRAINT IF EXISTS chat_sessions_pause_reason_known;

ALTER TABLE public.chat_sessions
  ADD CONSTRAINT chat_sessions_pause_reason_known
  CHECK (
    pause_reason IS NULL
    OR pause_reason IN (
      'assistant_moderation',  -- the tutor's reply was flagged
      'input_moderation',      -- the student's message was flagged
      'history_limit',         -- the transcript outgrew its budget
      'message_interval'       -- the routine review interval
    )
  );

-- The reason is only ever meaningful while the session is actually paused.
--
-- Enforced by trigger rather than by convention, because the writers are not all
-- in one place: an instructor releasing or re-pausing a session from the admin
-- UI does not go through the edge functions. Without this, a session released
-- after a moderation pause would keep `pause_reason='assistant_moderation'`, and
-- the *next* pause — for a limit, or by a human — would inherit it and tell a
-- child their tutor had been flagged when it had not.
CREATE OR REPLACE FUNCTION public.clear_chat_session_pause_reason()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'paused' THEN
    NEW.pause_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chat_sessions_clear_pause_reason ON public.chat_sessions;

CREATE TRIGGER chat_sessions_clear_pause_reason
  BEFORE INSERT OR UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.clear_chat_session_pause_reason();

-- Retire the publication entry added by 20260903120000; `chat_sessions` (added
-- by 20260903130000) is the only one the panel needs now.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_messages;
  END IF;
END
$$;
