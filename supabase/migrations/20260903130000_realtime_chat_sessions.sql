-- ============================================================================
-- Publish `chat_sessions` for Realtime.
--
-- Supersedes the note in 20260903120000, which deferred this. That note was
-- about `StudentStudySession`, whose unpause toast needs REPLICA IDENTITY FULL
-- to read `payload.old.status` — still true, still deferred. But the streaming
-- panel needs something narrower and available today: `new.status`, so it can
-- clear the moderation banner when an instructor releases a session. Without it
-- the banner only ever goes on, and a released pupil sits behind a warning
-- about a pause that is over.
--
-- A separate file rather than an edit to 20260903120000: preview branches apply
-- migrations incrementally, so a file that has already run there never runs
-- again, and the change would silently not exist on any live preview.
--
-- Effect on `StudentStudySession`: its subscription currently receives nothing
-- at all, so this can only add. Its status map and progress state begin
-- updating live, as written. Its unpause toast still will not fire — that
-- branch compares `payload.old.status`, which stays empty under the default
-- replica identity. No behaviour it has today is changed; one it was meant to
-- have starts working.
--
-- REPLICA IDENTITY is deliberately left alone. FULL writes every column of
-- every UPDATE into the WAL for a table on the hot path of every tutoring turn,
-- which is a real cost to pay for one toast. It belongs with a change that can
-- test that component.
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
      AND tablename = 'chat_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_sessions;
  END IF;
END
$$;
