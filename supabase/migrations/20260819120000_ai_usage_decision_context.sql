-- Record WHY a model was chosen, not merely which one answered.
--
-- Before this migration `ai_usage_logs` answered "what did we spend" and
-- nothing else. It could not answer "why are tutoring costs up 30%" or "does
-- the flagship tier earn its keep", because the two facts those questions turn
-- on were absent:
--
--   1. the decision  — which policy picked the model, and what tier/effort that
--                      policy asked for. Model ids were string literals at ~29
--                      call sites and the reasoning behind them lived in code
--                      comments, unreadable to SQL.
--   2. the failures  — only successful responses were ever inserted, so a call
--                      that burned 8k output tokens on an `incomplete` response
--                      and then retried logged the retry alone. Retries are the
--                      most common reason usage jumps, and they were invisible.
--
-- DELIBERATELY NOT RECORDED: money. Token counts are facts the API reports and
-- they stay true forever; a dollar figure is a fact about a price list on a
-- particular day, and goes stale the moment OpenAI reprices. Storing one would
-- mean maintaining a rate table in this repo for every model anyone might call
-- — and the frontend map this replaces had already drifted, reporting $0 for
-- gpt-5.6-sol, gpt-5.6-terra, gpt-5.5 and gpt-5.2, which made the study-guide
-- path (the most expensive in the product) look free.
--
-- So this table records tokens, model, policy and outcome. Anyone who wants
-- dollars multiplies by whatever OpenAI charges today, outside the app, where
-- the number can be current. The OpenAI dashboard remains the billing truth.

-- ---------------------------------------------------------------------------
-- Decision context on ai_usage_logs
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_usage_logs
  -- WHY this model: the policy that chose it (see _shared/model-policy.ts).
  ADD COLUMN feature            TEXT,
  ADD COLUMN policy_key         TEXT,
  ADD COLUMN policy_version     INTEGER,
  ADD COLUMN model_tier         TEXT,
  -- What we asked for, against `model` which is what the response says answered.
  -- A divergence means OpenAI aliased or substituted the model, which silently
  -- changes both the quality and the rate the call is billed at.
  ADD COLUMN model_requested    TEXT,
  ADD COLUMN reasoning_effort   TEXT,
  -- Prompt identity, split out of the overloaded `prompt_key` (which for local
  -- prompts fell back to the literal string 'local prompt (gpt-5.4)').
  ADD COLUMN prompt_id          TEXT,
  ADD COLUMN prompt_version     TEXT,
  -- Attached OpenAI file ids. The flashcard and cheatsheet generators fall back
  -- to inlining up to 500k characters when a file id is missing, so file_count
  -- = 0 is the tell for a far more expensive fallback.
  ADD COLUMN file_count         INTEGER,
  -- Retry accounting. One row per HTTP attempt; attempt_number is 0-based.
  ADD COLUMN attempt_number     INTEGER,
  ADD COLUMN outcome            TEXT,
  ADD COLUMN http_status        INTEGER,
  ADD COLUMN error_message      TEXT,
  -- response_time_ms stays the total wall clock. These split it: a background
  -- call spends most of its time polling, and lumping the two together makes a
  -- slow model indistinguishable from a long queue.
  ADD COLUMN api_latency_ms     INTEGER,
  ADD COLUMN poll_wait_ms       INTEGER,
  ADD COLUMN background_mode    BOOLEAN;

COMMENT ON COLUMN public.ai_usage_logs.policy_key IS
  'Key into MODEL_POLICY in supabase/functions/_shared/model-policy.ts — the '
  'declared reason this call uses the model it uses.';
COMMENT ON COLUMN public.ai_usage_logs.outcome IS
  'success | incomplete | rate_limited | server_error | client_error | '
  'transport_error | poll_timeout. Rows exist for failed attempts too, so '
  'tokens burned on a retried attempt are attributable.';

-- `status` is OpenAI's own response status and does not exist for an attempt
-- that never got a response. `outcome` is the column that is always populated.
ALTER TABLE public.ai_usage_logs ALTER COLUMN status DROP NOT NULL;

ALTER TABLE public.ai_usage_logs
  ADD CONSTRAINT ai_usage_logs_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
      'success', 'incomplete', 'rate_limited', 'server_error',
      'client_error', 'transport_error', 'poll_timeout'
    )
  );

-- "Why is tutoring usage up 30%" is feature + time; "does Sol earn its keep"
-- is policy_key + time; "what are retries costing us in tokens" is outcome.
CREATE INDEX idx_ai_usage_feature ON public.ai_usage_logs (feature, created_at DESC);
CREATE INDEX idx_ai_usage_policy ON public.ai_usage_logs (policy_key, created_at DESC);
-- Failures are the minority of rows, so the partial index stays small while
-- serving every retry-waste query.
CREATE INDEX idx_ai_usage_failures ON public.ai_usage_logs (created_at DESC)
  WHERE outcome IS NOT NULL AND outcome <> 'success';
