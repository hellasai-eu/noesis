-- Let a state row say which schema it is written in.
--
-- `chat_session_state.schema_version` was added for exactly this and has never
-- been written: it defaults to 1, and `persist_chat_turn` does not set it. That
-- was harmless while one shape existed. Now two do — the per-surface v1 shapes
-- that /chat still writes, and the unified v2 shape the streaming surface
-- writes — and the column would label every v2 row as v1.
--
-- Nothing currently *reads* the column: `readStoredState` sniffs the shape
-- instead, deliberately, because rows are never migrated and a row's real shape
-- is the only thing worth trusting. So this does not fix a live bug. It stops
-- the column being a lie, which matters the moment anyone reports on it or uses
-- it to find rows to migrate — the two things a version column is for.
--
-- The version is taken from the state itself rather than a new argument: the
-- reducer already stamps `schema_version` into what it writes, and a separate
-- argument could disagree with the blob it describes. A shape with no stamp is
-- v1, which is what every legacy row is.

-- ---------------------------------------------------------------------------
-- Rebuilt from 20260902140000 — the newest definition. Only the state upsert
-- changes; the reply guard, the lock and the exception handler are verbatim.
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
  v_version     integer;
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

  -- An unstamped state is a v1 one. `jsonb_typeof` guards the cast: a
  -- non-numeric stamp would otherwise raise and fail an entire turn over a
  -- reporting column.
  v_version := CASE
    WHEN jsonb_typeof(_state -> 'schema_version') = 'number'
      THEN (_state ->> 'schema_version')::integer
    ELSE 1
  END;

  INSERT INTO public.chat_session_state (session_id, current_state, schema_version, updated_at)
  VALUES (_session_id, _state, v_version, now())
  ON CONFLICT (session_id)
  DO UPDATE SET
    current_state  = EXCLUDED.current_state,
    schema_version = EXCLUDED.schema_version,
    updated_at     = now()
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

-- The signature is unchanged, so there is no stale overload to drop and the
-- existing grants still apply. Restated anyway, because CREATE OR REPLACE keeps
-- them only for a function that already existed, and a fresh database applying
-- these migrations in order is the case where that is not true.
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.persist_chat_turn(uuid, text, jsonb, text, jsonb, text, text, numeric, uuid) TO service_role;

COMMENT ON COLUMN public.chat_session_state.schema_version IS
  'Which shape `current_state` is written in: 1 for the per-surface shapes /chat '
  'still writes, 2 for the unified one. Set from the state''s own stamp. Rows are '
  'never migrated, so readers sniff the shape rather than trusting this — it is '
  'for reporting and for finding rows, not for dispatch.';
