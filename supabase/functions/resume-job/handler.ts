/**
 * Manually re-trigger the job runner for a stalled job (issue #729).
 *
 * Background drains are driven by a pg_cron heartbeat that POSTs
 * `/run-jobs` ~once per minute (#762). This function is the user-facing
 * "Resume" affordance for the case where an operator doesn't want to wait
 * up to a minute for the next cron tick — it fires an immediate POST to
 * the worker with the service-role bearer. `claimNextJob` already returns
 * `processing` rows as-is (resume path), so the poke alone is enough; no
 * status mutation happens here. The deploy script also fires the same poke
 * automatically as an instant-kickoff backstop.
 *
 * No status mutation is performed here — the job is already `processing`.
 *
 * Authorization (any of), matching `cancel-job`:
 *   * the job's `created_by`
 *   * a course instructor for `jobs.course_id` (when set)
 *   * an institution admin for `jobs.institution_id`
 *   * a super-admin
 *
 * Idempotent: re-poking an already-progressing runner is a no-op beyond
 * claiming the next item; atomic `claimNextItem` prevents duplicate work.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  allowed,
  type AuthzCheck,
  checkActiveCourseInstructor,
  checkInstitutionAdmin,
} from "../_shared/institution-authz.ts";
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

const TERMINAL_STATUSES = new Set([
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function isAuthorizedToResume(
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
 * Fire-and-forget POST to /run-jobs. Wrapped in `EdgeRuntime.waitUntil`
 * so the runtime keeps the isolate alive after the response closes — the
 * caller gets a 200 immediately while the worker kicks off in parallel.
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
    body: JSON.stringify({ trigger: "resume-job" }),
  }).catch((err) => {
    logger.warn("resume-job: triggerRunner failed", {
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
    logger.error("resume-job: job lookup failed", { error: jobErr.message });
    return jsonResponse({ error: "Failed to load job" }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "Job not found" }, 404);
  }
  const job = jobRow as JobRow;

  // Already terminal — nothing to resume. Return 200 noop for any
  // authenticated caller so that 403 vs 404 doesn't leak job existence.
  if (TERMINAL_STATUSES.has(job.status)) {
    return jsonResponse(
      { ok: true, jobId, status: "noop", jobStatus: job.status },
      200,
    );
  }

  const authorized = await isAuthorizedToResume(supabase, user.id, job);
  // A check that could not be PERFORMED is not one that said no (#1155).
  if (!authorized.ok) {
    logger.error("Failed to check authorization", { error: authorized.error });
    return jsonResponse({ error: "Failed to check authorization" }, 500);
  }
  if (!authorized.allowed) {
    return jsonResponse({ error: "Not authorized to resume this job" }, 403);
  }

  // The job is `pending` or `processing` — poke the runner.
  triggerRunner(supabaseUrl, serviceKey);

  logger.info("resume-job: runner triggered", { jobId, jobStatus: job.status });
  return jsonResponse(
    { ok: true, jobId, status: "resumed", jobStatus: job.status },
    200,
  );
};
