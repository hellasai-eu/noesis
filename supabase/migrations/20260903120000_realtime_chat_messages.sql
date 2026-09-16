-- ============================================================================
-- Publish `chat_messages` for Realtime.
--
-- The streaming tutor screens the assistant's reply *after* the stream closes,
-- so a flag can no longer be delivered in-band. The `role='moderation'` row it
-- writes is the signal instead, and the panel has to learn about it without a
-- reload — otherwise a pupil reads flagged text and is told nothing until they
-- next open the page.
--
-- Only the row already visible to the subscriber is delivered: Realtime applies
-- RLS per subscriber, and `chat_messages` has it enabled. "Users can view their
-- own chat messages" scopes a student to their own session's rows, which is
-- exactly the moderation row about their own turn.
--
-- Default replica identity is sufficient: the panel subscribes to INSERT, whose
-- `new` record is complete. Nothing here reads `old`, so REPLICA IDENTITY FULL
-- would only widen the WAL for no gain.
--
-- Only `chat_messages` is added here. `chat_sessions` is *also* missing from
-- this publication — the old `student_study_progress` was in it, and #1241
-- built `chat_sessions` fresh rather than renaming, which does not carry
-- membership across — so `StudentStudySession`'s subscription has been
-- receiving nothing since. That is a real bug but a separate one: the component
-- compares `payload.old.status`, which needs REPLICA IDENTITY FULL to be
-- populated, so publishing the table alone would not fix it. Left for a change
-- that can test that component properly.
--
-- Guarded because adding a table already in the publication is an error, and
-- migrations are replayed from scratch on preview branches.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
END
$$;
