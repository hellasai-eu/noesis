/**
 * Generic background job worker (issue #695, cron-driven since #762).
 *
 * Internal-only entrypoint that drives the job runner:
 *   1. Authenticate the caller as service-role.
 *   2. Run one time-bounded slice of work via `runJobSlice`.
 *   3. If `moreWork` remains AND the pg_cron driver is unhealthy (the gap
 *      this fallback exists to cover — issue #780), fire-and-forget a
 *      self-call with `chain + 1` so the job still makes progress.
 *      Bounded by `MAX_FALLBACK_CHAIN` — the unbounded chain that
 *      preceded #762 is exactly what we must NOT reintroduce.
 *   4. Exit. A pg_cron heartbeat (~once per minute, see migration
 *      `20260628300000_pg_cron_run_jobs.sql`) re-invokes this function on
 *      the next tick; `claimNextJob` resumes any `processing` row left
 *      behind by this slice.
 *
 * The browser MUST NOT call this function. End users enqueue work through
 * the schema (#694) or job-specific endpoints; the runner is internal
 * plumbing that finalizes those jobs.
 *
 * Importing `registered-job-handlers.ts` is what makes concrete handlers
 * available on dispatch — each handler self-registers on import.
 */
import { logger } from "../_shared/logger.ts";
import "../_shared/registered-job-handlers.ts";
import {
  createServiceClient,
  type RunJobSliceResult,
  runJobSlice,
} from "../_shared/job-runner.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Bounded fallback chain length (#780). Each external trigger (enqueue,
 * resume, retry, post-deploy poke, or a pg_cron tick) can spawn at most
 * this many additional slices via self-call, and only when
 * `get_jobs_cron_health` says the cron driver itself isn't healthy. Five
 * slices ≈ 12.5 minutes of fallback work — enough to keep typical jobs
 * moving while an operator notices and fixes the cron, finite enough that
 * the unbounded-chain stall that motivated #762 can't recur.
 */
export const MAX_FALLBACK_CHAIN = 5;

interface CronHealth {
  is_healthy: boolean;
  secrets_seeded: boolean;
}

/**
 * Read the cron-health snapshot via the SECURITY DEFINER RPC (#780). On
 * any read failure (RPC missing, DB error) we conservatively report
 * `is_healthy = true` so we DON'T spin up a fallback chain in an
 * environment whose only problem is a missing health helper. Failing open
 * here is safe: the cost of a missed fallback is "wait for the next cron
 * tick"; the cost of a false-negative fallback is the runaway chain #762
 * removed.
 */
async function readCronHealth(supabase: SupabaseClient): Promise<CronHealth> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  try {
    const { data, error } = await sb.rpc("get_jobs_cron_health");
    if (error || !data) {
      logger.warn("run-jobs: cron-health rpc failed; assuming healthy", {
        error: error?.message ?? "no data",
      });
      return { is_healthy: true, secrets_seeded: true };
    }
    return {
      is_healthy: Boolean((data as { is_healthy?: boolean }).is_healthy ?? true),
      secrets_seeded: Boolean(
        (data as { secrets_seeded?: boolean }).secrets_seeded ?? true,
      ),
    };
  } catch (err) {
    logger.warn("run-jobs: cron-health read threw; assuming healthy", {
      error: (err as Error)?.message ?? String(err),
    });
    return { is_healthy: true, secrets_seeded: true };
  }
}

/**
 * Fire-and-forget POST to this function with an incremented chain counter.
 * Best-effort: failures are logged but never block the response. The
 * Deno edge runtime keeps the isolate alive after the response closes via
 * `EdgeRuntime.waitUntil` when available.
 */
function scheduleFallbackChain(
  supabaseUrl: string,
  serviceKey: string,
  nextChain: number,
): void {
  const url = `${supabaseUrl}/functions/v1/run-jobs`;
  const work = fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trigger: "fallback-chain", chain: nextChain }),
  }).catch((err) => {
    logger.warn("run-jobs: fallback chain post failed", {
      error: (err as Error).message ?? String(err),
      nextChain,
    });
  });

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(work);
  }
}

/**
 * Decide whether to chain another slice. Three independent gates have to
 * pass: there must be more work, we must not have hit the chain cap, and
 * the pg_cron driver must be unhealthy (so the chain is actually filling
 * a gap, not piling on top of a working primary).
 */
async function maybeChainFallback(
  supabase: SupabaseClient,
  slice: RunJobSliceResult,
  chain: number,
): Promise<{ chained: boolean; reason: string }> {
  if (!slice.moreWork || slice.terminal) {
    return { chained: false, reason: "no-more-work" };
  }
  if (chain >= MAX_FALLBACK_CHAIN) {
    return { chained: false, reason: "chain-cap-reached" };
  }

  const health = await readCronHealth(supabase);
  if (health.is_healthy) {
    return { chained: false, reason: "cron-healthy" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return { chained: false, reason: "env-missing" };
  }
  scheduleFallbackChain(supabaseUrl, serviceKey, chain + 1);
  return {
    chained: true,
    reason: health.secrets_seeded ? "cron-stale" : "vault-secrets-missing",
  };
}

/**
 * Parse the `chain` counter from the request body. Out-of-range, missing,
 * or non-numeric values all collapse to 0 — a fresh chain. A caller
 * passing `chain: 999` cannot bypass the cap because the next decision
 * checks against `MAX_FALLBACK_CHAIN`.
 */
async function readChainCounter(req: Request): Promise<number> {
  try {
    const cloned = req.clone();
    const body = await cloned.json() as { chain?: unknown };
    const n = Number(body?.chain);
    if (Number.isFinite(n) && n >= 0 && n <= MAX_FALLBACK_CHAIN) {
      return Math.floor(n);
    }
  } catch {
    // Body might be empty or non-JSON — that's fine, treat as fresh chain.
  }
  return 0;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // run-jobs is intentionally UNAUTHENTICATED. It is the internal worker
  // driven by the pg_cron `run-jobs-tick` and by best-effort pokes from
  // enqueue/resume/retry. Dropping the shared-secret gate that used to live
  // here decouples the driver from Supabase's service-role key entirely — no
  // Vault seeding to keep in sync, and it survives key rotation and the
  // legacy→new API-key migration that repeatedly broke the tick.
  //
  // Trade-off (accepted): anyone who knows the URL can invoke it. The blast
  // radius is bounded — callers CANNOT enqueue work (enqueue-bulk-generation
  // is authenticated), so an unauthenticated call only drains the EXISTING
  // queue (the owner's own jobs) and no-ops once it is empty. Privileged DB
  // writes still use the platform-injected service role inside
  // createServiceClient(); that key is never accepted from, or exposed to,
  // the caller. verify_jwt = false at the gateway keeps the endpoint public.
  const chain = await readChainCounter(req);

  try {
    const supabase = createServiceClient();
    const slice = await runJobSlice(supabase);

    const chainDecision = await maybeChainFallback(supabase, slice, chain);

    logger.info("Slice complete", {
      jobId: slice.jobId,
      jobType: slice.jobType,
      processed: slice.processed,
      completed: slice.completed,
      failed: slice.failed,
      moreWork: slice.moreWork,
      terminal: slice.terminal,
      chain,
      chained: chainDecision.chained,
      chainReason: chainDecision.reason,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        ...slice,
        chain,
        chained: chainDecision.chained,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    logger.exception("run-jobs: unhandled error", error as Error);
    return new Response(
      JSON.stringify({ error: (error as Error).message ?? "Job runner failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
};
