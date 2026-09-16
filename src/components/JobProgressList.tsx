import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Clock,
  RefreshCw,
  Ban,
  PlayCircle,
  RotateCw,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { QUESTION_TYPE_LABELS } from "@/lib/unified-question";
import type { QuestionType } from "@/types/question";
import { useFormatters } from "@/i18n/formatters";

// Generic job-progress list (issue #699; #723 added cancel + global mode).
//
// Subscribes to realtime INSERTs and UPDATEs on `public.jobs` and renders one
// card per job. When `courseId` is provided the list is filtered to that
// course; otherwise it falls back to "all jobs the caller can see" (RLS
// already scopes this — institution admins see institution-wide, instructors
// see their courses, regular users see their own). The list knows nothing
// about `bulk_question_generation` specifically — fields like `created_total`
// / `failed_total` render only when present so future job types stay clean.

interface JobRow {
  id: string;
  type: string;
  status: string;
  progress: Record<string, unknown> | null;
  course_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
  // Added in #763: lease semantics. `locked_until` is the runner's *reclaim*
  // predicate, NOT a stall signal — the runner writes it to the Unix epoch on
  // every clean mid-slice exit so the next tick reclaims immediately, which
  // leaves a healthy multi-slice job with a past `locked_until` between ticks.
  // Kept on the type for realtime payloads but no longer used for the badge.
  locked_until?: string | null;
  // `last_heartbeat` is refreshed on claim, on each ~30s heartbeat, AND on a
  // clean lease release, so its freshness — unlike `locked_until` — reliably
  // distinguishes a live worker from a dead one. This drives the Stalled badge.
  last_heartbeat?: string | null;
}

interface JobProgressListProps {
  /** Filter to a single course. Omit to show every job visible to the caller. */
  courseId?: string;
  /** Heading rendered above the list. Override to localize / re-purpose. */
  heading?: string;
  /** Cap the number of jobs displayed. Defaults to 10 (newest first). */
  limit?: number;
}

const TERMINAL_STATUSES = new Set(["completed", "partially_completed", "failed", "cancelled"]);

// A `processing` job is considered stalled when its heartbeat
// (`progress.updated_at`, falling back to `started_at`) hasn't advanced in
// this many ms. Comfortably above the runner's 150s slice deadline +
// startup so a healthy worker never trips the badge.
// Exported so the test suite can import the exact threshold.
export const STALL_THRESHOLD_MS = 5 * 60_000;

// How often the component re-evaluates `isStalled` without waiting for a
// realtime UPDATE. Cheap: a single state bump per tick on whatever cards
// are visible.
const STALL_TICK_MS = 30_000;

function jobHeartbeatMs(job: JobRow): number | null {
  // Prefer the purpose-built `last_heartbeat` column (refreshed on claim, on
  // each ~30s heartbeat, and on a clean lease release). Fall back to the
  // progress timestamp and finally `started_at` for legacy rows that predate
  // the column or haven't persisted progress yet.
  const fromProgress = job.progress && typeof job.progress === "object"
    ? (job.progress as Record<string, unknown>).updated_at
    : null;
  const candidate = (typeof job.last_heartbeat === "string" ? job.last_heartbeat : null)
    ?? (typeof fromProgress === "string" ? fromProgress : null)
    ?? job.started_at;
  if (!candidate) return null;
  const t = new Date(candidate).getTime();
  return Number.isFinite(t) ? t : null;
}

function isJobStalled(job: JobRow, now: number): boolean {
  if (job.status !== "processing") return false;
  // Stall = "no worker has touched this job in a long time", measured by
  // heartbeat freshness. We deliberately do NOT key off `locked_until`: the
  // runner sets it to the Unix epoch on every clean mid-slice exit so the next
  // pg_cron tick can reclaim the row instantly, which means a perfectly
  // healthy multi-slice job sits with a past `locked_until` during the gap
  // between ticks. Keying off the lease flagged every such job as "Stalled"
  // (the "always stalled" bug). `last_heartbeat` stays fresh across those
  // clean releases and only ages out when the worker actually dies.
  const hb = jobHeartbeatMs(job);
  if (hb === null) return false;
  return now - hb > STALL_THRESHOLD_MS;
}

// Retry is offered for:
//   * jobs that ended unhappily (failed, partially_completed, cancelled);
//   * jobs sitting in `processing` whose heartbeat has gone stale — a worker
//     died and the row would otherwise wait for the next pg_cron tick (#762).
// Completed jobs and live (recently-heartbeating) processing jobs are not
// retryable here.
function isJobRetryable(job: JobRow, now: number): boolean {
  if (
    job.status === "failed" ||
    job.status === "partially_completed" ||
    job.status === "cancelled"
  ) {
    return true;
  }
  return job.status === "processing" && isJobStalled(job, now);
}

function humanizeType(type: string): string {
  // Replace underscores with spaces and title-case.
  return type
    .split("_")
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function statusBadge(status: string, stalled = false) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="w-3 h-3" />
          Pending
        </Badge>
      );
    case "processing":
      if (stalled) {
        return (
          <Badge
            variant="secondary"
            className="gap-1 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100"
            data-testid="job-stalled-badge"
          >
            <AlertTriangle className="w-3 h-3" />
            Stalled
          </Badge>
        );
      }
      return (
        <Badge variant="secondary" className="gap-1 bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100">
          <Loader2 className="w-3 h-3 animate-spin" />
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="secondary" className="gap-1 bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100">
          <CheckCircle className="w-3 h-3" />
          Completed
        </Badge>
      );
    case "partially_completed":
      return (
        <Badge variant="secondary" className="gap-1 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
          <AlertTriangle className="w-3 h-3" />
          Partial
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="w-3 h-3" />
          Failed
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="gap-1">
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function progressPct(progress: Record<string, unknown> | null): number | null {
  if (!progress) return null;
  const total = typeof progress.total === "number" ? progress.total : null;
  const completed = typeof progress.completed === "number" ? progress.completed : null;
  const failed = typeof progress.failed === "number" ? progress.failed : 0;
  if (total === null || completed === null || total <= 0) return null;
  const done = Math.min(total, completed + failed);
  return Math.round((done / total) * 100);
}

function progressLabel(progress: Record<string, unknown> | null): string | null {
  if (!progress) return null;
  const total = typeof progress.total === "number" ? progress.total : null;
  const completed = typeof progress.completed === "number" ? progress.completed : null;
  const failed = typeof progress.failed === "number" ? progress.failed : null;
  if (total === null || completed === null) return null;
  return `${completed}/${total} batches${failed && failed > 0 ? ` · ${failed} failed` : ""}`;
}

function extrasLabel(progress: Record<string, unknown> | null): string | null {
  if (!progress) return null;
  const created = typeof progress.created_total === "number" ? progress.created_total : null;
  const failed = typeof progress.failed_total === "number" ? progress.failed_total : null;
  if (created === null && failed === null) return null;
  const parts: string[] = [];
  if (created !== null) parts.push(`${created} created`);
  if (failed !== null && failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

// ── Per-batch detail view (issue #809) ────────────────────────────────────
//
// A job carries N `job_items` — one per (chapter × question type) batch. When
// the user expands a card we lazy-fetch that job's items, resolve chapter
// titles via `material_chapters`, and render one row per batch with its status
// and (for failed rows) the error message. Live jobs subscribe to
// postgres_changes on `job_items` filtered by `job_id` so completing/failing
// batches update without a refetch.
//
// The component is deliberately generic: it doesn't hard-code the
// `bulk_question_generation` job type. Any item whose payload carries
// `chapterId` + whose `item_type` is a `QuestionType` gets the rich label;
// otherwise we fall back to `item_key` verbatim so future job types still get
// a working detail view instead of a crash.

interface JobItemRow {
  id: string;
  item_key: string;
  item_type: string | null;
  status: string;
  error: string | null;
  attempts: number;
  payload: Record<string, unknown> | null;
  updated_at: string;
}

// Sort order for the batch list: failed first (users open the drawer to
// understand failures), then work still in flight, then queued, then anything
// that finished cleanly. Within a bucket, freshest activity first.
const ITEM_STATUS_ORDER: Record<string, number> = {
  failed: 0,
  processing: 1,
  pending: 2,
  cancelled: 3,
  completed: 4,
};

function itemChapterId(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).chapterId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function itemTypeLabel(item: JobItemRow): string {
  const t = item.item_type;
  if (t && (t in QUESTION_TYPE_LABELS)) return QUESTION_TYPE_LABELS[t as QuestionType];
  if (t && t.length > 0) return t;
  return item.item_key;
}

// A batch's *displayed* status. When the parent job is terminal (cancelled /
// failed / completed), no worker will ever advance its items again — so a row
// left in `pending`/`processing` is not actually running. `cancel-job` cleans
// up pending items, but an item that was mid-flight (`processing`) at cancel
// time stays `processing` in the DB, which would otherwise render as a
// spinning "Running" badge under a Cancelled job. Collapse those to
// `cancelled` for display so the batch list can never contradict its parent.
function effectiveItemStatus(status: string, parentTerminal: boolean): string {
  if (parentTerminal && (status === "pending" || status === "processing")) {
    return "cancelled";
  }
  return status;
}

function itemStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="w-3 h-3" />
          Pending
        </Badge>
      );
    case "processing":
      return (
        <Badge variant="secondary" className="gap-1 bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100">
          <Loader2 className="w-3 h-3 animate-spin" />
          Running
        </Badge>
      );
    case "completed":
      return (
        <Badge variant="secondary" className="gap-1 bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100">
          <CheckCircle className="w-3 h-3" />
          Done
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="w-3 h-3" />
          Failed
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="gap-1">
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface JobItemsListProps {
  jobId: string;
  /** Terminal jobs skip the realtime subscription — nothing will change. */
  isTerminal: boolean;
}

function JobItemsList({ jobId, isTerminal }: JobItemsListProps) {
  const { compareText } = useFormatters();
  const [items, setItems] = useState<JobItemRow[] | null>(null);
  const [chapterTitles, setChapterTitles] = useState<Record<string, string>>({});
  // Ref so the realtime INSERT handler can read chapterTitles without adding it
  // to the useEffect dep array (which would tear down the channel on every title
  // resolution and silently drop events during the gap).
  const chapterTitlesRef = useRef<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    (async () => {
      const { data, error } = await supabase
        .from("job_items")
        .select("id, item_key, item_type, status, error, attempts, payload, updated_at")
        .eq("job_id", jobId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      if (error) {
        setFetchError(error.message ?? "Failed to load batches");
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as JobItemRow[];
      setItems(rows);
      setLoading(false);

      // One follow-up query to resolve chapter titles. Empty payloads (or
      // non-bulk_question_generation items) just skip it.
      const ids = Array.from(
        new Set(
          rows
            .map((r) => itemChapterId(r.payload))
            .filter((id): id is string => id !== null),
        ),
      );
      if (ids.length === 0) return;
      const { data: chapters, error: chErr } = await supabase
        .from("material_chapters")
        .select("id, title")
        .in("id", ids);
      if (cancelled) return;
      if (chErr) {
        // Not fatal — the batch list still renders with raw chapter ids.
        console.warn("Failed to load chapter titles for job detail", chErr);
        return;
      }
      const next: Record<string, string> = {};
      for (const row of (chapters ?? []) as Array<{ id: string; title: string }>) {
        next[row.id] = row.title;
      }
      setChapterTitles(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, reloadTick]);

  // Keep the ref in sync so the realtime handler always sees current titles.
  useEffect(() => {
    chapterTitlesRef.current = chapterTitles;
  }, [chapterTitles]);

  // Realtime: only useful while the job is still doing work. For terminal jobs
  // the historical batch list is static — skip the channel.
  useEffect(() => {
    if (isTerminal) return;
    const channel = supabase
      .channel(`job-items-${jobId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "job_items",
          filter: `job_id=eq.${jobId}`,
        },
        (payload) => {
          const row = payload.new as JobItemRow;
          setItems((prev) => {
            if (!prev) return prev;
            if (prev.some((i) => i.id === row.id)) return prev;
            return [...prev, row];
          });
          // A late-inserted item may reference a chapter we haven't resolved yet.
          // Read from ref (not state) so this handler doesn't force the channel
          // to be rebuilt whenever titles arrive.
          const chId = itemChapterId(row.payload);
          if (chId && !chapterTitlesRef.current[chId]) {
            supabase
              .from("material_chapters")
              .select("id, title")
              .eq("id", chId)
              .maybeSingle()
              .then(({ data }) => {
                const title = (data as { title?: string } | null)?.title;
                if (title) {
                  setChapterTitles((prev) => ({ ...prev, [chId]: title }));
                }
              });
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "job_items",
          filter: `job_id=eq.${jobId}`,
        },
        (payload) => {
          const row = payload.new as JobItemRow;
          setItems((prev) => {
            if (!prev) return prev;
            return prev.map((i) => (i.id === row.id ? { ...i, ...row } : i));
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [jobId, isTerminal]);

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 pt-2 text-xs text-muted-foreground"
        data-testid="job-items-loading"
      >
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading batches…
      </div>
    );
  }
  if (fetchError) {
    return (
      <div className="pt-2 text-xs text-destructive flex items-center gap-2">
        <span>Failed to load batches: {fetchError}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setReloadTick((t) => t + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <p className="pt-2 text-xs text-muted-foreground" data-testid="job-items-empty">
        No batches yet.
      </p>
    );
  }

  const sorted = [...items].sort((a, b) => {
    const oa = ITEM_STATUS_ORDER[effectiveItemStatus(a.status, isTerminal)] ?? 99;
    const ob = ITEM_STATUS_ORDER[effectiveItemStatus(b.status, isTerminal)] ?? 99;
    if (oa !== ob) return oa - ob;
    // Freshest activity first within a bucket.
    return compareText((b.updated_at ?? ""), a.updated_at ?? "");
  });

  return (
    <div className="pt-2 space-y-1.5" data-testid="job-items-list">
      {sorted.map((item) => {
        const chId = itemChapterId(item.payload);
        const chapterTitle = chId ? chapterTitles[chId] ?? chId : null;
        const typeLabel = itemTypeLabel(item);
        const displayStatus = effectiveItemStatus(item.status, isTerminal);
        return (
          <div
            key={item.id}
            className="flex items-start justify-between gap-2 rounded-sm border-l-2 pl-2 py-1 text-xs bg-muted/30"
            style={{
              borderLeftColor:
                displayStatus === "failed"
                  ? "hsl(var(--destructive))"
                  : "transparent",
            }}
            data-testid="job-item-row"
            data-status={displayStatus}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {chapterTitle ? (
                  <span className="font-medium">{chapterTitle}</span>
                ) : (
                  <span className="font-mono text-muted-foreground">{item.item_key}</span>
                )}
                <span className="text-muted-foreground"> · </span>
                <span>{typeLabel}</span>
              </div>
              {displayStatus === "failed" && item.error && (
                <div
                  className="text-destructive break-words mt-0.5"
                  data-testid="job-item-error"
                >
                  {item.error}
                </div>
              )}
            </div>
            <div className="shrink-0">{itemStatusBadge(displayStatus)}</div>
          </div>
        );
      })}
    </div>
  );
}

export function JobProgressList({ courseId, heading = "Background jobs", limit = 10 }: JobProgressListProps) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [realtimeOk, setRealtimeOk] = useState(true);
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const [resuming, setResuming] = useState<Record<string, boolean>>({});
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  // The Retry action is gated to admin / super-admin (issue #764). Resolved
  // once on mount via the existing role RPCs; null = not yet checked.
  const [canRetry, setCanRetry] = useState<boolean | null>(null);
  // Forces re-evaluation of `isJobStalled` between realtime UPDATEs so the
  // badge appears the moment the heartbeat threshold is crossed without
  // waiting for an unrelated re-render.
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Job cards whose per-batch detail is currently expanded. Lazy: the batch
  // list only mounts (and only queries `job_items`) after the user opens a
  // card. See `JobItemsList` above.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpanded = (jobId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const fetchJobs = async () => {
    let query = supabase
      .from("jobs")
      .select(
        "id, type, status, progress, course_id, created_at, started_at, ended_at, error, locked_until, last_heartbeat",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (courseId) {
      query = query.eq("course_id", courseId);
    }
    const { data, error } = await query;
    if (error) {
      console.error("Failed to fetch jobs:", error);
      setLoading(false);
      return;
    }
    setJobs((data ?? []) as JobRow[]);
    setLoading(false);
  };

  // Resolve the admin/super-admin gate exactly once. The button is hidden
  // until this completes — students/instructors never see "Retry" even on a
  // stuck job they own.
  useEffect(() => {
    let cancelled = false;
    const checkRetryGate = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) {
        if (!cancelled) setCanRetry(false);
        return;
      }
      const [superRes, adminRes] = await Promise.all([
        supabase.rpc("is_super_admin", { _user_id: user.id }),
        supabase.rpc("is_admin", { _user_id: user.id }),
      ]);
      if (cancelled) return;
      const allowed = superRes.data === true || adminRes.data === true;
      setCanRetry(allowed);
    };
    checkRetryGate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    fetchJobs();

    // When scoped to a course, postgres_changes filters reduce traffic. In
    // global mode we subscribe to every jobs row and rely on RLS at the
    // realtime layer to hide rows the caller can't see anyway.
    const channelName = courseId ? `course-jobs-${courseId}` : `jobs-global`;
    const filter = courseId ? { filter: `course_id=eq.${courseId}` } : {};

    channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "jobs",
          ...filter,
        },
        (payload) => {
          if (!isMounted) return;
          const row = payload.new as JobRow;
          setJobs((prev) => {
            if (prev.some((j) => j.id === row.id)) return prev;
            return [row, ...prev].slice(0, limit);
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "jobs",
          ...filter,
        },
        (payload) => {
          if (!isMounted) return;
          const row = payload.new as JobRow;
          setJobs((prev) => prev.map((j) => (j.id === row.id ? { ...j, ...row } : j)));
        },
      )
      .subscribe((status) => {
        if (!isMounted) return;
        if (status === "SUBSCRIBED") {
          setRealtimeOk(true);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setRealtimeOk(false);
        }
      });

    return () => {
      isMounted = false;
      if (channel) supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resubscribe on courseId/limit change
  }, [courseId, limit]);

  // Re-evaluate stall state every 30s. Cheap: a single state bump that only
  // re-renders cards already on screen. Skipped when nothing is in flight.
  useEffect(() => {
    const hasRunning = jobs.some((j) => j.status === "processing");
    if (!hasRunning) return;
    const id = window.setInterval(() => setNowTick(Date.now()), STALL_TICK_MS);
    return () => window.clearInterval(id);
  }, [jobs]);

  const handleResume = async (jobId: string) => {
    setResuming((prev) => ({ ...prev, [jobId]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("resume-job", {
        body: { jobId },
      });
      if (error) {
        let description = error.message ?? String(error);
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (error as any).context;
          if (ctx instanceof Response) {
            const body = await ctx.clone().json();
            description = body.error ?? body.message ?? description;
          }
        } catch {
          // ignore parse failure — fall back to generic message
        }
        toast.error("Failed to resume job", { description });
        return;
      }
      if (data?.status === "noop") {
        toast("Job already finished", {
          description: "Nothing to resume.",
        });
      } else {
        toast.success("Resuming job");
      }
    } catch (err) {
      toast.error("Failed to resume job", {
        description: (err as Error).message ?? String(err),
      });
    } finally {
      // Keep the spinner up until the next heartbeat clears `isStalled` so
      // the button isn't smashable; a realtime UPDATE will replace the row
      // and recompute. Drop after a short delay so we don't pin forever in
      // the rare case no UPDATE arrives.
      window.setTimeout(() => {
        setResuming((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }, 4_000);
    }
  };

  const handleRetry = async (jobId: string) => {
    setRetrying((prev) => ({ ...prev, [jobId]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("retry-job", {
        body: { jobId },
      });
      if (error) {
        let description = error.message ?? String(error);
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (error as any).context;
          if (ctx instanceof Response) {
            const body = await ctx.clone().json();
            description = body.error ?? body.message ?? description;
          }
        } catch {
          // ignore parse failure — fall back to generic message
        }
        toast.error("Failed to retry job", { description });
        return;
      }
      if (data?.status === "noop") {
        toast("Nothing to retry", {
          description: data?.jobStatus === "completed"
            ? "Job already completed."
            : "Job is already queued.",
        });
      } else {
        toast.success("Job requeued");
      }
    } catch (err) {
      toast.error("Failed to retry job", {
        description: (err as Error).message ?? String(err),
      });
    } finally {
      // A realtime UPDATE flipping the row back to `pending` will land
      // shortly; until then keep the spinner up so the button isn't
      // smashable, but drop it after a short delay as a safety net.
      window.setTimeout(() => {
        setRetrying((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }, 4_000);
    }
  };

  const handleCancel = async (jobId: string) => {
    setCancelling((prev) => ({ ...prev, [jobId]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("cancel-job", {
        body: { jobId },
      });
      if (error) {
        // FunctionsHttpError.message is always the generic supabase-js string.
        // The human-readable reason lives in the JSON response body.
        let description = error.message ?? String(error);
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (error as any).context;
          if (ctx instanceof Response) {
            const body = await ctx.clone().json();
            description = body.error ?? body.message ?? description;
          }
        } catch {
          // ignore parse failure — fall back to generic message
        }
        toast.error("Failed to cancel job", { description });
        return;
      }
      if (data?.status === "noop") {
        toast("Job already finished", {
          description: "Nothing to cancel.",
        });
      } else {
        toast.success("Job cancelled");
      }
    } catch (err) {
      toast.error("Failed to cancel job", {
        description: (err as Error).message ?? String(err),
      });
    } finally {
      setCancelling((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    }
  };

  // Empty / loading: keep the card off the page so callers with no async work
  // don't grow extra chrome. The Refresh button still surfaces when realtime
  // is unavailable.
  if (loading) return null;
  if (jobs.length === 0 && realtimeOk) return null;

  return (
    <Card data-testid="job-progress-list">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base font-semibold">{heading}</CardTitle>
        {!realtimeOk && (
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchJobs}
            data-testid="job-progress-refresh"
            title="Realtime is unavailable — refresh manually"
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Refresh
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jobs yet.</p>
        ) : (
          jobs.map((job) => {
            const pct = progressPct(job.progress);
            const label = progressLabel(job.progress);
            const extras = extrasLabel(job.progress);
            const terminal = TERMINAL_STATUSES.has(job.status);
            const isCancelling = !!cancelling[job.id];
            const isResuming = !!resuming[job.id];
            const isRetrying = !!retrying[job.id];
            const stalled = isJobStalled(job, nowTick);
            const retryable = canRetry === true && isJobRetryable(job, nowTick);
            const isExpanded = expanded.has(job.id);
            // `data-job-id` / `data-status` give the card an identity and a
            // machine-readable state, so a test can assert about ONE job rather
            // than about whatever the list happens to be showing. Without them
            // the only handles were the card's position and its badge text, and
            // a page-wide `job-item-row[data-status="failed"]` assertion failed
            // a retry on a stale neighbour's failed batch (#1067).
            return (
              <div
                key={job.id}
                className="border rounded-md p-3 space-y-2"
                data-testid="job-progress-item"
                data-job-id={job.id}
                data-status={job.status}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-start gap-1 min-w-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 shrink-0 -ml-1 mt-0.5"
                      onClick={() => toggleExpanded(job.id)}
                      aria-label={isExpanded ? "Hide batch details" : "Show batch details"}
                      aria-expanded={isExpanded}
                      data-testid="job-details-toggle"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </Button>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{humanizeType(job.type)}</div>
                      {label && (
                        <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(job.status, stalled)}
                    {stalled && !terminal && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={isResuming}
                        onClick={() => handleResume(job.id)}
                        data-testid="job-resume-button"
                        aria-label="Resume job"
                      >
                        {isResuming ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <PlayCircle className="w-3 h-3" />
                        )}
                        <span className="ml-1">Resume</span>
                      </Button>
                    )}
                    {!terminal && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={isCancelling}
                            data-testid="job-cancel-button"
                            aria-label="Cancel job"
                          >
                            {isCancelling ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Ban className="w-3 h-3" />
                            )}
                            <span className="ml-1">Cancel</span>
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Cancel this job?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Any items that haven&apos;t started yet will be skipped.
                              Items already in progress will finish — their results are kept.
                              This can&apos;t be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Keep running</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleCancel(job.id)}
                              data-testid="job-cancel-confirm"
                            >
                              Cancel job
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    {retryable && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={isRetrying}
                            data-testid="job-retry-button"
                            aria-label="Retry job"
                          >
                            {isRetrying ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RotateCw className="w-3 h-3" />
                            )}
                            <span className="ml-1">Retry</span>
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Retry this job?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Failed and cancelled items will be requeued from
                              scratch. Items that already completed are kept.
                              The job will be picked up on the next runner tick.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Leave alone</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRetry(job.id)}
                              data-testid="job-retry-confirm"
                            >
                              Retry job
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </div>
                {pct !== null && !terminal && (
                  <Progress value={pct} className="h-2" data-testid="job-progress-bar" />
                )}
                {extras && (
                  <div className="text-xs text-muted-foreground">{extras}</div>
                )}
                {terminal && job.error && (
                  <div className="text-xs text-destructive line-clamp-2">{job.error}</div>
                )}
                {isExpanded && (
                  <JobItemsList jobId={job.id} isTerminal={terminal} />
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
