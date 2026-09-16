/**
 * Bulk question-generation job handler (issue #697).
 *
 * Job type: `bulk_question_generation`. Given a course, a set of chapters,
 * and a set of question types, generate `countPerType` questions per
 * (chapter × type) batch by calling the matching `generate-*-questions`
 * edge function, then insert the rows via the shared insert helper (#696).
 *
 * Two phases plug into the generic runner (#695):
 *
 *   1. `expandJob` — one-shot expansion. Validates `job.params` and bulk
 *      inserts one `job_items` row per chapter × type pair. Idempotent
 *      because the runner only calls it when no items exist; the
 *      `(job_id, item_key)` unique constraint is the second guard.
 *
 *   2. `processItem` — for each item, call the right generator over HTTP,
 *      pipe the returned `questions[]` into `insertGeneratedQuestions`,
 *      then read-modify-write `jobs.progress` with cumulative `created` /
 *      `failed` question counts so the progress UI (#699) has live totals.
 *
 * Non-transactional by AC: a failing batch is `throw`n so the runner marks
 * just that item failed (with an error string + attempt count) and the
 * other items keep running. The job ends `completed` or `partially_completed`
 * based on the runner's tally, never aborts mid-run.
 */
import { logger } from "../logger.ts";
import {
  registerJobHandler,
  type JobExpandHandlerCtx,
  type JobItemHandlerCtx,
} from "../job-handlers.ts";
import { insertGeneratedQuestions } from "../insert-generated-questions.ts";
import { capNumQuestions } from "../question-utils.ts";
import type { QuestionType } from "../question-payload.ts";

export const BULK_QUESTION_GENERATION_JOB_TYPE = "bulk_question_generation";

const ALLOWED_TYPES: ReadonlySet<QuestionType> = new Set<QuestionType>([
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);

const TYPE_TO_FUNCTION: Record<QuestionType, string> = {
  mcq: "generate-questions",
  open: "generate-open-questions",
  fill_gaps: "generate-fill-gaps-questions",
  ordering: "generate-ordering-questions",
  classification: "generate-classification-questions",
};

/** Difficulty values the generators accept; mirrored as the schema's enum. */
const ALLOWED_DIFFICULTIES = ["easy", "medium", "hard"] as const;
type Difficulty = (typeof ALLOWED_DIFFICULTIES)[number];

const ALLOWED_DIAGRAM_MODES = ["off", "auto", "on"] as const;
type DiagramMode = (typeof ALLOWED_DIAGRAM_MODES)[number];

export interface BulkQuestionGenerationParams {
  courseId: string;
  types: QuestionType[];
  chapterIds: string[];
  countPerType?: number;
  difficulty?: Difficulty;
  competencyIds?: string[];
  startHidden?: boolean;
  diagramMode?: DiagramMode;
  specialInstructions?: string;
}

/**
 * Per-item payload stored on `job_items.payload`. The `processItem` body
 * unpacks this and POSTs it (with a few rewrites) to the per-type generator.
 */
export interface BulkQuestionGenerationItemPayload {
  courseId: string;
  chapterId: string;
  type: QuestionType;
  numQuestions: number;
  difficulty: Difficulty;
  startHidden: boolean;
  diagramMode?: DiagramMode;
  specialInstructions?: string;
  competencyIds?: string[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function parseDifficulty(value: unknown): Difficulty | undefined {
  return ALLOWED_DIFFICULTIES.includes(value as Difficulty)
    ? (value as Difficulty)
    : undefined;
}

function randomDifficulty(): Difficulty {
  return ALLOWED_DIFFICULTIES[Math.floor(Math.random() * ALLOWED_DIFFICULTIES.length)];
}

function parseDiagramMode(value: unknown): DiagramMode | undefined {
  return ALLOWED_DIAGRAM_MODES.includes(value as DiagramMode)
    ? (value as DiagramMode)
    : undefined;
}

/**
 * Parse + validate the job params payload. Throws on shapes the generators
 * can't act on so the runner marks the whole job failed instead of fanning
 * out invalid work.
 */
export function parseBulkParams(raw: unknown): BulkQuestionGenerationParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bulk_question_generation params must be a JSON object");
  }
  const p = raw as Record<string, unknown>;

  const courseId = asString(p.courseId);
  if (!courseId) {
    throw new Error("bulk_question_generation params.courseId is required");
  }

  const rawTypes = Array.isArray(p.types) ? p.types : [];
  const types: QuestionType[] = [];
  const seenTypes = new Set<QuestionType>();
  for (const t of rawTypes) {
    if (typeof t !== "string") continue;
    if (!ALLOWED_TYPES.has(t as QuestionType)) {
      throw new Error(`bulk_question_generation params.types: unsupported type "${t}"`);
    }
    if (seenTypes.has(t as QuestionType)) continue;
    seenTypes.add(t as QuestionType);
    types.push(t as QuestionType);
  }
  if (types.length === 0) {
    throw new Error("bulk_question_generation params.types must be a non-empty subset of mcq/open/fill_gaps/ordering/classification");
  }

  const chapterIds = asStringArray(p.chapterIds);
  if (chapterIds.length === 0) {
    throw new Error("bulk_question_generation params.chapterIds must be a non-empty array");
  }

  const competencyIds = asStringArray(p.competencyIds);

  const rawCount = typeof p.countPerType === "number" ? p.countPerType : undefined;
  const countPerType = capNumQuestions(rawCount);

  return {
    courseId,
    types,
    chapterIds,
    countPerType,
    // undefined means "mixed" — buildJobItemRows will pick a random
    // difficulty per (chapter × type) batch.
    difficulty: parseDifficulty(p.difficulty),
    competencyIds: competencyIds.length > 0 ? competencyIds : undefined,
    startHidden: p.startHidden === true,
    diagramMode: parseDiagramMode(p.diagramMode),
    specialInstructions: asString(p.specialInstructions) ?? undefined,
  };
}

/**
 * Build the rows to insert into `job_items` for a parsed params payload.
 * Exported for tests so item shape can be asserted without round-tripping
 * through the runner.
 */
export function buildJobItemRows(
  jobId: string,
  params: BulkQuestionGenerationParams,
): Array<{
  job_id: string;
  item_key: string;
  item_type: string;
  payload: BulkQuestionGenerationItemPayload;
}> {
  const rows: Array<{
    job_id: string;
    item_key: string;
    item_type: string;
    payload: BulkQuestionGenerationItemPayload;
  }> = [];
  for (const chapterId of params.chapterIds) {
    for (const type of params.types) {
      rows.push({
        job_id: jobId,
        item_key: `${chapterId}:${type}`,
        item_type: type,
        payload: {
          courseId: params.courseId,
          chapterId,
          type,
          numQuestions: params.countPerType ?? capNumQuestions(undefined),
          // undefined difficulty means "mixed" — assign a random level per batch.
          difficulty: params.difficulty ?? randomDifficulty(),
          startHidden: params.startHidden ?? false,
          diagramMode: params.diagramMode,
          specialInstructions: params.specialInstructions,
          competencyIds: params.competencyIds,
        },
      });
    }
  }
  return rows;
}

async function expandJob(
  ctx: JobExpandHandlerCtx,
): Promise<{ inserted: number }> {
  const params = parseBulkParams(ctx.job.params);
  const rows = buildJobItemRows(ctx.job.id, params);

  logger.info("bulk_question_generation expandJob", {
    jobId: ctx.job.id,
    courseId: params.courseId,
    chapters: params.chapterIds.length,
    types: params.types.length,
    items: rows.length,
  });

  // deno-lint-ignore no-explicit-any
  const sb = ctx.supabase as any;
  const { error } = await sb.from("job_items").insert(rows);
  if (error) {
    throw new Error(`job_items insert failed: ${error.message ?? String(error)}`);
  }
  return { inserted: rows.length };
}

function parseItemPayload(raw: unknown): BulkQuestionGenerationItemPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("bulk_question_generation item.payload must be a JSON object");
  }
  const p = raw as Record<string, unknown>;
  const courseId = asString(p.courseId);
  const chapterId = asString(p.chapterId);
  const type = asString(p.type) as QuestionType | null;
  if (!courseId || !chapterId || !type || !ALLOWED_TYPES.has(type)) {
    throw new Error("bulk_question_generation item.payload missing courseId/chapterId/type");
  }
  return {
    courseId,
    chapterId,
    type,
    numQuestions: capNumQuestions(
      typeof p.numQuestions === "number" ? p.numQuestions : undefined,
    ),
    difficulty: parseDifficulty(p.difficulty) ?? "medium",
    startHidden: p.startHidden === true,
    diagramMode: parseDiagramMode(p.diagramMode),
    specialInstructions: asString(p.specialInstructions) ?? undefined,
    competencyIds: asStringArray(p.competencyIds),
  };
}

function buildGeneratorBody(payload: BulkQuestionGenerationItemPayload): Record<string, unknown> {
  return {
    courseId: payload.courseId,
    numQuestions: payload.numQuestions,
    difficulty: payload.difficulty,
    chapterIds: [payload.chapterId],
    competencyIds: payload.competencyIds && payload.competencyIds.length > 0
      ? payload.competencyIds
      : undefined,
    startHidden: payload.startHidden,
    diagramMode: payload.diagramMode,
    specialInstructions: payload.specialInstructions,
  };
}

/**
 * Per-generator HTTP timeout. The platform's hard invocation cap is ~180s
 * and the runner's slice deadline is 150s; capping a single batch at 120s
 * keeps a stalling generator from burning the whole slice and starving
 * subsequent items.
 */
export const GENERATOR_HTTP_TIMEOUT_MS = 120_000;

/**
 * Call the per-type `generate-*` edge function. Returns the parsed
 * `questions[]` payload on success; throws on HTTP / parse / timeout errors
 * so the runner records the failure on the item.
 *
 * Generators are pinned `verify_jwt = false` (see config.toml) so a
 * service-role bearer is sufficient.
 */
export async function callGenerator(
  payload: BulkQuestionGenerationItemPayload,
  deps: {
    fetch: typeof fetch;
    supabaseUrl: string;
    serviceKey: string;
    timeoutMs?: number;
  },
): Promise<unknown[]> {
  const fnName = TYPE_TO_FUNCTION[payload.type];
  const url = `${deps.supabaseUrl}/functions/v1/${fnName}`;
  const body = buildGeneratorBody(payload);
  const timeoutMs = deps.timeoutMs ?? GENERATOR_HTTP_TIMEOUT_MS;

  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.serviceKey}`,
        apikey: deps.serviceKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${fnName} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${fnName} fetch failed: ${(err as Error).message ?? String(err)}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      detail = errBody?.error ? `: ${errBody.error}` : `: ${JSON.stringify(errBody)}`;
    } catch (_e) {
      try {
        detail = `: ${await res.text()}`;
      } catch (_e2) {
        detail = "";
      }
    }
    throw new Error(`${fnName} returned HTTP ${res.status}${detail}`);
  }

  const data = await res.json().catch((err) => {
    throw new Error(`${fnName} returned non-JSON body: ${(err as Error).message}`);
  });
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(`${fnName} reported error: ${String(data.error)}`);
  }
  const questions = (data as { questions?: unknown[] })?.questions;
  if (!Array.isArray(questions)) {
    throw new Error(`${fnName} returned no questions[] array`);
  }
  return questions;
}

/**
 * Read-modify-write `jobs.progress` with cumulative question counts. With a
 * single runner worker per job the race window is empty; we still re-read
 * before merging so a future move to N workers won't silently clobber.
 */
async function bumpJobProgress(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  jobId: string,
  delta: { created: number; failed: number },
): Promise<void> {
  const { data: current, error: readErr } = await supabase
    .from("jobs")
    .select("progress")
    .eq("id", jobId)
    .maybeSingle();
  if (readErr) {
    logger.exception("bumpJobProgress: read failed", readErr, { jobId });
    return;
  }
  const progress = (current?.progress && typeof current.progress === "object"
    ? current.progress
    : {}) as Record<string, unknown>;
  const created = (typeof progress.created_total === "number" ? progress.created_total : 0) + delta.created;
  const failed = (typeof progress.failed_total === "number" ? progress.failed_total : 0) + delta.failed;
  const { error: updErr } = await supabase
    .from("jobs")
    .update({
      progress: {
        ...progress,
        created_total: created,
        failed_total: failed,
        updated_at: new Date().toISOString(),
      },
    })
    .eq("id", jobId);
  if (updErr) {
    logger.exception("bumpJobProgress: update failed", updErr, { jobId });
  }
}

async function processItem(
  ctx: JobItemHandlerCtx,
): Promise<{ result: Record<string, unknown> }> {
  const payload = parseItemPayload(ctx.item.payload);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured for generator dispatch");
  }

  const questions = await callGenerator(payload, {
    fetch: globalThis.fetch,
    supabaseUrl,
    serviceKey,
  });

  const insertResult = await insertGeneratedQuestions(ctx.supabase, {
    type: payload.type,
    courseId: payload.courseId,
    createdBy: ctx.job.created_by,
    generated: questions as Parameters<typeof insertGeneratedQuestions>[1]["generated"],
  });

  const generated = questions.length;
  const inserted = insertResult.inserted.length;
  const failed = insertResult.errors.length;

  await bumpJobProgress(ctx.supabase, ctx.job.id, {
    created: inserted,
    failed,
  });

  return {
    result: {
      type: payload.type,
      chapter_id: payload.chapterId,
      generated,
      inserted,
      failed,
      errors: insertResult.errors.slice(0, 10).map((e) => ({
        index: e.index,
        question: e.question?.slice(0, 200),
        error: e.error.slice(0, 500),
      })),
    },
  };
}

registerJobHandler({
  type: BULK_QUESTION_GENERATION_JOB_TYPE,
  expandJob,
  processItem,
});

export const __bulkQuestionGenerationInternals = {
  expandJob,
  processItem,
  callGenerator,
  TYPE_TO_FUNCTION,
  GENERATOR_HTTP_TIMEOUT_MS,
};
