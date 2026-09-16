/**
 * Cancel an in-flight background job (issue #723).
 *
 * Mirrors the auth pattern of `enqueue-bulk-generation`: thin client-callable
 * front door, internal token verification via supabase.auth.getUser, service
 * role for the actual mutation. Workers bypass RLS — there is no user-facing
 * UPDATE policy on `jobs` — so cancellation MUST go through this function
 * rather than a direct client-side write.
 *
 * Authorization (any of):
 *   * the job's `created_by`
 *   * a course instructor for `jobs.course_id` (when set)
 *   * an institution admin for `jobs.institution_id`
 *   * a super-admin
 *
 * The cancel is idempotent: cancelling an already-terminal job returns 200 +
 * `{ status: 'noop' }` so the UI can fire the request without first racing a
 * realtime update.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import {
  allowed,
  type AuthzCheck,
  checkActiveCourseInstructor,
  checkInstitutionAdmin,
} from "../_shared/institution-authz.ts";
import {
  insertCompletionNotification,
  tallyJobItems,
} from "../_shared/job-runner.ts";
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

async function isAuthorizedToCancel(
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
    logger.error("cancel-job: job lookup failed", { error: jobErr.message });
    return jsonResponse({ error: "Failed to load job" }, 500);
  }
  if (!jobRow) {
    return jsonResponse({ error: "Job not found" }, 404);
  }
  const job = jobRow as JobRow;

  const authorized = await isAuthorizedToCancel(supabase, user.id, job);
  // A check that could not be PERFORMED is not one that said no (#1155).
  if (!authorized.ok) {
    logger.error("Failed to check authorization", { error: authorized.error });
    return jsonResponse({ error: "Failed to check authorization" }, 500);
  }
  if (!authorized.allowed) {
    return jsonResponse({ error: "Not authorized to cancel this job" }, 403);
  }

  // Already terminal — no-op. Returning 200 makes the cancel button safe to
  // press even when the realtime update arrives a beat late.
  if (TERMINAL_STATUSES.has(job.status)) {
    return jsonResponse(
      { ok: true, jobId, status: "noop", jobStatus: job.status },
      200,
    );
  }

  // Atomic transition. The `status IN ('pending','processing')` predicate is
  // what makes parallel cancel calls idempotent — only the first wins.
  const { data: updated, error: updErr } = await supabase
    .from("jobs")
    .update({ status: "cancelled", ended_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["pending", "processing"])
    .select("*")
    .maybeSingle();
  if (updErr) {
    logger.error("cancel-job: status update failed", { error: updErr.message });
    return jsonResponse({ error: "Failed to cancel job" }, 500);
  }
  if (!updated) {
    // Someone else won (parallel cancel or runner finalized between our
    // load + update). Treat as noop.
    return jsonResponse({ ok: true, jobId, status: "noop" }, 200);
  }

  // Flip every non-terminal item to `cancelled`. Pending items obviously stop;
  // `processing` items must ALSO be cancelled, otherwise an item that was
  // mid-flight at cancel time stays `processing` forever — the parent is now
  // `cancelled`, so `claimNextJob` will never re-claim the job and no worker
  // ever finalizes that item, leaving a permanent "Running" batch under a
  // Cancelled job. A live worker that finishes its in-flight item a beat later
  // simply overwrites it back to completed/failed (work already done is kept),
  // which is exactly the "items already finished are kept" contract.
  const { error: itemsErr } = await supabase
    .from("job_items")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("job_id", jobId)
    .in("status", ["pending", "processing"]);
  if (itemsErr) {
    // Don't fail the whole request — the parent is already cancelled. Log
    // and continue; the runner will not re-claim because of the parent
    // status guard, and these rows simply keep their prior status (the UI
    // collapses any leftover non-terminal batch to "Cancelled" for display).
    logger.warn("cancel-job: items update failed", {
      jobId,
      error: itemsErr.message,
    });
  }

  const tallies = await tallyJobItems(supabase, jobId);
  await insertCompletionNotification(
    supabase,
    updated as JobRow,
    tallies,
    "cancelled",
  );

  logger.info("cancel-job: job cancelled", {
    jobId,
    completed: tallies.completed,
    failed: tallies.failed,
    cancelled: tallies.cancelled,
  });

  return jsonResponse({ ok: true, jobId, status: "cancelled" }, 200);
};
