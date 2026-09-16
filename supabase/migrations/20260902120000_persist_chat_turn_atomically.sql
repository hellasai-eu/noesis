-- Persist a completed tutoring turn in one transaction.
--
-- The turn's three writes — the assistant message, the session state, and the
-- state-history transition — were three round-trips, so any of them could land
-- without the others. The failure that matters is the message succeeding and
-- the state upsert not: the reply reaches the pupil and `[DONE]` reports
-- success, while the next turn loads the previous turn's learning state and
-- the history chain skips a transition. The tutor's model of what the student
-- knows silently regresses, and nothing says so.
--
-- The Supabase JS client cannot open a transaction, so the three writes become
-- one function. Either the turn is recorded whole or nothing is, and the
-- handler can report the difference honestly.
--
-- `_state_before` is passed in rather than read here: it is the state the turn
-- was *reasoned from*, which the handler loaded before calling the model, and
-- re-reading it now would record whatever the row happens to hold instead.

CREATE OR REPLACE FUNCTION public.persist_chat_turn(
  _session_id       uuid,
  _content          text,
  _state            jsonb,
  _transition_type  text,
  _state_before     jsonb    DEFAULT NULL,
  _llm_decision     text     DEFAULT NULL,
  _llm_judgement    text     DEFAULT NULL,
  _llm_confidence   numeric  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message_id uuid;
  v_state_id   uuid;
BEGIN
  INSERT INTO public.chat_messages (session_id, role, content, flagged_offensive)
  VALUES (_session_id, 'assistant', _content, false)
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
END;
$$;

-- SECURITY DEFINER, so it must not be reachable by a client. Writing an
-- assistant turn is exactly what `chat_messages`' insert policy forbids
-- students from doing — it is what stops a pupil putting words in the tutor's
-- mouth — and this function would hand it to them.
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) TO service_role;

COMMENT ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) IS
  'Records one completed tutoring turn — assistant message, session state and '
  'state-history transition — in a single transaction, so a turn cannot be '
  'half-recorded. Service role only: it writes role=''assistant'', which the '
  'RLS policy on chat_messages deliberately denies to students.';
