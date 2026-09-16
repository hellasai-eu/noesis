/**
 * Job handler registry.
 *
 * Each long-running background job type (e.g. bulk question generation) plugs
 * into the generic runner (#695) by implementing `JobHandler` and registering
 * itself via `registerJobHandler()`. The runner dispatches per-item work to
 * `processItem`; the handler owns the unit-of-work logic, the registry owns
 * lookup, and the runner owns lifecycle + notification.
 *
 * Handlers self-register on import — the worker function imports
 * `_shared/registered-job-handlers.ts` to pull them all in.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type JobItemStatus = "pending" | "processing" | "completed" | "failed" | "cancelled";
export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

export interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  params: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  created_by: string | null;
  institution_id: string;
  course_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  locked_until: string;
  last_heartbeat: string | null;
}

export interface JobItemRow {
  id: string;
  job_id: string;
  item_key: string;
  item_type: string | null;
  status: JobItemStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
  locked_until: string;
  last_heartbeat: string | null;
}

export interface JobItemHandlerCtx {
  supabase: SupabaseClient;
  job: JobRow;
  item: JobItemRow;
}

export interface JobItemHandlerResult {
  /** Persisted into job_items.result on success. */
  result?: Record<string, unknown>;
}

export interface JobExpandHandlerCtx {
  supabase: SupabaseClient;
  job: JobRow;
}

export interface JobExpandHandlerResult {
  /** Number of new `job_items` rows the handler inserted. */
  inserted: number;
}

export interface JobHandler {
  /** Matches `jobs.type`. */
  type: string;
  /**
   * Optional expansion hook. Called once by the runner after the job is
   * claimed, only when no `job_items` rows exist for this job yet. The
   * handler reads `job.params` and inserts the per-unit work into
   * `job_items`. Idempotency is enforced by the runner's guard (no items
   * → call; items present → skip); throwing aborts the job cleanly.
   *
   * Bulk-style jobs (e.g. #697 bulk_question_generation) use this to fan
   * out chapters × types into individual items. Simple jobs that are
   * enqueued with their items inline can leave it undefined.
   */
  expandJob?: (ctx: JobExpandHandlerCtx) => Promise<JobExpandHandlerResult>;
  /**
   * Process a single job item to completion. Throw on failure — the runner
   * catches the error, marks just this item failed, and continues with
   * siblings. Sibling items must not be aborted by a single item's failure.
   */
  processItem: (ctx: JobItemHandlerCtx) => Promise<JobItemHandlerResult>;
}

const registry = new Map<string, JobHandler>();

export function registerJobHandler(handler: JobHandler): void {
  if (registry.has(handler.type)) {
    // Last-write-wins: tests re-import and re-register; this is fine because
    // handler implementations are functionally identical per type.
    registry.set(handler.type, handler);
    return;
  }
  registry.set(handler.type, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return registry.get(type);
}

export function listRegisteredJobTypes(): string[] {
  return Array.from(registry.keys());
}

/** Testing helper — wipe the registry between tests. */
export function _clearJobHandlerRegistry(): void {
  registry.clear();
}
