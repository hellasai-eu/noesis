-- Fix #1127: ai_rate_limit_events was world-writable.
--
-- 20260202120000_ai_rate_limit_events.sql enabled RLS and then added:
--
--   CREATE POLICY "Service role full access" ON public.ai_rate_limit_events
--     FOR ALL USING (true) WITH CHECK (true);
--
-- with no `TO service_role`, so the policy applied to PUBLIC. The intent — read
-- the comment above it in that migration, "edge functions use service role" —
-- was to let the service role through. But `service_role` is created with
-- BYPASSRLS, so it was never subject to RLS here and never needed a policy.
-- The only thing the policy actually did was hand every `anon` and
-- `authenticated` caller full SELECT/INSERT/UPDATE/DELETE over the whole table,
-- across every tenant.
--
-- That matters more than "operational telemetry" suggests: the table carries
-- user_id, institution_id and course_id, so the rows are tenant-attributed.
--
-- Dropping the policy leaves RLS enabled with no policies, which denies
-- anon/authenticated entirely while service_role continues to bypass. That is
-- the same shape `public.run_jobs_tick` already uses for a service-role-only
-- ledger.

DROP POLICY IF EXISTS "Service role full access" ON public.ai_rate_limit_events;

COMMENT ON TABLE public.ai_rate_limit_events IS
  'Tracks AI API rate limiting events for monitoring and alerting. '
  'Service-role only: RLS is enabled with no policies on purpose, so anon and '
  'authenticated are denied and the service role passes through on BYPASSRLS. '
  'As of this migration nothing writes the table — rate-limit headers go to '
  'ai_usage_logs, and export-data reads this one for the GDPR export — so any '
  'future writer should be an edge function using the service role. Do not add '
  'a permissive policy to "allow the service role": it does not need one, and '
  'a policy without an explicit TO clause applies to PUBLIC (see #1127).';
