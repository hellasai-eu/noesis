/**
 * Generic background-job runner (issue #695, cron-driven since #762).
 *
 * Drives the lifecycle for any job type registered in `job-handlers.ts`:
 *
 *   pending → processing → completed | partially_completed | failed
 *
 * Design notes:
 *   * Edge functions hard-cap at ~180s. The runner processes a *slice* under
 *     a deadline (default 150s, leaving budget for finalize) and then
 *     exits. A pg_cron heartbeat (migration 20260628300000) re-invokes
 *     `run-jobs` ~once per minute; `claimNextJob` resumes any `processing`
 *     row left behind by the prior slice, so multi-slice jobs continue
 *     transparently across ticks. There is no in-process self-reschedule.
 *   * Concurrency safety uses atomic status transitions, not pg locks:
 *     `UPDATE … WHERE status='pending'` succeeds for at most one worker per
 *     row. With a 60s cron cadence and a 150s slice budget, up to ~3
 *     workers may overlap; they may co-process the same job's items but
 *     never the same item — the slower racer finds no pending items and
 *     exits.
 *   * Non-transactional: a failing item is recorded (`status='failed'`,
 *     `error`, `attempts++`) and does NOT abort siblings. The parent job's
 *     terminal status is derived from per-item totals.
 *   * Notifications are owner-scoped: on terminal state, the runner inserts
 *     exactly one `notifications` row for `jobs.created_by`. Skipped when
 *     the owner column has been nulled out (the schema allows ON DELETE SET
 *     NULL on `auth.users`).
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";
import {
  getJobHandler,
  type JobHandler,
  type JobItemRow,
  type JobRow,
} from "./job-handlers.ts";

// Slice budget: stop claiming new items at 150s so finalize + reschedule have
// room to land within the ~180s edge cap.
export const DEFAULT_SLICE_DEADLINE_MS = 150_000;

// Per-item soft cap for sanity-checking handler runtime in logs. Not enforced.
const ITEM_LOG_INTERVAL = 10;

// Lease durations (issue #763). The job lease must comfortably outlast a full
// slice (150s) plus a heartbeat gap; the item lease must outlast the slowest
// realistic single item (LLM calls ~30–90s). When a runner dies mid-slice,
// these are the upper bound on how long the row stays unclaimable.
export const JOB_LEASE_MS = 5 * 60_000;       // 5 min
export const ITEM_LEASE_MS = 3 * 60_000;      // 3 min
// Refresh the job lease every ~30s during a long slice so we don't expire
// under our own feet at the 5-minute boundary.
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Default per-item attempt cap when a row doesn't specify one (e.g., legacy
// rows inserted before the column existed). Matches the migration's DEFAULT.
export const DEFAULT_MAX_ATTEMPTS = 3;
// Sentinel "lease expired" timestamp: the Unix epoch as an ISO 8601 string.
// Writing this back when we voluntarily release a lease (mid-job slice exit)
// lets the next pg_cron tick claim immediately, with no idle gap.
export const LEASE_EXPIRED_ISO = "1970-01-01T00:00:00.000Z";

export interface RunJobSliceOptions {
  /** Override the wall-clock deadline (defaults to 150s). */
  deadlineMs?: number;
  /** Inject a clock for tests. Production passes `performance.now`. */
  now?: () => number;
  /**
   * Inject the wall-clock for lease timestamps. Tests need to set this to a
   * fixed Date so they can reason about `locked_until` values. Production
   * passes `Date.now` (which is what the runner uses by default).
   */
  wallClockNow?: () => number;
}

export interface RunJobSliceResult {
  jobId: string | null;
  jobType: string | null;
  processed: number;
  completed: number;
  failed: number;
  /**
   * True when the runner stopped due to the deadline and pending items still
   * remain — caller should self-reschedule.
   */
  moreWork: boolean;
  terminal: boolean;
}

/**
 * Claim the next runnable job.
 *
 * Returns the next row to drive, or `null` when the queue is idle.
 *
 * Lease semantics (#763): a job in `processing` whose `locked_until` is in
 * the future belongs to a live worker — leave it alone. A job in `processing`
 * whose lease has expired is treated as orphaned (worker died) and reclaimed.
 * A `pending` row has the migration's epoch default so it always passes the
 * `locked_until <= now` filter.
 *
 * Atomicity:
 *   1. Pull up to N candidates with `status IN (pending, processing) AND
 *      locked_until <= now`, ordered by `started_at NULLS FIRST, created_at`.
 *      That ordering keeps pending rows ahead of resumes, and within resumes
 *      the most-stale worker wins.
 *   2. For each candidate, try the atomic transition:
 *      • pending  → `status='processing', started_at=now, locked_until=now+lease`
 *        gated on `status='pending'`.
 *      • processing (orphan) → `locked_until=now+lease` gated on
 *        `status='processing' AND locked_until<=now` (the lte predicate is
 *        the race guard against a parallel reclaim).
 *   3. Return the first row whose update lands; `null` when all races lose.
 */
export async function claimNextJob(
  supabase: SupabaseClient,
  options: { wallClockNow?: () => number } = {},
): Promise<JobRow | null> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;

  const nowMs = (options.wallClockNow ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const leaseUntilIso = new Date(nowMs + JOB_LEASE_MS).toISOString();

  const { data: candidates, error: selErr } = await sb
    .from("jobs")
    .select("*")
    .in("status", ["pending", "processing"])
    .lte("locked_until", nowIso)
    .order("started_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(5);

  if (selErr) {
    logger.exception("claimNextJob: select failed", selErr);
    throw selErr;
  }
  if (!candidates || candidates.length === 0) return null;

  for (const candidate of candidates as JobRow[]) {
    if (candidate.status === "pending") {
      const { data: claimed, error: updErr } = await sb
        .from("jobs")
        .update({
          status: "processing",
          started_at: nowIso,
          locked_until: leaseUntilIso,
          last_heartbeat: nowIso,
        })
        .eq("id", candidate.id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();
      if (updErr) {
        logger.exception("claimNextJob: pending-claim update failed", updErr);
        throw updErr;
      }
      if (claimed) return claimed as JobRow;
      // Lost the race for this row; try the next candidate.
      continue;
    }

    // Orphan reclaim: candidate.status === 'processing' with expired lease.
    const { data: reclaimed, error: reclaimErr } = await sb
      .from("jobs")
      .update({
        locked_until: leaseUntilIso,
        last_heartbeat: nowIso,
      })
      .eq("id", candidate.id)
      .eq("status", "processing")
      .lte("locked_until", nowIso)
      .select("*")
      .maybeSingle();
    if (reclaimErr) {
      logger.exception("claimNextJob: reclaim update failed", reclaimErr);
      throw reclaimErr;
    }
    if (reclaimed) {
      logger.info("claimNextJob: reclaimed orphan job", {
        jobId: (reclaimed as JobRow).id,
      });
      return reclaimed as JobRow;
    }
    // Another worker reclaimed in the meantime; try the next candidate.
  }

  return null;
}

/**
 * Atomically claim the next runnable item for a job.
 *
 * Returns null when no claimable items remain. A "claimable" item is one
 * that's either `pending` or `processing` with an expired lease (#763 —
 * orphaned items from a dead worker are eligible for retry).
 *
 * Max-attempts gate: if `attempts + 1` would exceed the row's
 * `max_attempts`, the item is marked `failed` (with a "Max attempts reached"
 * error) instead of being re-claimed. This caps poison items at a finite
 * number of retries instead of looping forever across reclaims.
 *
 * Increments `attempts` on the same UPDATE so retries are counted.
 */
export async function claimNextItem(
  supabase: SupabaseClient,
  jobId: string,
  options: { wallClockNow?: () => number } = {},
): Promise<JobItemRow | null> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;

  const nowMs = (options.wallClockNow ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const leaseUntilIso = new Date(nowMs + ITEM_LEASE_MS).toISOString();

  const { data: candidates, error: selErr } = await sb
    .from("job_items")
    .select("id, attempts, max_attempts, status, locked_until, error")
    .eq("job_id", jobId)
    .in("status", ["pending", "processing"])
    .lte("locked_until", nowIso)
    .order("created_at", { ascending: true })
    .limit(5);

  if (selErr) {
    logger.exception("claimNextItem: select failed", selErr);
    throw selErr;
  }
  if (!candidates || candidates.length === 0) return null;

  for (const candidate of candidates) {
    const currentAttempts = (candidate.attempts ?? 0) as number;
    const maxAttempts = (candidate.max_attempts ?? DEFAULT_MAX_ATTEMPTS) as number;
    const nextAttempts = currentAttempts + 1;

    if (nextAttempts > maxAttempts) {
      // Max-attempts cap reached. Mark this row failed in place of claiming.
      // The same `lte(locked_until)` race guard keeps us from clobbering a
      // row that another worker reclaimed between our select and this update.
      //
      // Fidelity (#809): preserve the last real failure message so the batch
      // detail view surfaces *why* the item is dead instead of a useless
      // generic "Max attempts (N) reached". The prior error is capped so a
      // pathological string can't blow through the 2000-char column cap the
      // rest of the code path enforces (`markItemFailed`).
      const previousError = typeof candidate.error === "string" && candidate.error.length > 0
        ? candidate.error
        : null;
      const failMessage = previousError
        ? `Max attempts (${maxAttempts}) reached — last error: ${previousError}`.slice(0, 2000)
        : `Max attempts (${maxAttempts}) reached`;
      const { error: failErr } = await sb
        .from("job_items")
        .update({
          status: "failed",
          error: failMessage,
          updated_at: nowIso,
        })
        .eq("id", candidate.id)
        .in("status", ["pending", "processing"])
        .lte("locked_until", nowIso);
      if (failErr) {
        logger.exception("claimNextItem: max-attempts fail update", failErr, {
          itemId: candidate.id,
        });
        throw failErr;
      }
      logger.error("claimNextItem: item exceeded max attempts — marked failed", {
        jobId,
        itemId: candidate.id,
        attempts: currentAttempts,
        maxAttempts,
      });
      // Try the next candidate.
      continue;
    }

    const { data: claimed, error: updErr } = await sb
      .from("job_items")
      .update({
        status: "processing",
        attempts: nextAttempts,
        locked_until: leaseUntilIso,
        last_heartbeat: nowIso,
        updated_at: nowIso,
      })
      .eq("id", candidate.id)
      .in("status", ["pending", "processing"])
      .lte("locked_until", nowIso)
      .select("*")
      .maybeSingle();

    if (updErr) {
      logger.exception("claimNextItem: claim update failed", updErr);
      throw updErr;
    }
    if (claimed) return claimed as JobItemRow;
    // Lost the race for this row; try the next one.
  }

  return null;
}

/**
 * Refresh the job's lease and `last_heartbeat`. Best-effort: failures are
 * logged but don't abort the slice — the worst case is an early lease expiry
 * that a concurrent reclaim handles correctly anyway.
 */
async function heartbeatJobLease(
  supabase: SupabaseClient,
  jobId: string,
  nowMs: number,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const nowIso = new Date(nowMs).toISOString();
  const leaseUntilIso = new Date(nowMs + JOB_LEASE_MS).toISOString();
  const { error } = await sb
    .from("jobs")
    .update({ locked_until: leaseUntilIso, last_heartbeat: nowIso })
    .eq("id", jobId)
    .eq("status", "processing");
  if (error) {
    logger.exception("heartbeatJobLease: refresh failed", error, { jobId });
  }
}

/**
 * Refresh one item's lease. Best-effort, same rationale as
 * `heartbeatJobLease`. Gated on `status='processing'` so a completed or
 * failed item is never resurrected by a late timer tick.
 */
async function heartbeatItemLease(
  supabase: SupabaseClient,
  itemId: string,
  nowMs: number,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const nowIso = new Date(nowMs).toISOString();
  const leaseUntilIso = new Date(nowMs + ITEM_LEASE_MS).toISOString();
  const { error } = await sb
    .from("job_items")
    .update({ locked_until: leaseUntilIso, last_heartbeat: nowIso })
    .eq("id", itemId)
    .eq("status", "processing");
  if (error) {
    logger.exception("heartbeatItemLease: refresh failed", error, { itemId });
  }
}

/**
 * Run `fn` while keeping the item's lease alive (#991 review).
 *
 * `claimNextItem` stamps `locked_until = now + ITEM_LEASE_MS` (3 min) once and
 * nothing refreshes it — the slice loop only heartbeats the *job* lease, and
 * it cannot heartbeat the item anyway because it is blocked awaiting
 * `processItem`. That is fine for handlers whose model calls finish in the
 * 30-90s this file's lease comment assumes, but a handler that legitimately
 * runs longer (study guide generation polls a high-reasoning call for up to
 * 240s) would have its lease expire mid-flight, letting the next cron tick
 * reclaim the item and run it a second time — duplicate content and duplicate
 * model charges.
 *
 * Handlers whose single item can exceed ITEM_LEASE_MS must wrap their long
 * call in this. The timer is always cleared, including on throw.
 */
export async function withItemLeaseHeartbeat<T>(
  supabase: SupabaseClient,
  itemId: string,
  fn: () => Promise<T>,
  options: { intervalMs?: number; wallClockNow?: () => number } = {},
): Promise<T> {
  const now = options.wallClockNow ?? Date.now;
  const timer = setInterval(() => {
    void heartbeatItemLease(supabase, itemId, now());
  }, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Release the job's lease on a clean mid-job slice exit so the next pg_cron
 * tick can pick the row up immediately instead of waiting for the lease to
 * naturally expire. Only call when the job is still `processing` with more
 * work pending — never when the job is terminal (status update would race
 * with finalize) or when we hit a non-recoverable error mid-slice.
 */
async function releaseJobLease(
  supabase: SupabaseClient,
  jobId: string,
  nowMs: number,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const nowIso = new Date(nowMs).toISOString();
  const { error } = await sb
    .from("jobs")
    .update({ locked_until: LEASE_EXPIRED_ISO, last_heartbeat: nowIso })
    .eq("id", jobId)
    .eq("status", "processing");
  if (error) {
    logger.exception("releaseJobLease: release failed", error, { jobId });
  }
}

async function markItemCompleted(
  supabase: SupabaseClient,
  itemId: string,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const { error } = await sb
    .from("job_items")
    .update({
      status: "completed",
      result: result ?? {},
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId);
  if (error) {
    logger.exception("markItemCompleted: update failed", error, { itemId });
    throw error;
  }
}

async function markItemFailed(
  supabase: SupabaseClient,
  itemId: string,
  errorMessage: string,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const { error } = await sb
    .from("job_items")
    .update({
      status: "failed",
      error: errorMessage.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", itemId);
  if (error) {
    logger.exception("markItemFailed: update failed", error, { itemId });
    throw error;
  }
}

interface JobItemTallies {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export async function tallyJobItems(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobItemTallies> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const { data, error } = await sb
    .from("job_items")
    .select("status")
    .eq("job_id", jobId);
  if (error) {
    logger.exception("tallyJobItems: select failed", error, { jobId });
    throw error;
  }
  const tallies: JobItemTallies = {
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const row of (data as Array<{ status: string }> | null) ?? []) {
    tallies.total++;
    const key = row.status as keyof JobItemTallies;
    if (key in tallies && key !== "total") {
      tallies[key]++;
    }
  }
  return tallies;
}

async function persistJobProgress(
  supabase: SupabaseClient,
  job: JobRow,
  tallies: JobItemTallies,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  // Re-read current progress before merging — handlers may write their own
  // cumulative fields (e.g. bulk_question_generation's created_total) between
  // claim time and now. Spreading the stale `job.progress` snapshot would
  // silently erase those fields on every flush.
  const { data: current, error: readErr } = await sb
    .from("jobs")
    .select("progress")
    .eq("id", job.id)
    .maybeSingle();
  if (readErr) {
    logger.exception("persistJobProgress: read failed", readErr, { jobId: job.id });
    return;
  }
  const base = (current?.progress && typeof current.progress === "object"
    ? current.progress
    : job.progress) as Record<string, unknown>;
  const progress = {
    ...base,
    total: tallies.total,
    completed: tallies.completed,
    failed: tallies.failed,
    pending: tallies.pending,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb
    .from("jobs")
    .update({ progress })
    .eq("id", job.id);
  if (error) {
    logger.exception("persistJobProgress: update failed", error, { jobId: job.id });
    // Progress writes are best-effort: don't abort the slice.
  }
}

export type TerminalNotificationStatus =
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

function summarizeForNotification(
  job: JobRow,
  tallies: JobItemTallies,
  finalStatus: TerminalNotificationStatus,
): { title: string; body: string } {
  const title = finalStatus === "completed"
    ? "Job completed"
    : finalStatus === "partially_completed"
    ? "Job partially completed"
    : finalStatus === "cancelled"
    ? "Job cancelled"
    : "Job failed";
  const total = tallies.total;
  const ok = tallies.completed;
  const fail = tallies.failed;
  if (finalStatus === "cancelled") {
    // Cancellation summary highlights what we kept vs threw away. `cancelled`
    // counts items that never started; `ok`/`fail` are work that finished
    // before the user stopped the job.
    const cancelled = tallies.cancelled;
    const parts: string[] = [];
    if (ok > 0) parts.push(`${ok} completed`);
    if (fail > 0) parts.push(`${fail} failed`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    const body = parts.length > 0
      ? `${parts.join(", ")} of ${total} item${total === 1 ? "" : "s"}.`
      : `Job type "${job.type}" was cancelled.`;
    return { title, body };
  }
  const body = total > 0
    ? `${ok}/${total} item${total === 1 ? "" : "s"} completed${fail > 0 ? `, ${fail} failed` : ""}.`
    : `Job type "${job.type}" produced no items.`;
  return { title, body };
}

/**
 * Insert the single owner-scoped completion notification for a terminal job.
 *
 * Exported so the `cancel-job` edge function can reuse the same code path
 * (#723) instead of duplicating the title/body summary + insert.
 */
export async function insertCompletionNotification(
  supabase: SupabaseClient,
  job: JobRow,
  tallies: JobItemTallies,
  finalStatus: TerminalNotificationStatus,
): Promise<void> {
  if (!job.created_by) {
    logger.info("insertCompletionNotification: skipping (owner is null)", { jobId: job.id });
    return;
  }
  const { title, body } = summarizeForNotification(job, tallies, finalStatus);
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const { error } = await sb.from("notifications").insert({
    user_id: job.created_by,
    job_id: job.id,
    type: `job.${finalStatus}`,
    title,
    body,
  });
  if (error) {
    logger.exception("insertCompletionNotification: insert failed", error, { jobId: job.id });
    // We don't throw — the job is already terminal in the DB; the worst case
    // is a missing notification, not a stuck job.
  }
}

/**
 * Compute terminal status from item tallies and write it back.
 *
 * Idempotent: only acts when the job is still `processing` — a second call
 * after termination is a no-op (no duplicate notifications).
 */
export async function finalizeJob(
  supabase: SupabaseClient,
  job: JobRow,
): Promise<{ finalized: boolean; status: JobRow["status"] }> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;

  // Re-read so we don't overwrite a parallel finalize.
  const { data: current, error: readErr } = await sb
    .from("jobs")
    .select("*")
    .eq("id", job.id)
    .maybeSingle();
  if (readErr) {
    logger.exception("finalizeJob: re-read failed", readErr, { jobId: job.id });
    throw readErr;
  }
  if (!current) return { finalized: false, status: job.status };
  if (current.status !== "processing") {
    return { finalized: false, status: current.status };
  }

  const tallies = await tallyJobItems(supabase, job.id);

  // Only finalize when no work remains in flight.
  if (tallies.pending > 0 || tallies.processing > 0) {
    return { finalized: false, status: current.status };
  }

  let finalStatus: "completed" | "partially_completed" | "failed";
  if (tallies.total === 0) {
    // No items at all — treat as completed (a no-op job is a success).
    finalStatus = "completed";
  } else if (tallies.completed === tallies.total) {
    finalStatus = "completed";
  } else if (tallies.completed === 0) {
    finalStatus = "failed";
  } else {
    finalStatus = "partially_completed";
  }

  const result = {
    ...(current.result ?? {}),
    total: tallies.total,
    completed: tallies.completed,
    failed: tallies.failed,
    cancelled: tallies.cancelled,
  };

  const { data: updated, error: updErr } = await sb
    .from("jobs")
    .update({
      status: finalStatus,
      ended_at: new Date().toISOString(),
      result,
    })
    .eq("id", job.id)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();
  if (updErr) {
    logger.exception("finalizeJob: status update failed", updErr, { jobId: job.id });
    throw updErr;
  }
  if (!updated) {
    // Another worker beat us to finalization.
    return { finalized: false, status: current.status };
  }

  await insertCompletionNotification(supabase, updated as JobRow, tallies, finalStatus);
  return { finalized: true, status: finalStatus };
}

/**
 * Mark the job `failed` with an error message and notify the owner.
 *
 * Used both for the "no handler registered" case and for handler-level
 * preconditions that abort before any items run (e.g. expandJob throws).
 * Idempotent against parallel finalize (`status = 'processing'` predicate).
 */
async function failJobWithError(
  supabase: SupabaseClient,
  job: JobRow,
  errorMessage: string,
): Promise<void> {
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const { data: updated, error: updErr } = await sb
    .from("jobs")
    .update({
      status: "failed",
      ended_at: new Date().toISOString(),
      error: errorMessage,
    })
    .eq("id", job.id)
    .eq("status", "processing")
    .select("*")
    .maybeSingle();
  if (updErr) {
    logger.exception("failJobWithError: update failed", updErr, { jobId: job.id });
    throw updErr;
  }
  if (!updated) return; // someone else finalized
  const tallies = await tallyJobItems(supabase, job.id);
  await insertCompletionNotification(supabase, updated as JobRow, tallies, "failed");
}

/**
 * Fail the parent job cleanly when no handler is registered for its type.
 *
 * Marks the job `failed`, sets `error`, sets `ended_at`, and emits a
 * notification. Items (if any) are not touched — they stay pending until an
 * operator either registers a handler or cancels the job.
 */
async function failJobWithUnknownType(
  supabase: SupabaseClient,
  job: JobRow,
): Promise<void> {
  await failJobWithError(
    supabase,
    job,
    `No handler registered for job type "${job.type}"`,
  );
}

/**
 * Drive one slice of work. Claims a job, claims items, dispatches each to the
 * registered handler, persists progress, and finalizes when the queue is
 * empty. Returns `moreWork=true` when the deadline halted us with items
 * still pending — the caller should self-reschedule.
 */
export async function runJobSlice(
  supabase: SupabaseClient,
  options: RunJobSliceOptions = {},
): Promise<RunJobSliceResult> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_SLICE_DEADLINE_MS;
  const now = options.now ?? (() => performance.now());
  const wallClockNow = options.wallClockNow ?? (() => Date.now());
  const startedAt = now();
  const claimOpts = { wallClockNow };

  const job = await claimNextJob(supabase, claimOpts);
  if (!job) {
    return {
      jobId: null,
      jobType: null,
      processed: 0,
      completed: 0,
      failed: 0,
      moreWork: false,
      terminal: false,
    };
  }

  logger.info("Claimed job", { jobId: job.id, jobType: job.type });

  const handler: JobHandler | undefined = getJobHandler(job.type);
  if (!handler) {
    logger.error("No handler registered for job type — failing job", { jobType: job.type });
    await failJobWithUnknownType(supabase, job);
    return {
      jobId: job.id,
      jobType: job.type,
      processed: 0,
      completed: 0,
      failed: 0,
      moreWork: false,
      terminal: true,
    };
  }

  let processed = 0;
  let completed = 0;
  let failed = 0;

  // One-shot expansion: handlers like #697 build job_items from job.params
  // the first time the job is seen. Idempotent — only fires when no items
  // exist yet, so resumes after a slice boundary skip it cleanly.
  if (typeof handler.expandJob === "function") {
    const initialTallies = await tallyJobItems(supabase, job.id);
    if (initialTallies.total === 0) {
      try {
        const expansion = await handler.expandJob({ supabase, job });
        logger.info("expandJob completed", {
          jobId: job.id,
          jobType: job.type,
          inserted: expansion.inserted,
        });
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        logger.error("expandJob failed — failing parent job", {
          jobId: job.id,
          jobType: job.type,
          error: message,
        });
        await failJobWithError(supabase, job, `expandJob: ${message}`);
        return {
          jobId: job.id,
          jobType: job.type,
          processed: 0,
          completed: 0,
          failed: 0,
          moreWork: false,
          terminal: true,
        };
      }
    }
  }

  let cancelled = false;
  // Check for mid-flight cancellation every N items rather than every iteration
  // to avoid doubling DB round-trips on large jobs. The worst-case lag before
  // the worker notices a cancel is CANCEL_CHECK_INTERVAL items. We also check
  // once when no item is available — items drying up may mean cancellation
  // swept the remaining pending rows rather than the job being complete.
  const CANCEL_CHECK_INTERVAL = 5;
  // deno-lint-ignore no-explicit-any
  const sb = supabase as any;
  const checkCancelled = async (): Promise<boolean> => {
    const { data: latest } = await sb
      .from("jobs")
      .select("status")
      .eq("id", job.id)
      .maybeSingle();
    if (latest?.status === "cancelled") {
      logger.info("runJobSlice: detected cancellation, stopping claim loop", {
        jobId: job.id,
      });
      return true;
    }
    return false;
  };
  // Track when we last refreshed the job lease so we don't expire under our
  // own feet on a long slice. claimNextJob already set locked_until to
  // now+JOB_LEASE_MS, so anchor the heartbeat clock at the slice start.
  let lastHeartbeatMs = wallClockNow();
  while (now() - startedAt < deadlineMs) {
    if (processed % CANCEL_CHECK_INTERVAL === 0 && await checkCancelled()) {
      cancelled = true;
      break;
    }

    // Refresh the job lease before claiming the next item so a concurrent
    // reclaim doesn't race us into a no-op state mid-loop.
    const wallNowMs = wallClockNow();
    if (wallNowMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
      await heartbeatJobLease(supabase, job.id, wallNowMs);
      lastHeartbeatMs = wallNowMs;
    }

    const item = await claimNextItem(supabase, job.id, claimOpts);
    if (!item) {
      cancelled = await checkCancelled();
      break;
    }

    try {
      const { result } = await handler.processItem({ supabase, job, item });
      await markItemCompleted(supabase, item.id, result);
      completed++;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logger.error("Job item failed", { jobId: job.id, itemId: item.id, error: message });
      await markItemFailed(supabase, item.id, message);
      failed++;
    }
    processed++;

    if (processed % ITEM_LOG_INTERVAL === 0) {
      const tallies = await tallyJobItems(supabase, job.id);
      await persistJobProgress(supabase, job, tallies);
    }
  }

  const tallies = await tallyJobItems(supabase, job.id);
  await persistJobProgress(supabase, job, tallies);

  // When the job was cancelled mid-slice, the cancel handler already set
  // status='cancelled' + ended_at + notification. We must NOT call
  // finalizeJob (its `status='processing'` predicate already blocks the
  // write, but the early return keeps the intent explicit and prevents a
  // future maintainer from re-reading items and recomputing a terminal).
  if (cancelled) {
    return {
      jobId: job.id,
      jobType: job.type,
      processed,
      completed,
      failed,
      moreWork: false,
      terminal: true,
    };
  }

  // Decide between finalize and reschedule based on what's still queued.
  const moreWork = tallies.pending > 0 || tallies.processing > 0;
  let terminal = false;
  if (!moreWork) {
    const fin = await finalizeJob(supabase, job);
    terminal = fin.finalized;
  } else {
    // Mid-slice exit (deadline reached, work remains). Release the lease so
    // the next pg_cron tick can reclaim immediately instead of waiting for
    // the 5-minute lease to expire on its own.
    await releaseJobLease(supabase, job.id, wallClockNow());
  }

  return {
    jobId: job.id,
    jobType: job.type,
    processed,
    completed,
    failed,
    moreWork,
    terminal,
  };
}

/** Create a service-role Supabase client for the worker. */
export function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceKey);
}
