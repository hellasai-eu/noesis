/**
 * Tests for the bulk question-generation job handler (#697).
 *
 * Two surfaces are exercised:
 *
 *   1. `expandJob` — pure param validation + item fan-out. Tests use a
 *      minimal in-memory fake supabase client because the handler only
 *      touches `job_items.insert(...)` here.
 *
 *   2. `processItem` — calls the per-type generator over HTTP, then writes
 *      via the shared insert helper (#696). Tests use `createTestHarness`
 *      so a real `@supabase/supabase-js` client and the helper run against
 *      mocked REST routes; the same harness intercepts the
 *      `/functions/v1/generate-*` call so we can assert the generator
 *      contract end-to-end without spinning up a second function.
 */
import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildJobItemRows,
  parseBulkParams,
  __bulkQuestionGenerationInternals,
} from "../job-handlers/bulk-question-generation.ts";
import {
  createTestHarness,
  type FetchLogEntry,
  type MockRoute,
} from "./handler-harness.ts";
import type { JobRow } from "../job-handlers.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const SUPABASE_URL = "http://localhost:54321";
const SERVICE_KEY = "test-service-role-key";

// ── Fixture builders ────────────────────────────────────────────────────

function buildJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    type: "bulk_question_generation",
    status: "processing",
    params: {},
    progress: {},
    result: {},
    created_by: "user-1",
    institution_id: "inst-1",
    course_id: "course-1",
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:00:00Z",
    ended_at: null,
    locked_until: "1970-01-01T00:00:00.000Z",
    last_heartbeat: null,
    ...overrides,
  };
}

// Minimal supabase fake — only the methods expandJob actually invokes
// (`from('job_items').insert(rows)`). Anything else surfaces as an error so
// silent additions are noticed.
function makeJobItemsFake() {
  const inserted: Array<Record<string, unknown>> = [];
  let lastError: { message: string } | null = null;
  return {
    inserted,
    setNextInsertError(message: string) {
      lastError = { message };
    },
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table !== "job_items") {
        throw new Error(`makeJobItemsFake: unexpected table ${table}`);
      }
      return {
        insert(rows: Array<Record<string, unknown>> | Record<string, unknown>) {
          const toInsert = Array.isArray(rows) ? rows : [rows];
          if (lastError) {
            const err = lastError;
            lastError = null;
            return Promise.resolve({ data: null, error: err });
          }
          inserted.push(...toInsert);
          return Promise.resolve({ data: toInsert, error: null });
        },
      };
    },
  };
}

// Mock the `questions` POST that `insertGeneratedQuestions` issues per row.
function questionsInsertRoute(): MockRoute {
  let calls = 0;
  return {
    match: (url, init) => {
      const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
      return isPost && url.includes("/rest/v1/questions") &&
        !url.includes("question_chapters") &&
        !url.includes("question_competencies");
    },
    respond: () => {
      const idx = calls++;
      return new Response(
        JSON.stringify({ id: `q-inserted-${idx}` }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}

function junctionRoute(path: string): MockRoute {
  return {
    match: (url, init) => {
      const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
      return isPost && url.includes(path);
    },
    respond: () =>
      new Response("[]", {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

interface JobsProgressState {
  jobsById: Record<string, { progress: Record<string, unknown> }>;
}

// Mock GET /rest/v1/jobs?select=progress&id=eq.<id> + PATCH /rest/v1/jobs?id=eq.<id>
function jobsProgressRoute(state: JobsProgressState): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/jobs"),
    respond: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const idMatch = url.match(/id=eq\.([^&]+)/);
      const jobId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      if (!jobId || !state.jobsById[jobId]) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "GET") {
        const row = state.jobsById[jobId];
        return new Response(JSON.stringify([{ progress: row.progress }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "PATCH") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (body.progress) {
          state.jobsById[jobId].progress = body.progress;
        }
        // supabase-js (no .select() chained) expects an empty 2xx; 204 with
        // no body is the natural PostgREST shape for "update succeeded".
        return new Response(null, { status: 204 });
      }
      return new Response("[]", { status: 200 });
    },
  };
}

function generatorRoute(
  fnName: string,
  payload: unknown,
  opts?: { status?: number },
): MockRoute {
  return {
    match: (url, init) => {
      const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
      return isPost && url.includes(`/functions/v1/${fnName}`);
    },
    respond: () =>
      new Response(JSON.stringify(payload), {
        status: opts?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function postsTo(log: FetchLogEntry[], pathFragment: string): FetchLogEntry[] {
  return log.filter((e) =>
    e.method.toUpperCase() === "POST" && e.url.includes(pathFragment)
  );
}

function postsToQuestions(log: FetchLogEntry[]): FetchLogEntry[] {
  return log.filter((e) =>
    e.method.toUpperCase() === "POST" &&
    e.url.includes("/rest/v1/questions") &&
    !e.url.includes("question_chapters") &&
    !e.url.includes("question_competencies")
  );
}

function makeServiceClient() {
  return createClient(SUPABASE_URL, SERVICE_KEY);
}

// ── parseBulkParams ─────────────────────────────────────────────────────

Deno.test({
  name: "parseBulkParams: accepts the full happy-path shape",
  ...OPTS,
  fn() {
    const params = parseBulkParams({
      courseId: "course-1",
      types: ["mcq", "open", "fill_gaps"],
      chapterIds: ["ch-1", "ch-2"],
      countPerType: 3,
      difficulty: "hard",
      competencyIds: ["c-1"],
      startHidden: true,
      diagramMode: "auto",
      specialInstructions: "focus on the basics",
    });
    assertEquals(params.courseId, "course-1");
    assertEquals(params.types, ["mcq", "open", "fill_gaps"]);
    assertEquals(params.chapterIds, ["ch-1", "ch-2"]);
    assertEquals(params.countPerType, 3);
    assertEquals(params.difficulty, "hard");
    assertEquals(params.competencyIds, ["c-1"]);
    assertEquals(params.startHidden, true);
    assertEquals(params.diagramMode, "auto");
    assertEquals(params.specialInstructions, "focus on the basics");
  },
});

Deno.test({
  name: "parseBulkParams: deduplicates repeated types and clamps countPerType to MAX_QUESTIONS",
  ...OPTS,
  fn() {
    const params = parseBulkParams({
      courseId: "course-1",
      // duplicate `mcq` should appear once; countPerType:99 is clamped to 5.
      types: ["mcq", "open", "mcq"],
      chapterIds: ["ch-1"],
      countPerType: 99,
    });
    assertEquals(params.types, ["mcq", "open"]);
    assertEquals(params.countPerType, 5);
  },
});

Deno.test({
  name: "parseBulkParams: rejects an unsupported type",
  ...OPTS,
  fn() {
    assertThrows(
      () =>
        parseBulkParams({
          courseId: "course-1",
          types: ["mcq", "no_such_type"],
          chapterIds: ["ch-1"],
        }),
      Error,
      "unsupported type",
    );
  },
});

Deno.test({
  name: "parseBulkParams: rejects empty types array",
  ...OPTS,
  fn() {
    assertThrows(
      () =>
        parseBulkParams({
          courseId: "course-1",
          types: [],
          chapterIds: ["ch-1"],
        }),
      Error,
      "non-empty subset",
    );
  },
});

Deno.test({
  name: "parseBulkParams: rejects empty chapterIds array",
  ...OPTS,
  fn() {
    assertThrows(
      () =>
        parseBulkParams({
          courseId: "course-1",
          types: ["mcq"],
          chapterIds: [],
        }),
      Error,
      "chapterIds must be a non-empty array",
    );
  },
});

Deno.test({
  name: "parseBulkParams: rejects missing courseId",
  ...OPTS,
  fn() {
    assertThrows(
      () => parseBulkParams({ types: ["mcq"], chapterIds: ["ch-1"] }),
      Error,
      "courseId is required",
    );
  },
});

// ── buildJobItemRows ────────────────────────────────────────────────────

Deno.test({
  name: "buildJobItemRows: 2 chapters × 3 types → 6 items with stable keys and payload",
  ...OPTS,
  fn() {
    const rows = buildJobItemRows("job-XYZ", {
      courseId: "course-1",
      types: ["mcq", "open", "ordering"],
      chapterIds: ["ch-A", "ch-B"],
      countPerType: 4,
      difficulty: "easy",
      startHidden: true,
      diagramMode: "off",
      competencyIds: ["c-1"],
      specialInstructions: "be concise",
    });

    assertEquals(rows.length, 6);
    const keys = rows.map((r) => r.item_key).sort();
    assertEquals(keys, [
      "ch-A:mcq",
      "ch-A:open",
      "ch-A:ordering",
      "ch-B:mcq",
      "ch-B:open",
      "ch-B:ordering",
    ]);

    for (const row of rows) {
      assertEquals(row.job_id, "job-XYZ");
      assertEquals(row.payload.courseId, "course-1");
      assertEquals(row.payload.numQuestions, 4);
      assertEquals(row.payload.difficulty, "easy");
      assertEquals(row.payload.startHidden, true);
      assertEquals(row.payload.diagramMode, "off");
      assertEquals(row.payload.competencyIds, ["c-1"]);
      assertEquals(row.payload.specialInstructions, "be concise");
      assertEquals(row.payload.type, row.item_type);
    }
  },
});

// ── expandJob (via internals) ───────────────────────────────────────────

Deno.test({
  name: "expandJob: inserts rows into job_items via supabase",
  ...OPTS,
  async fn() {
    const fake = makeJobItemsFake();
    const job = buildJob({
      params: {
        courseId: "course-1",
        types: ["mcq", "open"],
        chapterIds: ["ch-1", "ch-2"],
        countPerType: 2,
      },
    });

    const result = await __bulkQuestionGenerationInternals.expandJob({
      // deno-lint-ignore no-explicit-any
      supabase: fake as any,
      job,
    });

    assertEquals(result.inserted, 4);
    assertEquals(fake.inserted.length, 4);
    const keys = fake.inserted.map((r) => r.item_key as string).sort();
    assertEquals(keys, ["ch-1:mcq", "ch-1:open", "ch-2:mcq", "ch-2:open"]);
    // Spot-check one row's payload shape.
    const sample = fake.inserted[0];
    assertEquals((sample.payload as Record<string, unknown>).courseId, "course-1");
    assertEquals(sample.item_type, sample.payload && (sample.payload as Record<string, unknown>).type);
  },
});

Deno.test({
  name: "expandJob: surfaces supabase insert errors so the runner can fail the job",
  ...OPTS,
  async fn() {
    const fake = makeJobItemsFake();
    fake.setNextInsertError("constraint violation");
    const job = buildJob({
      params: {
        courseId: "course-1",
        types: ["mcq"],
        chapterIds: ["ch-1"],
      },
    });

    await assertRejects(
      () =>
        __bulkQuestionGenerationInternals.expandJob({
          // deno-lint-ignore no-explicit-any
          supabase: fake as any,
          job,
        }),
      Error,
      "job_items insert failed",
    );
  },
});

Deno.test({
  name: "expandJob: invalid params (e.g. empty chapterIds) throws before any insert",
  ...OPTS,
  async fn() {
    const fake = makeJobItemsFake();
    const job = buildJob({
      params: {
        courseId: "course-1",
        types: ["mcq"],
        chapterIds: [],
      },
    });

    await assertRejects(
      () =>
        __bulkQuestionGenerationInternals.expandJob({
          // deno-lint-ignore no-explicit-any
          supabase: fake as any,
          job,
        }),
      Error,
      "chapterIds must be a non-empty array",
    );
    assertEquals(fake.inserted.length, 0);
  },
});

// ── processItem ─────────────────────────────────────────────────────────

Deno.test({
  name: "processItem: mcq item calls generate-questions and writes via the insert helper",
  ...OPTS,
  async fn() {
    const jobsState: JobsProgressState = {
      jobsById: { "job-1": { progress: {} } },
    };
    const h = createTestHarness({
      routes: [
        generatorRoute("generate-questions", {
          questions: [
            {
              question: "What is 2+2?",
              type: "mcq",
              payload: { options: ["3", "4"] },
              answer_key: { correct_indices: [1] },
              explanation: "Addition.",
              difficulty: "easy",
              hidden: false,
              chapter_ids: ["ch-1"],
              competency_ids: ["comp-1"],
            },
            {
              question: "What is 3+3?",
              type: "mcq",
              payload: { options: ["5", "6"] },
              answer_key: { correct_indices: [1] },
              explanation: "Addition.",
              difficulty: "easy",
              hidden: false,
              chapter_ids: ["ch-1"],
              competency_ids: [],
            },
          ],
        }),
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
        jobsProgressRoute(jobsState),
      ],
    });
    try {
      const supabase = makeServiceClient();
      const res = await __bulkQuestionGenerationInternals.processItem({
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        job: buildJob(),
        item: {
          id: "item-1",
          job_id: "job-1",
          item_key: "ch-1:mcq",
          item_type: "mcq",
          status: "processing",
          payload: {
            courseId: "course-1",
            chapterId: "ch-1",
            type: "mcq",
            numQuestions: 2,
            difficulty: "easy",
            startHidden: false,
          },
          result: {},
          error: null,
          attempts: 1,
          max_attempts: 3,
          locked_until: "1970-01-01T00:00:00.000Z",
          last_heartbeat: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      });

      assertEquals(res.result.type, "mcq");
      assertEquals(res.result.chapter_id, "ch-1");
      assertEquals(res.result.generated, 2);
      assertEquals(res.result.inserted, 2);
      assertEquals(res.result.failed, 0);

      // Generator was called with the expected per-item body shape.
      const genCalls = postsTo(h.fetchLog, "/functions/v1/generate-questions");
      assertEquals(genCalls.length, 1);
      const genBody = JSON.parse(genCalls[0].body!) as Record<string, unknown>;
      assertEquals(genBody.courseId, "course-1");
      assertEquals(genBody.chapterIds, ["ch-1"]);
      assertEquals(genBody.numQuestions, 2);
      assertEquals(genBody.difficulty, "easy");
      assertEquals(genBody.startHidden, false);

      // Two questions landed, with their junctions.
      assertEquals(postsToQuestions(h.fetchLog).length, 2);
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_chapters").length, 2);
      // Second row has no competency_ids → no junction POST for it.
      assertEquals(postsTo(h.fetchLog, "/rest/v1/question_competencies").length, 1);

      // Cumulative progress on the job has bumped.
      assertEquals(jobsState.jobsById["job-1"].progress.created_total, 2);
      assertEquals(jobsState.jobsById["job-1"].progress.failed_total, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "processItem: routes by type — open → generate-open-questions",
  ...OPTS,
  async fn() {
    const jobsState: JobsProgressState = {
      jobsById: { "job-1": { progress: {} } },
    };
    const h = createTestHarness({
      routes: [
        generatorRoute("generate-open-questions", {
          questions: [
            {
              question: "Explain X.",
              type: "open",
              payload: {},
              answer_key: { model_answer: "X is Y." },
              model_answer: "X is Y.",
              explanation: "X is Y because Z.",
              difficulty: "medium",
              hidden: false,
              chapter_ids: ["ch-1"],
              competency_ids: [],
            },
          ],
        }),
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
        jobsProgressRoute(jobsState),
      ],
    });
    try {
      const supabase = makeServiceClient();
      const res = await __bulkQuestionGenerationInternals.processItem({
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        job: buildJob(),
        item: {
          id: "item-2",
          job_id: "job-1",
          item_key: "ch-1:open",
          item_type: "open",
          status: "processing",
          payload: {
            courseId: "course-1",
            chapterId: "ch-1",
            type: "open",
            numQuestions: 1,
            difficulty: "medium",
            startHidden: false,
          },
          result: {},
          error: null,
          attempts: 1,
          max_attempts: 3,
          locked_until: "1970-01-01T00:00:00.000Z",
          last_heartbeat: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      });

      assertEquals(res.result.inserted, 1);
      assertEquals(postsTo(h.fetchLog, "/functions/v1/generate-open-questions").length, 1);
      assertEquals(postsTo(h.fetchLog, "/functions/v1/generate-questions").length, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "processItem: generator HTTP 500 → throws, no questions inserted, no progress bump",
  ...OPTS,
  async fn() {
    const jobsState: JobsProgressState = {
      jobsById: { "job-1": { progress: {} } },
    };
    const h = createTestHarness({
      routes: [
        generatorRoute(
          "generate-questions",
          { error: "boom" },
          { status: 500 },
        ),
        questionsInsertRoute(),
        jobsProgressRoute(jobsState),
      ],
    });
    try {
      const supabase = makeServiceClient();
      await assertRejects(
        () =>
          __bulkQuestionGenerationInternals.processItem({
            // deno-lint-ignore no-explicit-any
            supabase: supabase as any,
            job: buildJob(),
            item: {
              id: "item-bad",
              job_id: "job-1",
              item_key: "ch-1:mcq",
              item_type: "mcq",
              status: "processing",
              payload: {
                courseId: "course-1",
                chapterId: "ch-1",
                type: "mcq",
                numQuestions: 2,
                difficulty: "easy",
                startHidden: false,
              },
              result: {},
              error: null,
              attempts: 1,
              max_attempts: 3,
              locked_until: "1970-01-01T00:00:00.000Z",
              last_heartbeat: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          }),
        Error,
        "HTTP 500",
      );
      // Helper never reached → no `questions` POSTs.
      assertEquals(postsToQuestions(h.fetchLog).length, 0);
      // Progress untouched on failure (runner's per-item tally handles `failed`).
      assertEquals(jobsState.jobsById["job-1"].progress.created_total, undefined);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "processItem: generator returns no questions[] array → throws",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        generatorRoute("generate-questions", { warning: "no content" }),
        questionsInsertRoute(),
      ],
    });
    try {
      const supabase = makeServiceClient();
      await assertRejects(
        () =>
          __bulkQuestionGenerationInternals.processItem({
            // deno-lint-ignore no-explicit-any
            supabase: supabase as any,
            job: buildJob(),
            item: {
              id: "item-no-arr",
              job_id: "job-1",
              item_key: "ch-1:mcq",
              item_type: "mcq",
              status: "processing",
              payload: {
                courseId: "course-1",
                chapterId: "ch-1",
                type: "mcq",
                numQuestions: 2,
                difficulty: "easy",
                startHidden: false,
              },
              result: {},
              error: null,
              attempts: 1,
              max_attempts: 3,
              locked_until: "1970-01-01T00:00:00.000Z",
              last_heartbeat: null,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          }),
        Error,
        "no questions[]",
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "processItem: bumpJobProgress accumulates created_total across two items",
  ...OPTS,
  async fn() {
    const jobsState: JobsProgressState = {
      jobsById: { "job-1": { progress: {} } },
    };
    const h = createTestHarness({
      routes: [
        generatorRoute("generate-questions", {
          questions: [
            {
              question: "Q1",
              type: "mcq",
              payload: { options: ["a", "b"] },
              answer_key: { correct_indices: [0] },
              difficulty: "easy",
              hidden: false,
              chapter_ids: ["ch-1"],
            },
            {
              question: "Q2",
              type: "mcq",
              payload: { options: ["a", "b"] },
              answer_key: { correct_indices: [0] },
              difficulty: "easy",
              hidden: false,
              chapter_ids: ["ch-1"],
            },
          ],
        }),
        junctionRoute("/rest/v1/question_chapters"),
        junctionRoute("/rest/v1/question_competencies"),
        questionsInsertRoute(),
        jobsProgressRoute(jobsState),
      ],
    });
    try {
      const supabase = makeServiceClient();
      const item = {
        id: "item-a",
        job_id: "job-1",
        item_key: "ch-1:mcq",
        item_type: "mcq",
        status: "processing" as const,
        payload: {
          courseId: "course-1",
          chapterId: "ch-1",
          type: "mcq",
          numQuestions: 2,
          difficulty: "easy",
          startHidden: false,
        },
        result: {},
        error: null,
        attempts: 1,
        max_attempts: 3,
        locked_until: "1970-01-01T00:00:00.000Z",
        last_heartbeat: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      // Run two batches against the same job — created_total should accumulate.
      await __bulkQuestionGenerationInternals.processItem({
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        job: buildJob(),
        item,
      });
      await __bulkQuestionGenerationInternals.processItem({
        // deno-lint-ignore no-explicit-any
        supabase: supabase as any,
        job: buildJob(),
        item: { ...item, id: "item-b", item_key: "ch-2:mcq" },
      });

      assertEquals(jobsState.jobsById["job-1"].progress.created_total, 4);
      assertEquals(jobsState.jobsById["job-1"].progress.failed_total, 0);
      assertExists(jobsState.jobsById["job-1"].progress.updated_at);
    } finally {
      h.cleanup();
    }
  },
});

// ── callGenerator timeout ───────────────────────────────────────────────

Deno.test({
  name: "callGenerator: passes an AbortSignal so a stalling generator can't burn the slice budget",
  ...OPTS,
  async fn() {
    let capturedSignal: AbortSignal | null | undefined;
    const fakeFetch: typeof fetch = (_input, init) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ questions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    await __bulkQuestionGenerationInternals.callGenerator(
      {
        courseId: "course-1",
        chapterId: "ch-1",
        type: "mcq",
        numQuestions: 1,
        difficulty: "medium",
        startHidden: false,
      },
      {
        fetch: fakeFetch,
        supabaseUrl: SUPABASE_URL,
        serviceKey: SERVICE_KEY,
      },
    );

    assertExists(capturedSignal);
    // AbortSignal.timeout returns an instance of AbortSignal.
    assertEquals(capturedSignal instanceof AbortSignal, true);
  },
});

Deno.test({
  name: "callGenerator: surfaces a TimeoutError as a readable 'timed out' message",
  ...OPTS,
  async fn() {
    const fakeFetch: typeof fetch = () => {
      const err = new Error("The signal has been aborted");
      err.name = "TimeoutError";
      return Promise.reject(err);
    };

    await assertRejects(
      () =>
        __bulkQuestionGenerationInternals.callGenerator(
          {
            courseId: "course-1",
            chapterId: "ch-1",
            type: "mcq",
            numQuestions: 1,
            difficulty: "medium",
            startHidden: false,
          },
          {
            fetch: fakeFetch,
            supabaseUrl: SUPABASE_URL,
            serviceKey: SERVICE_KEY,
            timeoutMs: 50,
          },
        ),
      Error,
      "timed out after 50ms",
    );
  },
});

// ── Generator → function name mapping is exhaustive ─────────────────────

Deno.test({
  name: "TYPE_TO_FUNCTION covers all 5 question types",
  ...OPTS,
  fn() {
    const m = __bulkQuestionGenerationInternals.TYPE_TO_FUNCTION;
    assertEquals(m.mcq, "generate-questions");
    assertEquals(m.open, "generate-open-questions");
    assertEquals(m.fill_gaps, "generate-fill-gaps-questions");
    assertEquals(m.ordering, "generate-ordering-questions");
    assertEquals(m.classification, "generate-classification-questions");
  },
});
