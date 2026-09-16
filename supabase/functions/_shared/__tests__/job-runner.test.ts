/**
 * Tests for the generic background-job runner (#695).
 *
 * Uses a hand-rolled in-memory fake of the Supabase client that mirrors the
 * narrow query surface the runner actually uses. This is preferable to the
 * URL-routing harness because the runner performs many sequenced reads /
 * conditional updates and stateful matching is much clearer than ordered
 * fake routes.
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  _clearJobHandlerRegistry,
  registerJobHandler,
  type JobItemRow,
  type JobRow,
} from "../job-handlers.ts";
import {
  claimNextItem,
  claimNextJob,
  finalizeJob,
  runJobSlice,
} from "../job-runner.ts";

// ── Fake Supabase client ───────────────────────────────────────────────

type Row = Record<string, unknown>;

interface FakeTables {
  jobs: Row[];
  job_items: Row[];
  notifications: Row[];
}

function makeFakeSupabase(initial: Partial<FakeTables> = {}) {
  const tables: FakeTables = {
    jobs: initial.jobs ?? [],
    job_items: initial.job_items ?? [],
    notifications: initial.notifications ?? [],
  };

  function matchFilters(row: Row, filters: Filter[]): boolean {
    for (const f of filters) {
      if (f.op === "eq" && row[f.col] !== f.val) return false;
      if (f.op === "neq" && row[f.col] === f.val) return false;
      if (f.op === "in" && !(f.val as unknown[]).includes(row[f.col])) return false;
      if (f.op === "lte") {
        const v = row[f.col];
        // Mirrors Postgres: NULL fails any inequality comparison.
        if (v === null || v === undefined) return false;
        if (!((v as number | string) <= (f.val as number | string))) return false;
      }
      if (f.op === "gte") {
        const v = row[f.col];
        if (v === null || v === undefined) return false;
        if (!((v as number | string) >= (f.val as number | string))) return false;
      }
    }
    return true;
  }

  function applyOrder<T extends Row>(rows: T[], orders: OrderSpec[]): T[] {
    if (orders.length === 0) return rows.slice();
    const sorted = rows.slice().sort((a, b) => {
      for (const o of orders) {
        const av = a[o.col];
        const bv = b[o.col];
        const aIsNull = av === null || av === undefined;
        const bIsNull = bv === null || bv === undefined;
        if (aIsNull && bIsNull) continue;
        if (aIsNull) return o.nullsFirst ? -1 : 1;
        if (bIsNull) return o.nullsFirst ? 1 : -1;
        if (av === bv) continue;
        const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
        return o.ascending ? cmp : -cmp;
      }
      return 0;
    });
    return sorted;
  }

  type Filter = { op: "eq" | "neq" | "in" | "lte" | "gte"; col: string; val: unknown };
  type OrderSpec = { col: string; ascending: boolean; nullsFirst: boolean };

  function buildSelectChain(tableName: keyof FakeTables) {
    const filters: Filter[] = [];
    const orders: OrderSpec[] = [];
    let limitN: number | null = null;
    let returnArray = false;

    const finalize = async (): Promise<{ data: Row[]; error: null }> => {
      let result = tables[tableName].filter((r) => matchFilters(r, filters));
      result = applyOrder(result, orders);
      if (limitN !== null) result = result.slice(0, limitN);
      return { data: result, error: null };
    };

    const api: any = {
      eq(col: string, val: unknown) {
        filters.push({ op: "eq", col, val });
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push({ op: "neq", col, val });
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ op: "in", col, val: vals });
        return api;
      },
      lte(col: string, val: unknown) {
        filters.push({ op: "lte", col, val });
        return api;
      },
      gte(col: string, val: unknown) {
        filters.push({ op: "gte", col, val });
        return api;
      },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
        orders.push({
          col,
          ascending: opts?.ascending ?? true,
          nullsFirst: opts?.nullsFirst ?? false,
        });
        return api;
      },
      limit(n: number) {
        limitN = n;
        returnArray = true;
        return api;
      },
      async maybeSingle() {
        const { data } = await finalize();
        return { data: data[0] ?? null, error: null };
      },
      async single() {
        const { data } = await finalize();
        return { data: data[0] ?? null, error: data[0] ? null : { code: "PGRST116" } };
      },
      then(resolve: (v: unknown) => void) {
        finalize().then((r) => {
          if (returnArray) resolve(r);
          else resolve(r);
        });
      },
    };
    return api;
  }

  function buildUpdateChain(tableName: keyof FakeTables, values: Row) {
    const filters: Filter[] = [];
    let withSelect = false;
    let withMaybeSingle = false;

    const finalize = async () => {
      const matched = tables[tableName].filter((r) => matchFilters(r, filters));
      for (const row of matched) {
        for (const [k, v] of Object.entries(values)) {
          row[k] = v;
        }
      }
      if (withSelect) {
        if (withMaybeSingle) return { data: matched[0] ?? null, error: null };
        return { data: matched, error: null };
      }
      return { data: null, error: null };
    };

    const api: any = {
      eq(col: string, val: unknown) {
        filters.push({ op: "eq", col, val });
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push({ op: "in", col, val: vals });
        return api;
      },
      lte(col: string, val: unknown) {
        filters.push({ op: "lte", col, val });
        return api;
      },
      gte(col: string, val: unknown) {
        filters.push({ op: "gte", col, val });
        return api;
      },
      select(_cols?: string) {
        withSelect = true;
        return api;
      },
      async maybeSingle() {
        withMaybeSingle = true;
        return finalize();
      },
      then(resolve: (v: unknown) => void) {
        finalize().then(resolve);
      },
    };
    return api;
  }

  function buildInsertChain(tableName: keyof FakeTables, values: Row | Row[]) {
    const rowsToInsert = Array.isArray(values) ? values : [values];
    let withSelect = false;
    let withMaybeSingle = false;

    const finalize = async () => {
      const inserted: Row[] = [];
      for (const v of rowsToInsert) {
        const row: Row = { ...v };
        if (row.id === undefined) row.id = `${tableName}-${tables[tableName].length + 1}`;
        if (row.created_at === undefined) row.created_at = new Date().toISOString();
        // Mirror the migration's column defaults so handlers that insert
        // rows without specifying lease/attempts columns still match the
        // runner's `.lte("locked_until", now)` reclaim filter.
        if (tableName === "jobs") {
          if (row.locked_until === undefined) row.locked_until = "1970-01-01T00:00:00.000Z";
          if (row.last_heartbeat === undefined) row.last_heartbeat = null;
        }
        if (tableName === "job_items") {
          if (row.locked_until === undefined) row.locked_until = "1970-01-01T00:00:00.000Z";
          if (row.last_heartbeat === undefined) row.last_heartbeat = null;
          if (row.max_attempts === undefined) row.max_attempts = 3;
          if (row.attempts === undefined) row.attempts = 0;
          if (row.updated_at === undefined) row.updated_at = row.created_at;
        }
        tables[tableName].push(row);
        inserted.push(row);
      }
      if (withSelect) {
        if (withMaybeSingle) return { data: inserted[0] ?? null, error: null };
        return { data: inserted, error: null };
      }
      return { data: null, error: null };
    };

    const api: any = {
      select(_cols?: string) {
        withSelect = true;
        return api;
      },
      async maybeSingle() {
        withMaybeSingle = true;
        return finalize();
      },
      then(resolve: (v: unknown) => void) {
        finalize().then(resolve);
      },
    };
    return api;
  }

  return {
    tables,
    from(table: string) {
      if (!(table in tables)) {
        throw new Error(`Fake supabase: unknown table ${table}`);
      }
      const tableName = table as keyof FakeTables;
      return {
        select: (_cols?: string) => buildSelectChain(tableName),
        update: (values: Row) => buildUpdateChain(tableName, values),
        insert: (values: Row | Row[]) => buildInsertChain(tableName, values),
      };
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────

// Matches the migration's epoch default for locked_until — pre-existing rows
// (and freshly inserted pending rows) are "lease expired" from the runner's
// point of view.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

function buildJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    type: "test_type",
    status: "pending",
    params: {},
    progress: {},
    result: {},
    created_by: "user-1",
    institution_id: "inst-1",
    course_id: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    started_at: null,
    ended_at: null,
    locked_until: EPOCH_ISO,
    last_heartbeat: null,
    ...overrides,
  };
}

function buildItem(overrides: Partial<JobItemRow> = {}): JobItemRow {
  return {
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    job_id: "job-1",
    item_key: "key",
    item_type: null,
    status: "pending",
    payload: {},
    result: {},
    error: null,
    attempts: 0,
    max_attempts: 3,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    locked_until: EPOCH_ISO,
    last_heartbeat: null,
    ...overrides,
  };
}

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// ── Tests ───────────────────────────────────────────────────────────────

Deno.test({
  name: "claimNextJob: transitions a pending job to processing and sets started_at",
  ...OPTS,
  async fn() {
    const fake = makeFakeSupabase({ jobs: [buildJob() as unknown as Row] });
    const claimed = await claimNextJob(fake as any);
    assertExists(claimed);
    assertEquals(claimed!.status, "processing");
    assertExists(claimed!.started_at);
    assertEquals((fake.tables.jobs[0] as unknown as JobRow).status, "processing");
  },
});

Deno.test({
  name: "claimNextJob: resumes an already-processing job without re-claiming",
  ...OPTS,
  async fn() {
    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
        }) as unknown as Row,
      ],
    });
    const claimed = await claimNextJob(fake as any);
    assertExists(claimed);
    assertEquals(claimed!.status, "processing");
    assertEquals(claimed!.started_at, "2026-01-01T00:00:00Z");
  },
});

Deno.test({
  name: "claimNextJob: returns null when no runnable job exists",
  ...OPTS,
  async fn() {
    const fake = makeFakeSupabase({
      jobs: [buildJob({ status: "completed" }) as unknown as Row],
    });
    const claimed = await claimNextJob(fake as any);
    assertEquals(claimed, null);
  },
});

Deno.test({
  name: "claimNextItem: atomically marks the oldest pending item processing and bumps attempts",
  ...OPTS,
  async fn() {
    const fake = makeFakeSupabase({
      job_items: [
        buildItem({ id: "i-1", created_at: "2026-01-01T00:00:00Z" }) as unknown as Row,
        buildItem({ id: "i-2", created_at: "2026-01-01T00:00:01Z" }) as unknown as Row,
      ],
    });
    const claimed = await claimNextItem(fake as any, "job-1");
    assertExists(claimed);
    assertEquals(claimed!.id, "i-1");
    assertEquals(claimed!.status, "processing");
    assertEquals(claimed!.attempts, 1);
    // The other one is untouched.
    const other = fake.tables.job_items.find((r) => r.id === "i-2") as unknown as JobItemRow;
    assertEquals(other.status, "pending");
    assertEquals(other.attempts, 0);
  },
});

Deno.test({
  name: "claimNextItem: returns null when no pending items remain",
  ...OPTS,
  async fn() {
    const fake = makeFakeSupabase({
      job_items: [buildItem({ status: "completed" }) as unknown as Row],
    });
    const claimed = await claimNextItem(fake as any, "job-1");
    assertEquals(claimed, null);
  },
});

Deno.test({
  name: "runJobSlice: dispatches to the registered handler and completes the job",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    const seen: string[] = [];
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem({ item }) {
        seen.push(item.id);
        return { result: { ok: true, item_id: item.id } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [
        buildItem({ id: "i-1" }) as unknown as Row,
        buildItem({ id: "i-2" }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });

    assertEquals(result.processed, 2);
    assertEquals(result.completed, 2);
    assertEquals(result.failed, 0);
    assertEquals(result.moreWork, false);
    assertEquals(result.terminal, true);
    assertEquals(seen.sort(), ["i-1", "i-2"]);

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "completed");
    assertExists(job.ended_at);

    // One notification per terminal job, owned by created_by.
    assertEquals(fake.tables.notifications.length, 1);
    const notif = fake.tables.notifications[0] as Record<string, unknown>;
    assertEquals(notif.user_id, "user-1");
    assertEquals(notif.job_id, "job-1");
    assertEquals(notif.type, "job.completed");
  },
});

Deno.test({
  name: "runJobSlice: time budget stops processing mid-batch and reports moreWork=true",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    let calls = 0;
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        calls++;
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [
        buildItem({ id: "i-1" }) as unknown as Row,
        buildItem({ id: "i-2" }) as unknown as Row,
        buildItem({ id: "i-3" }) as unknown as Row,
      ],
    });

    // Clock: tick 100s per call. Deadline 150s → only one item gets in.
    let clock = 0;
    const result = await runJobSlice(fake as any, {
      deadlineMs: 150_000,
      now: () => {
        const v = clock;
        clock += 100_000;
        return v;
      },
    });

    assertEquals(calls, 1);
    assertEquals(result.processed, 1);
    assertEquals(result.moreWork, true);
    assertEquals(result.terminal, false);

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "processing");
    assertEquals(job.ended_at, null);
    // No notification yet because the job isn't terminal.
    assertEquals(fake.tables.notifications.length, 0);
  },
});

Deno.test({
  name: "runJobSlice: partial failure — failed items don't abort siblings, job ends partially_completed",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem({ item }) {
        if (item.id === "i-bad") throw new Error("boom: bad input");
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [
        buildItem({ id: "i-ok-1" }) as unknown as Row,
        buildItem({
          id: "i-bad",
          created_at: "2026-01-01T00:00:01Z",
        }) as unknown as Row,
        buildItem({
          id: "i-ok-2",
          created_at: "2026-01-01T00:00:02Z",
        }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });

    assertEquals(result.completed, 2);
    assertEquals(result.failed, 1);
    assertEquals(result.terminal, true);

    const badItem = fake.tables.job_items.find((r) => r.id === "i-bad") as unknown as JobItemRow;
    assertEquals(badItem.status, "failed");
    assertEquals(badItem.error, "boom: bad input");
    assertEquals(badItem.attempts, 1);

    const okItem = fake.tables.job_items.find((r) => r.id === "i-ok-2") as unknown as JobItemRow;
    assertEquals(okItem.status, "completed");

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "partially_completed");
    assertExists(job.ended_at);

    assertEquals(fake.tables.notifications.length, 1);
    const notif = fake.tables.notifications[0] as Record<string, unknown>;
    assertEquals(notif.type, "job.partially_completed");
    assertEquals((notif.body as string).includes("2/3"), true);
    assertEquals((notif.body as string).includes("1 failed"), true);
  },
});

Deno.test({
  name: "runJobSlice: unknown job type fails the job cleanly and notifies",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();

    const fake = makeFakeSupabase({
      jobs: [buildJob({ type: "no_such_type" }) as unknown as Row],
      job_items: [buildItem() as unknown as Row],
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });

    assertEquals(result.processed, 0);
    assertEquals(result.terminal, true);

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "failed");
    assertEquals(typeof job.error, "string");
    assertEquals((job.error as string).includes("no_such_type"), true);

    // Items remain untouched.
    const item = fake.tables.job_items[0] as unknown as JobItemRow;
    assertEquals(item.status, "pending");

    // Owner still gets one notification on the terminal flip.
    assertEquals(fake.tables.notifications.length, 1);
    const notif = fake.tables.notifications[0] as Record<string, unknown>;
    assertEquals(notif.type, "job.failed");
  },
});

Deno.test({
  name: "finalizeJob: idempotent — second call after termination is a no-op",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [buildItem({ id: "i-1" }) as unknown as Row],
    });

    // First slice — finalizes the job.
    await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(fake.tables.notifications.length, 1);
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "completed");

    // Calling finalizeJob again on the already-terminal job: must be a no-op.
    const again = await finalizeJob(fake as any, job);
    assertEquals(again.finalized, false);
    assertEquals(fake.tables.notifications.length, 1);
  },
});

Deno.test({
  name: "runJobSlice: jobs with no items finalize as completed (zero-item edge case)",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        return { result: {} };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      // No job_items.
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(result.processed, 0);
    assertEquals(result.terminal, true);
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "completed");
    assertEquals(fake.tables.notifications.length, 1);
  },
});

Deno.test({
  name: "runJobSlice: calls handler.expandJob once when no items exist, then processes the expanded items",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    let expansions = 0;
    registerJobHandler({
      type: "test_type",
      async expandJob({ supabase, job }) {
        expansions++;
        // deno-lint-ignore no-explicit-any
        const sb = supabase as any;
        // Status defaults to 'pending' in the real schema; the in-memory
        // fake has no defaults, so we set it explicitly here.
        const rows = [
          { job_id: job.id, item_key: "a", item_type: "x", status: "pending", attempts: 0 },
          { job_id: job.id, item_key: "b", item_type: "x", status: "pending", attempts: 0 },
        ];
        await sb.from("job_items").insert(rows);
        return { inserted: rows.length };
      },
      // deno-lint-ignore require-await
      async processItem({ item }) {
        return { result: { ok: true, key: item.item_key } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      // No items — handler.expandJob must materialize them.
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });

    assertEquals(expansions, 1);
    assertEquals(result.processed, 2);
    assertEquals(result.completed, 2);
    assertEquals(result.terminal, true);
    assertEquals((fake.tables.jobs[0] as unknown as JobRow).status, "completed");
    assertEquals(fake.tables.job_items.length, 2);
  },
});

Deno.test({
  name: "runJobSlice: skips expandJob when items already exist (resume after slice boundary)",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    let expansions = 0;
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async expandJob() {
        expansions++;
        return { inserted: 99 };
      },
      // deno-lint-ignore require-await
      async processItem() {
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob({ status: "processing", started_at: "2026-01-01T00:00:00Z" }) as unknown as Row],
      job_items: [
        buildItem({ id: "i-1" }) as unknown as Row,
      ],
    });

    await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(expansions, 0);
  },
});

Deno.test({
  name: "runJobSlice: expandJob throwing fails the job cleanly, no items processed",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async expandJob() {
        throw new Error("bad params");
      },
      // deno-lint-ignore require-await
      async processItem() {
        return { result: {} };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(result.terminal, true);
    assertEquals(result.processed, 0);
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "failed");
    assertEquals((job.error as string).includes("bad params"), true);
    assertEquals(fake.tables.notifications.length, 1);
    assertEquals(
      (fake.tables.notifications[0] as Record<string, unknown>).type,
      "job.failed",
    );
  },
});

Deno.test({
  name: "runJobSlice: persistJobProgress preserves handler-written progress fields (re-reads before merge)",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      async processItem({ supabase, job }) {
        // Handler writes its own cumulative field to jobs.progress between
        // claim time and the post-loop persistJobProgress call. The runner
        // must NOT erase it by spreading the stale `job.progress` snapshot.
        // deno-lint-ignore no-explicit-any
        const sb = supabase as any;
        const { data: row } = await sb
          .from("jobs")
          .select("progress")
          .eq("id", job.id)
          .maybeSingle();
        const prev = (row?.progress ?? {}) as Record<string, unknown>;
        const created = (typeof prev.created_total === "number" ? prev.created_total : 0) + 5;
        await sb
          .from("jobs")
          .update({ progress: { ...prev, created_total: created } })
          .eq("id", job.id);
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [
        buildItem({ id: "i-1" }) as unknown as Row,
        buildItem({ id: "i-2" }) as unknown as Row,
      ],
    });

    await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "completed");
    // Tally fields land alongside the handler's cumulative count, which
    // would have been erased if persistJobProgress had spread the stale
    // claim-time snapshot.
    const progress = job.progress as Record<string, unknown>;
    assertEquals(progress.created_total, 10);
    assertEquals(progress.total, 2);
    assertEquals(progress.completed, 2);
  },
});

Deno.test({
  name: "runJobSlice: detects mid-slice cancellation and stops without finalizing",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [
        buildItem({ id: "i-1" }) as unknown as Row,
        buildItem({ id: "i-2", created_at: "2026-01-01T00:00:01Z" }) as unknown as Row,
        buildItem({ id: "i-3", created_at: "2026-01-01T00:00:02Z" }) as unknown as Row,
      ],
    });

    let processed = 0;
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        processed++;
        if (processed === 1) {
          // Simulate the cancel-job edge function flipping the parent row
          // and sweeping remaining pending items to cancelled. The runner
          // re-reads jobs.status BEFORE its next claim, so this is exactly
          // the race the loop has to handle.
          (fake.tables.jobs[0] as Row).status = "cancelled";
          (fake.tables.jobs[0] as Row).ended_at = "2026-01-01T01:00:00Z";
          for (const item of fake.tables.job_items) {
            if (item.status === "pending") item.status = "cancelled";
          }
        }
        return { result: { ok: true } };
      },
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });

    // One item ran before the cancel was detected.
    assertEquals(processed, 1);
    assertEquals(result.processed, 1);
    assertEquals(result.terminal, true);
    assertEquals(result.moreWork, false);

    // The runner must NOT have rewritten the cancelled status to completed.
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "cancelled");
    // ended_at remains what the cancel handler set, not a freshly-stamped one.
    assertEquals(job.ended_at, "2026-01-01T01:00:00Z");

    // No new notification from the runner — the cancel handler is the one
    // that inserts the `job.cancelled` notification.
    assertEquals(fake.tables.notifications.length, 0);
  },
});

Deno.test({
  name: "runJobSlice: skips notification when created_by is null (owner removed)",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        return { result: {} };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob({ created_by: null }) as unknown as Row],
      job_items: [buildItem() as unknown as Row],
    });

    const result = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(result.terminal, true);
    // Job is still finalized…
    assertEquals((fake.tables.jobs[0] as unknown as JobRow).status, "completed");
    // …but no notification row is inserted (auth.users SET NULL allowed).
    assertEquals(fake.tables.notifications.length, 0);
  },
});

// ── Multi-tick drain (#762 — pg_cron-driven heartbeat) ────────────────

Deno.test({
  name: "runJobSlice: two consecutive ticks drain two sibling stalled jobs",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    const seen: string[] = [];
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem({ item }) {
        seen.push(item.id);
        return { result: { ok: true } };
      },
    });

    // Two `processing` jobs, both with started_at set: simulates the
    // post-deploy state where every running job was orphaned mid-slice.
    // Under the pg_cron-driven model, two cron ticks must drain both jobs
    // without any in-process self-reschedule.
    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          id: "job-A",
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
        }) as unknown as Row,
        buildJob({
          id: "job-B",
          status: "processing",
          started_at: "2026-01-01T00:00:01Z",
        }) as unknown as Row,
      ],
      job_items: [
        buildItem({ id: "a-1", job_id: "job-A" }) as unknown as Row,
        buildItem({ id: "b-1", job_id: "job-B" }) as unknown as Row,
      ],
    });

    // First tick: claims the older job (A) via the resume path and finalizes it.
    const r1 = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(r1.jobId, "job-A");
    assertEquals(r1.terminal, true);
    assertEquals((fake.tables.jobs[0] as unknown as JobRow).status, "completed");

    // Next pg_cron tick lands a second slice that picks up B via the same
    // resume path — claimNextJob's "status IN ('pending','processing')"
    // ordering is what makes cross-tick continuation work.
    const r2 = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(r2.jobId, "job-B");
    assertEquals(r2.terminal, true);
    assertEquals((fake.tables.jobs[1] as unknown as JobRow).status, "completed");

    // Both items ran, exactly once.
    assertEquals(seen.sort(), ["a-1", "b-1"]);

    // A third tick is a no-op: queue is fully terminal.
    const r3 = await runJobSlice(fake as any, { deadlineMs: 60_000, now: () => 0 });
    assertEquals(r3.jobId, null);
    assertEquals(r3.terminal, false);
  },
});

// ── Lease / heartbeat / max-attempts / orphan finalize (#763) ─────────

// Fixed wall-clock used by lease-aware tests so we can reason about
// past-vs-future timestamps deterministically.
const TEST_WALL_NOW_MS = Date.UTC(2026, 5, 28, 12, 0, 0);  // 2026-06-28T12:00:00Z
const PAST_LEASE_ISO = new Date(TEST_WALL_NOW_MS - 60_000).toISOString();
const FUTURE_LEASE_ISO = new Date(TEST_WALL_NOW_MS + 60_000).toISOString();

Deno.test({
  name:
    "runJobSlice: expired-lease reclaim — orphan processing job with expired lease is picked up and finalized",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    const seen: string[] = [];
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem({ item }) {
        seen.push(item.id);
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
      // The dead worker had claimed item i-1 (status='processing', expired
      // lease, attempts=1). It also has a sibling pending item i-2.
      job_items: [
        buildItem({
          id: "i-1",
          status: "processing",
          attempts: 1,
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
        buildItem({
          id: "i-2",
          status: "pending",
          created_at: "2026-01-01T00:00:01Z",
        }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, {
      deadlineMs: 60_000,
      now: () => 0,
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    assertEquals(result.terminal, true);
    // Both items ran exactly once (the orphan got retried; the new one got
    // claimed normally). Order isn't guaranteed by the fake's sort, so
    // compare sets.
    assertEquals(seen.sort(), ["i-1", "i-2"]);

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "completed");

    // Lease was refreshed during the slice — last_heartbeat is set.
    assertExists(job.last_heartbeat);

    // Attempts bumped on reclaim.
    const reclaimed = fake.tables.job_items.find((r) => r.id === "i-1") as unknown as JobItemRow;
    assertEquals(reclaimed.attempts, 2);
  },
});

Deno.test({
  name:
    "runJobSlice: live-lease skip — a processing job whose lease is in the future is NOT stolen",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        throw new Error("must not be called");
      },
    });

    // Single job, status=processing, lease in the future → another worker
    // is presumed alive. Runner must skip it and return null (no jobs).
    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
          locked_until: FUTURE_LEASE_ISO,
        }) as unknown as Row,
      ],
      job_items: [
        buildItem({ id: "i-1", status: "pending" }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, {
      deadlineMs: 60_000,
      now: () => 0,
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    assertEquals(result.jobId, null);
    assertEquals(result.processed, 0);

    // The live job was not touched.
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "processing");
    assertEquals(job.locked_until, FUTURE_LEASE_ISO);

    // No notification (we never finalized anything).
    assertEquals(fake.tables.notifications.length, 0);
  },
});

Deno.test({
  name:
    "runJobSlice: max-attempts cap — an item at the cap is marked failed instead of retried",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    let handlerCalls = 0;
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        handlerCalls++;
        return { result: { ok: true } };
      },
    });

    // A "poisoned" item: previous attempts already used up the cap. The
    // runner must NOT call the handler on it; it must transition the row
    // directly to failed.
    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
      job_items: [
        buildItem({
          id: "i-poison",
          status: "processing",
          attempts: 3,
          max_attempts: 3,
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, {
      deadlineMs: 60_000,
      now: () => 0,
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    assertEquals(handlerCalls, 0);
    assertEquals(result.terminal, true);

    const item = fake.tables.job_items[0] as unknown as JobItemRow;
    assertEquals(item.status, "failed");
    // No prior error was seeded — fallback message is the plain generic one.
    assertEquals(item.error, "Max attempts (3) reached");
    // Attempts is unchanged — we didn't claim, so no bump.
    assertEquals(item.attempts, 3);

    // Job finalizes failed (the only item is failed).
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "failed");

    assertEquals(fake.tables.notifications.length, 1);
    const notif = fake.tables.notifications[0] as Record<string, unknown>;
    assertEquals(notif.type, "job.failed");
  },
});

Deno.test({
  name:
    "runJobSlice: max-attempts cap preserves the prior error message (#809)",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        return { result: { ok: true } };
      },
    });

    // Item at the cap with a real prior failure from a previous slice. The
    // fidelity fix must preserve that message so the batch detail view can
    // explain *why* the batch is dead instead of the useless generic
    // "Max attempts reached".
    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
      job_items: [
        buildItem({
          id: "i-poison-with-cause",
          status: "processing",
          attempts: 3,
          max_attempts: 3,
          error: "OpenAI 500: upstream timeout",
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
    });

    await runJobSlice(fake as any, {
      deadlineMs: 60_000,
      now: () => 0,
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    const item = fake.tables.job_items[0] as unknown as JobItemRow;
    assertEquals(item.status, "failed");
    assertEquals(
      item.error,
      "Max attempts (3) reached — last error: OpenAI 500: upstream timeout",
    );
  },
});

Deno.test({
  name:
    "runJobSlice: orphan finalize — a stalled processing job with all-terminal items is finalized without running items",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    let handlerCalls = 0;
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        handlerCalls++;
        return { result: { ok: true } };
      },
    });

    // Worker died AFTER the last item completed but BEFORE finalize. All
    // items are terminal; the job is left in processing with an expired
    // lease. The next tick must finalize without touching items.
    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
      job_items: [
        buildItem({ id: "i-1", status: "completed", attempts: 1 }) as unknown as Row,
        buildItem({ id: "i-2", status: "completed", attempts: 1 }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, {
      deadlineMs: 60_000,
      now: () => 0,
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    assertEquals(handlerCalls, 0);
    assertEquals(result.terminal, true);
    assertEquals(result.processed, 0);

    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "completed");
    assertExists(job.ended_at);

    assertEquals(fake.tables.notifications.length, 1);
    const notif = fake.tables.notifications[0] as Record<string, unknown>;
    assertEquals(notif.type, "job.completed");
  },
});

Deno.test({
  name:
    "runJobSlice: mid-job exit releases the job lease so the next tick can pick up immediately",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem() {
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [buildJob() as unknown as Row],
      job_items: [
        buildItem({ id: "i-1" }) as unknown as Row,
        buildItem({ id: "i-2", created_at: "2026-01-01T00:00:01Z" }) as unknown as Row,
        buildItem({ id: "i-3", created_at: "2026-01-01T00:00:02Z" }) as unknown as Row,
      ],
    });

    // Clock advances 100s per call; deadline 150s → only one item fits.
    let clock = 0;
    const result = await runJobSlice(fake as any, {
      deadlineMs: 150_000,
      now: () => {
        const v = clock;
        clock += 100_000;
        return v;
      },
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    assertEquals(result.moreWork, true);
    assertEquals(result.terminal, false);

    // Lease was released back to a past value so the next pg_cron tick can
    // pick the row up without waiting for the natural expiry.
    const job = fake.tables.jobs[0] as unknown as JobRow;
    assertEquals(job.status, "processing");
    // locked_until must be <= now (released), not > now (still leased).
    const lockedUntilMs = Date.parse(job.locked_until);
    assertEquals(lockedUntilMs <= TEST_WALL_NOW_MS, true);
  },
});

Deno.test({
  name:
    "runJobSlice: live-lease item is skipped — claimNextItem ignores siblings claimed by another worker",
  ...OPTS,
  async fn() {
    _clearJobHandlerRegistry();
    const seen: string[] = [];
    registerJobHandler({
      type: "test_type",
      // deno-lint-ignore require-await
      async processItem({ item }) {
        seen.push(item.id);
        return { result: { ok: true } };
      },
    });

    const fake = makeFakeSupabase({
      jobs: [
        buildJob({
          status: "processing",
          started_at: "2026-01-01T00:00:00Z",
          locked_until: PAST_LEASE_ISO,
        }) as unknown as Row,
      ],
      job_items: [
        // Item i-1 is being actively worked by another worker (live lease).
        // The runner must NOT claim it — even though status='processing',
        // its lease is in the future.
        buildItem({
          id: "i-1",
          status: "processing",
          attempts: 1,
          locked_until: FUTURE_LEASE_ISO,
        }) as unknown as Row,
        // Item i-2 is plain pending and should be the only one picked up.
        buildItem({
          id: "i-2",
          status: "pending",
          created_at: "2026-01-01T00:00:01Z",
        }) as unknown as Row,
      ],
    });

    const result = await runJobSlice(fake as any, {
      deadlineMs: 60_000,
      now: () => 0,
      wallClockNow: () => TEST_WALL_NOW_MS,
    });

    assertEquals(seen, ["i-2"]);
    // The live-leased item was not touched (still processing, lease intact).
    const live = fake.tables.job_items.find((r) => r.id === "i-1") as unknown as JobItemRow;
    assertEquals(live.status, "processing");
    assertEquals(live.locked_until, FUTURE_LEASE_ISO);
    assertEquals(live.attempts, 1);

    // Job stays in processing because the live-leased item is still in
    // flight (counts as `processing` in the tally) — finalize doesn't fire.
    assertEquals(result.terminal, false);
    assertEquals(result.moreWork, true);
  },
});
