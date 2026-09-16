-- One reply per student turn, enforced where it can actually be enforced.
--
-- The streaming surface generates in *background* mode, so a generation
-- survives the client losing its stream and persists on its own. If the pupil
-- retries in that window, two generations race and both write an assistant row
-- for the same student turn — duplicating tutor output in the transcript and in
-- every future model context.
--
-- The client tried to prevent this twice, and could not: it re-read the
-- transcript before retrying, but any check-then-request leaves a window
-- between the check and the second generation's write. A client-side preflight
-- cannot close a server-side race. So the rule moves to the write.
--
-- `FOR UPDATE` on the session row is what makes it a rule rather than another
-- narrower window: concurrent turns for one session serialise on it, so the
-- second one sees the first one's assistant row and declines.
--
-- Returning NULL rather than raising: "someone already answered this turn" is
-- not a fault. The caller shows the reply that exists instead of its own.
--
-- Built from 20260902120000, the only prior definition.

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
  v_message_id  uuid;
  v_state_id    uuid;
  v_last_role   text;
BEGIN
  -- Serialise concurrent turns for this session. Without it the check below is
  -- just a narrower race.
  PERFORM 1 FROM public.chat_sessions WHERE id = _session_id FOR UPDATE;

  -- "Has the latest turn been answered?" is simply "is the last conversational
  -- row an assistant one". Asked as a timestamp comparison instead, it breaks
  -- on ties: `created_at` defaults to `now()`, which is the *transaction*
  -- timestamp, so rows written in one transaction share it and `>` is false.
  -- Only `user` and `assistant` count — a `moderation` or `system` row is a
  -- record about the conversation, not a turn in it.
  SELECT role INTO v_last_role
  FROM public.chat_messages
  WHERE session_id = _session_id AND role IN ('user', 'assistant')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_last_role = 'assistant' THEN
    RETURN NULL;
  END IF;

  -- `clock_timestamp()`, not the `now()` default: it is strictly later than
  -- anything written earlier in this transaction, so the row this turn adds can
  -- never tie with the student turn it answers.
  INSERT INTO public.chat_messages (session_id, role, content, flagged_offensive, created_at)
  VALUES (_session_id, 'assistant', _content, false, clock_timestamp())
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

REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) FROM anon;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) TO service_role;

COMMENT ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric) IS
  'Records one completed tutoring turn — assistant message, session state and '
  'state-history transition — in a single transaction, and only if the student''s '
  'latest turn has not already been answered. Returns NULL when it has, which is '
  'how a racing retry declines instead of duplicating the reply. Service role '
  'only: it writes role=''assistant'', which RLS deliberately denies students.';
