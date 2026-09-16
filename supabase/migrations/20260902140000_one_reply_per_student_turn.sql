-- Name the turn a reply answers, so "already answered" is about *that* turn.
--
-- 20260902130000 stopped a racing retry duplicating a reply by declining when
-- the last conversational row was already an assistant one. That closes the
-- retry race, and greptile confirmed it does — but it cannot tell a retry from
-- two genuinely overlapping student turns:
--
--   student sends message 1, then message 2, before either reply persists
--   reply 1 lands   -> last row is now an assistant row
--   reply 2 arrives -> sees an assistant row -> declined, and the student
--                      loses a real answer
--
-- The guard was asking "has anything been answered" when the question is "has
-- *this* turn been answered". So an assistant row now names the student turn it
-- answers, and the rule is expressed as a unique index over that: two replies
-- to one turn become impossible rather than merely unlikely.
--
-- Today the panel disables its composer while a turn is in flight, which is why
-- this has not bitten. That is a client-side guard on a server-side invariant —
-- exactly the reasoning that failed twice on the retry race — and it does not
-- hold across two tabs, or across the buffered and streaming surfaces sharing
-- one session.

ALTER TABLE public.chat_messages
  ADD COLUMN in_reply_to UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.chat_messages.in_reply_to IS
  'For an assistant row, the student turn it answers. NULL on student turns, on '
  'moderation records, and on an opening turn that answers nothing.';

-- The invariant itself. Partial, because only assistant rows carry it and only
-- non-NULL values are constrained — an opening turn answers no one, and several
-- may exist across a session''s life.
CREATE UNIQUE INDEX chat_messages_one_reply_per_turn
  ON public.chat_messages (in_reply_to)
  WHERE in_reply_to IS NOT NULL AND role = 'assistant';

-- Backfill is deliberately omitted. Existing rows predate the column, so every
-- historical assistant row keeps `in_reply_to IS NULL` and is simply outside
-- the index. Inferring which turn each answered would mean guessing from
-- timestamps across transcripts that interleave instructor and moderation rows,
-- and a wrong guess would forge a link that reads as fact.

-- ---------------------------------------------------------------------------
-- The guard, rebuilt from 20260902130000 — the newest definition.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.persist_chat_turn(
  _session_id       uuid,
  _content          text,
  _state            jsonb,
  _transition_type  text,
  _state_before     jsonb    DEFAULT NULL,
  _llm_decision     text     DEFAULT NULL,
  _llm_judgement    text     DEFAULT NULL,
  _llm_confidence   numeric  DEFAULT NULL,
  _in_reply_to      uuid     DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message_id  uuid;
  v_state_id    uuid;
  v_last_role   text;
BEGIN
  -- Serialise concurrent turns for this session. Without it the checks below
  -- are just narrower races.
  PERFORM 1 FROM public.chat_sessions WHERE id = _session_id FOR UPDATE;

  IF _in_reply_to IS NOT NULL THEN
    -- The precise question: has this student turn already been answered?
    IF EXISTS (
      SELECT 1 FROM public.chat_messages
      WHERE in_reply_to = _in_reply_to AND role = 'assistant'
    ) THEN
      RETURN NULL;
    END IF;
  ELSE
    -- An opening turn answers no one, so fall back to "is the conversation
    -- already waiting on the student". Only `user` and `assistant` count — a
    -- moderation or system row is a record about the conversation, not a turn
    -- in it.
    SELECT role INTO v_last_role
    FROM public.chat_messages
    WHERE session_id = _session_id AND role IN ('user', 'assistant')
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_last_role = 'assistant' THEN
      RETURN NULL;
    END IF;
  END IF;

  -- `clock_timestamp()`, not the `now()` default: it is strictly later than
  -- anything written earlier in this transaction, so the row this turn adds can
  -- never tie with the student turn it answers.
  INSERT INTO public.chat_messages (session_id, role, content, flagged_offensive, created_at, in_reply_to)
  VALUES (_session_id, 'assistant', _content, false, clock_timestamp(), _in_reply_to)
  RETURNING id INTO v_message_id;

  INSERT INTO public.chat_session_state (session_id, current_state, updated_at)
  VALUES (_session_id, _state, now())
  ON CONFLICT (session_id)
  DO UPDATE SET current_state = EXCLUDED.current_state, updated_at = now()
  RETURNING id INTO v_state_id;

  INSERT INTO public.chat_state_history (
    session_id, state_before, state_after, transition_type,
    trigger_message_id, llm_decision, llm_judgement, llm_confidence
  )
  VALUES (
    _session_id, _state_before, _state, _transition_type,
    v_message_id, _llm_decision, _llm_judgement, _llm_confidence
  );

  RETURN v_message_id;

EXCEPTION
  -- The index is the real rule; the check above is the fast path. If two
  -- callers somehow reach the insert together, the loser lands here and
  -- declines like any other duplicate rather than failing the turn.
  WHEN unique_violation THEN
    RETURN NULL;
END;
$$;

-- The signature changed, so the previous overload would otherwise linger and
-- keep answering calls that omit the new argument.
DROP FUNCTION IF EXISTS public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric);

REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) TO service_role;

COMMENT ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) IS
  'Records one completed tutoring turn — assistant message, session state and '
  'state-history transition — in a single transaction, and only if the student '
  'turn named by _in_reply_to has not already been answered. Returns NULL when it '
  'has, which is how a racing retry declines without duplicating the reply, and '
  'how two genuinely overlapping turns each still get their own. Service role '
  'only: it writes role=''assistant'', which RLS deliberately denies students.';
