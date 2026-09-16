/**
 * Manually retry / requeue a stuck or failed background job (issue #764).
 *
 * Resets the job and its non-terminal items back to `pending` so the next
 * pg_cron tick (#762) re-runs them via the existing `claimNextJob` path. A
 * fire-and-forget POST to `/run-jobs` skips the up-to-60s wait for that tick.
 *
 * Retry vs resume:
 *   * `resume-job` only pokes the runner — it never mutates job rows. It's
 *     for a job that's still `processing` but appears to have stalled
 *     mid-slice; the runner will pick the row up as-is.
 *   * `retry-job` is for jobs whose lifecycle has come off the rails — they
 *     reached a terminal state (`failed`, `partially_completed`, `cancelled`)
 *     or are sitting in `processing` past their lease expiry (worker died).
 *     We flip the parent + non-terminal items back to `pending` so the next
 *     tick can re-claim them.
 *
 * Guards:
 *   * Live lease — refuse to retry a `processing` row whose `locked_until`
 *     is still in the future. A live worker is on it; resetting would race
 *     the worker's own writes. (`409 Conflict`.)
 *   * Already-clean — `completed` jobs don't need retry; return a `noop`.
 *
 * Authorization (any of), mirroring `cancel-job` / `resume-job`:
 *   * the job's `created_by`
 *   * a course instructor for `jobs.course_id` (when set)
 *   * an institution admin for `jobs.institution_id`
 *   * a super-admin
 *
 * The UI surfaces the Retry button only to admin / super-admin per the
 * issue's gating requirement; the broader authz set here keeps the function
 * symmetric with its siblings and avoids surprising 403s for instructors
 * who already manage the underlying course.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  allowed,
  type AuthzCheck,
  checkActiveCourseInstructor,
  checkInstitutionAdmin,
} from "../_shared/institution-authz.ts";
import { LEASE_EXPIRED_ISO } from "../_shared/job-runner.ts";
import type { JobRow } from "../_shared/job-handlers.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const RETRYABLE_TERMINAL_STATUSES = new Set([
  "failed",
  "partially_completed",
  "cancelled",
]);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAuthorizedToRetry(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  userId: string,
  job: JobRow,
): Promise<AuthzCheck> {
  if (job.created_by && job.created_by === userId) return allowed(true);

  // Suspension-aware, and covers super-admin: `is_institution_admin` ORs in
  // `is_super_admin`, so the separate RPC this used to make is gone (#1082).
  const admin = await checkInstitutionAdmin(supabase, userId, job.institution_id);
  if (!admin.ok) return admin;
  if (admin.allowed) return allowed(true);

  if (job.course_id) {
    // Membership is checked inside — `course_instructors` has no suspension
    // column, so a suspended user keeps the assignment.
    const instructor = await checkActiveCourseInstructor(
      supabase,
      userId,
      job.course_id,
      job.institution_id,
    );
    if (!instructor.ok) return instructor;
    if (instructor.allowed) return allowed(true);
  }

  return allowed(false);
}

/**
 * Fire-and-forget POST to /run-jobs. Same shape as resume-job's trigger.
 */
function triggerRunner(supabaseUrl: string, serviceKey: string): void {
  const url = `${supabaseUrl}/functions/v1/run-jobs`;
  const work = fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trigger: "retry-job" }),
  }).catch((err) => {
    logger.warn("retry-job: triggerRunner failed", {
      error: (err as Error).message ?? String(err),
    });
  });

  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(work);
  }
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return jsonResponse(
      { error: "Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" },
      500,
    );
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user?.id) {
    return jsonResponse({ error: "Invalid authorization" }, 401);
  }

  // Service-role client, so RLS's aal2 enforcement never runs here — refuse
  // an MFA-enrolled caller whose token is still aal1.
  if (!callerMfaSatisfied(user, token)) {
    return jsonResponse({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Body must be JSON" }, 400);
  }
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== "string" || jobId.length === 0) {
    return jsonResponse({ error: "Missing or invalid jobId" }, 400);
  }

  const { data: jobRow, error: jobErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) {
    logger.error("retry-job: job lookup failed", { error: jobErr.message });
    return jsonResponse({ error: "Failed to load job" }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "Job not found" }, 404);
  }
  const job = jobRow as JobRow;

  const authorized = await isAuthorizedToRetry(supabase, user.id, job);
  // A check that could not be PERFORMED is not one that said no (#1155).
  if (!authorized.ok) {
    logger.error("Failed to check authorization", { error: authorized.error });
    return jsonResponse({ error: "Failed to check authorization" }, 500);
  }
  if (!authorized.allowed) {
    return jsonResponse({ error: "Not authorized to retry this job" }, 403);
  }

  // `completed` jobs have no work to redo. Treat as noop so the UI button is
  // safe to fire on a row that flipped to completed since the user clicked.
  if (job.status === "completed") {
    return jsonResponse(
      { ok: true, jobId, status: "noop", jobStatus: job.status },
      200,
    );
  }

  // `pending` jobs are already waiting for a worker — nothing to reset, but
  // we still poke the runner so the user gets the same "kick now" affordance.
  if (job.status === "pending") {
    triggerRunner(supabaseUrl, serviceKey);
    return jsonResponse(
      { ok: true, jobId, status: "noop", jobStatus: job.status },
      200,
    );
  }

  // Active lease guard: if a worker is currently leasing the job, don't
  // steal it out from under them. The next tick will reclaim if the lease
  // expires for real.
  if (job.status === "processing") {
    const leaseExpiresAt = new Date(job.locked_until).getTime();
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()) {
      return jsonResponse(
        {
          error: "Job is currently being processed (lease active). Cancel it first if you want to retry.",
          jobStatus: job.status,
          locked_until: job.locked_until,
        },
        409,
      );
    }
  } else if (!RETRYABLE_TERMINAL_STATUSES.has(job.status)) {
    // Defensive: an unknown status we don't recognize. Fail closed.
    return jsonResponse(
      { error: `Cannot retry job in status: ${job.status}` },
      409,
    );
  }

  // Reset the parent job. The `.in(status, …)` predicate makes parallel
  // retries idempotent — only the first wins; a racing caller sees
  // `updateMatched = false` and gets a noop.
  const retryableStatuses = ["processing", "failed", "partially_completed", "cancelled"];
  const { data: updated, error: updErr } = await supabase
    .from("jobs")
    .update({
      status: "pending",
      error: null,
      ended_at: null,
      started_at: null,
      locked_until: LEASE_EXPIRED_ISO,
      last_heartbeat: null,
    })
    .eq("id", jobId)
    .in("status", retryableStatuses)
    .select("*")
    .maybeSingle();
  if (updErr) {
    logger.error("retry-job: status update failed", { error: updErr.message });
    return jsonResponse({ error: "Failed to retry job" }, 500);
  }
  if (!updated) {
    // Someone else won (parallel retry / cancel / runner finalize between
    // our load and update). Treat as noop.
    return jsonResponse({ ok: true, jobId, status: "noop" }, 200);
  }

  // Reset non-terminal items: failed + cancelled items go back to pending so
  // the runner re-dispatches them. We zero `attempts` because items that
  // exhausted `max_attempts` would otherwise be re-failed on the very next
  // claim. `completed` items are left alone — that work is already done.
  // Any `processing` items past their own lease will be reclaimed by the
  // runner via the existing #763 path on the next tick; we don't touch
  // those here to avoid racing a worker that might still be alive.
  const { error: itemsErr } = await supabase
    .from("job_items")
    .update({
      status: "pending",
      error: null,
      attempts: 0,
      locked_until: LEASE_EXPIRED_ISO,
      last_heartbeat: null,
      updated_at: new Date().toISOString(),
    })
    .eq("job_id", jobId)
    .in("status", ["failed", "cancelled"]);
  if (itemsErr) {
    // Don't fail the whole request — the parent is already pending. Log
    // and continue; the runner won't be able to make progress without
    // these items but the operator can re-retry.
    logger.warn("retry-job: items update failed", {
      jobId,
      error: itemsErr.message,
    });
  }

  triggerRunner(supabaseUrl, serviceKey);

  logger.info("retry-job: job requeued", {
    jobId,
    previousStatus: job.status,
  });

  return jsonResponse(
    { ok: true, jobId, status: "retried", previousStatus: job.status },
    200,
  );
};
