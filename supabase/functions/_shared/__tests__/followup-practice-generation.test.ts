/**
 * Tests for the follow-up practice generation job handler (#839).
 *
 * Covers the pure surfaces (`parseFollowupParams`, `buildFollowupItemRows`),
 * `expandJob`'s fan-out + error surfacing (via a minimal in-memory fake), and
 * `linkQuestionsToQuiz`'s append-after-max ordering. The generator dispatch
 * itself is exercised by the sibling bulk handler tests — `processItem` reuses
 * that path verbatim.
 */
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildFollowupItemRows,
  parseFollowupParams,
  __followupPracticeGenerationInternals,
} from "../job-handlers/followup-practice-generation.ts";
import type { JobRow } from "../job-handlers.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

function buildJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    type: "followup_practice_generation",
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

// Minimal supabase fake for expandJob (only `from('job_items').insert`).
function makeJobItemsFake() {
  const inserted: Array<Record<string, unknown>> = [];
  let nextError: { message: string } | null = null;
  return {
    inserted,
    setNextInsertError(message: string) {
      nextError = { message };
    },
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table !== "job_items") {
        throw new Error(`makeJobItemsFake: unexpected table ${table}`);
      }
      return {
        insert(rows: Array<Record<string, unknown>> | Record<string, unknown>) {
          const toInsert = Array.isArray(rows) ? rows : [rows];
          if (nextError) {
            const err = nextError;
            nextError = null;
            return Promise.resolve({ data: null, error: err });
          }
          inserted.push(...toInsert);
          return Promise.resolve({ data: toInsert, error: null });
        },
      };
    },
  };
}

// ── parseFollowupParams ──────────────────────────────────────────────────

Deno.test({
  name: "parseFollowupParams: accepts the full happy-path shape",
  ...OPTS,
  fn() {
    const params = parseFollowupParams({
      courseId: "course-1",
      offeringId: "off-1",
      targetQuizId: "draft-1",
      types: ["mcq", "open"],
      chapterIds: ["ch-1", "ch-2"],
      countPerType: 2,
      difficulty: "hard",
      focusInstructions: "Address the fraction misconception.",
    });
    assertEquals(params.courseId, "course-1");
    assertEquals(params.offeringId, "off-1");
    assertEquals(params.targetQuizId, "draft-1");
    assertEquals(params.types, ["mcq", "open"]);
    assertEquals(params.chapterIds, ["ch-1", "ch-2"]);
    assertEquals(params.countPerType, 2);
    assertEquals(params.difficulty, "hard");
    assertEquals(params.focusInstructions, "Address the fraction misconception.");
  },
});

Deno.test({
  name: "parseFollowupParams: dedupes types and leaves difficulty undefined when absent",
  ...OPTS,
  fn() {
    const params = parseFollowupParams({
      courseId: "c",
      offeringId: "o",
      targetQuizId: "d",
      types: ["mcq", "mcq", "open"],
      chapterIds: ["ch-1"],
    });
    assertEquals(params.types, ["mcq", "open"]);
    assertEquals(params.difficulty, undefined);
  },
});

Deno.test({
  name: "parseFollowupParams: throws on missing targetQuizId / offeringId",
  ...OPTS,
  fn() {
    assertThrows(
      () =>
        parseFollowupParams({
          courseId: "c",
          offeringId: "o",
          types: ["mcq"],
          chapterIds: ["ch-1"],
        }),
      Error,
      "targetQuizId is required",
    );
    assertThrows(
      () =>
        parseFollowupParams({
          courseId: "c",
          targetQuizId: "d",
          types: ["mcq"],
          chapterIds: ["ch-1"],
        }),
      Error,
      "offeringId is required",
    );
  },
});

Deno.test({
  name: "parseFollowupParams: throws on empty types / chapters / unsupported type",
  ...OPTS,
  fn() {
    const base = { courseId: "c", offeringId: "o", targetQuizId: "d" };
    assertThrows(
      () => parseFollowupParams({ ...base, types: [], chapterIds: ["ch-1"] }),
      Error,
      "types must be a non-empty subset",
    );
    assertThrows(
      () => parseFollowupParams({ ...base, types: ["mcq"], chapterIds: [] }),
      Error,
      "chapterIds must be a non-empty array",
    );
    assertThrows(
      () => parseFollowupParams({ ...base, types: ["essay"], chapterIds: ["ch-1"] }),
      Error,
      'unsupported type "essay"',
    );
  },
});

// ── buildFollowupItemRows ────────────────────────────────────────────────

Deno.test({
  name: "buildFollowupItemRows: fans out chapters × types with the target + focus",
  ...OPTS,
  fn() {
    const rows = buildFollowupItemRows("job-XYZ", {
      courseId: "course-1",
      offeringId: "off-1",
      targetQuizId: "draft-1",
      types: ["mcq", "open"],
      chapterIds: ["ch-A", "ch-B"],
      countPerType: 2,
      difficulty: "medium",
      focusInstructions: "focus here",
    });

    assertEquals(rows.length, 4);
    assertEquals(
      rows.map((r) => r.item_key).sort(),
      ["ch-A:mcq", "ch-A:open", "ch-B:mcq", "ch-B:open"],
    );
    for (const row of rows) {
      assertEquals(row.job_id, "job-XYZ");
      assertEquals(row.payload.courseId, "course-1");
      assertEquals(row.payload.targetQuizId, "draft-1");
      assertEquals(row.payload.numQuestions, 2);
      assertEquals(row.payload.difficulty, "medium");
      assertEquals(row.payload.focusInstructions, "focus here");
      assertEquals(row.payload.type, row.item_type);
    }
  },
});

// ── expandJob ────────────────────────────────────────────────────────────

Deno.test({
  name: "expandJob: inserts fanned-out rows into job_items",
  ...OPTS,
  async fn() {
    const fake = makeJobItemsFake();
    const job = buildJob({
      params: {
        courseId: "course-1",
        offeringId: "off-1",
        targetQuizId: "draft-1",
        types: ["mcq", "open"],
        chapterIds: ["ch-1"],
        countPerType: 2,
      },
    });
    const result = await __followupPracticeGenerationInternals.expandJob({
      // deno-lint-ignore no-explicit-any
      supabase: fake as any,
      job,
    });
    assertEquals(result.inserted, 2);
    assertEquals(fake.inserted.length, 2);
    assertEquals(
      fake.inserted.map((r) => r.item_key as string).sort(),
      ["ch-1:mcq", "ch-1:open"],
    );
  },
});

Deno.test({
  name: "expandJob: surfaces supabase insert errors",
  ...OPTS,
  async fn() {
    const fake = makeJobItemsFake();
    fake.setNextInsertError("boom");
    const job = buildJob({
      params: {
        courseId: "c",
        offeringId: "o",
        targetQuizId: "d",
        types: ["mcq"],
        chapterIds: ["ch-1"],
      },
    });
    await assertRejects(
      () =>
        __followupPracticeGenerationInternals.expandJob({
          // deno-lint-ignore no-explicit-any
          supabase: fake as any,
          job,
        }),
      Error,
      "job_items insert failed",
    );
  },
});

// ── linkQuestionsToQuiz ──────────────────────────────────────────────────

// Fake covering the count SELECT + the INSERT that linkQuestionsToQuiz issues.
function makeQuizQuestionsFake(existingCount: number) {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table !== "quiz_questions") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select(_cols: string, _opts: unknown) {
          return {
            eq(_col: string, _val: string) {
              return Promise.resolve({ count: existingCount, error: null });
            },
          };
        },
        insert(rows: Array<Record<string, unknown>>) {
          inserted.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

Deno.test({
  name: "linkQuestionsToQuiz: appends rows after the current max order_num",
  ...OPTS,
  async fn() {
    const fake = makeQuizQuestionsFake(3);
    await __followupPracticeGenerationInternals.linkQuestionsToQuiz(
      // deno-lint-ignore no-explicit-any
      fake as any,
      "draft-1",
      ["q-1", "q-2"],
    );
    assertEquals(fake.inserted, [
      { quiz_id: "draft-1", question_id: "q-1", order_num: 3 },
      { quiz_id: "draft-1", question_id: "q-2", order_num: 4 },
    ]);
  },
});

Deno.test({
  name: "linkQuestionsToQuiz: no-ops on an empty question list",
  ...OPTS,
  async fn() {
    const fake = makeQuizQuestionsFake(0);
    await __followupPracticeGenerationInternals.linkQuestionsToQuiz(
      // deno-lint-ignore no-explicit-any
      fake as any,
      "draft-1",
      [],
    );
    assertEquals(fake.inserted.length, 0);
  },
});
