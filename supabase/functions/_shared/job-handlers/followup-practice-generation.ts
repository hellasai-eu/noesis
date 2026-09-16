/**
 * Follow-up practice generation job handler (issue #839).
 *
 * Job type: `followup_practice_generation`. Given a source (closed) quiz's
 * course + chapters, a set of question types, and a natural-language
 * `focusInstructions` derived from the quiz analysis' misconceptions /
 * knowledge gaps, generate a short targeted practice set and attach it to an
 * already-created quiz (`targetQuizId`).
 *
 * That quiz + its `offering_quizzes` row are created up-front by the
 * `enqueue-followup-practice` front-door function so the instructor gets a
 * reviewable link immediately; this job only fills it in. The quiz is
 * published (never a draft) but its offering assignment has `published_at`
 * NULL, so students see nothing until the instructor assigns it — which is
 * what makes filling it in asynchronously safe.
 *
 * Two phases plug into the generic runner (#695), mirroring
 * `bulk-question-generation.ts`:
 *
 *   1. `expandJob` — one `job_items` row per (chapter × type).
 *
 *   2. `processItem` — call the matching `generate-*-questions` function
 *      (forwarding `focusInstructions` as `specialInstructions`, always
 *      `startHidden`), insert the returned rows into the question bank via
 *      the shared helper, then link the freshly-inserted questions into the
 *      target quiz via `quiz_questions` (appended after the current max
 *      `order_num`). Cumulative `created` / `failed` counts are written to
 *      `jobs.progress` for the panel's progress state.
 *
 * Non-transactional by design: a failing batch is `throw`n so the runner
 * marks just that item failed; the quiz keeps whatever questions succeeded.
 */
import { logger } from "../logger.ts";
import {
  registerJobHandler,
  type JobExpandHandlerCtx,
  type JobItemHandlerCtx,
} from "../job-handlers.ts";
import { insertGeneratedQuestions } from "../insert-generated-questions.ts";
import { capNumQuestions } from "../question-utils.ts";
import {
  type BulkQuestionGenerationItemPayload,
  callGenerator,
} from "./bulk-question-generation.ts";
import type { QuestionType } from "../question-payload.ts";

export const FOLLOWUP_PRACTICE_GENERATION_JOB_TYPE = "followup_practice_generation";

const ALLOWED_TYPES: ReadonlySet<QuestionType> = new Set<QuestionType>([
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
]);

const ALLOWED_DIFFICULTIES = ["easy", "medium", "hard"] as const;
type Difficulty = (typeof ALLOWED_DIFFICULTIES)[number];

export interface FollowupPracticeGenerationParams {
  courseId: string;
  offeringId: string;
  /** Pre-created (published, unassigned) quiz these questions are attached to. */
  targetQuizId: string;
  types: QuestionType[];
  chapterIds: string[];
  countPerType: number;
  /** undefined = mixed (random per batch). */
  difficulty?: Difficulty;
  /** Weak-area focus text forwarded to the generators as specialInstructions. */
  focusInstructions?: string;
}

/** Per-item payload stored on `job_items.payload`. */
export interface FollowupPracticeGenerationItemPayload {
  courseId: string;
  targetQuizId: string;
  chapterId: string;
  type: QuestionType;
  numQuestions: number;
  difficulty: Difficulty;
  focusInstructions?: string;
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

/**
 * Parse + validate the job params. Throws on shapes the generators can't act
 * on so the runner marks the whole job failed instead of fanning out invalid
 * work.
 */
export function parseFollowupParams(raw: unknown): FollowupPracticeGenerationParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("followup_practice_generation params must be a JSON object");
  }
  const p = raw as Record<string, unknown>;

  const courseId = asString(p.courseId);
  if (!courseId) {
    throw new Error("followup_practice_generation params.courseId is required");
  }
  const offeringId = asString(p.offeringId);
  if (!offeringId) {
    throw new Error("followup_practice_generation params.offeringId is required");
  }
  const targetQuizId = asString(p.targetQuizId);
  if (!targetQuizId) {
    throw new Error("followup_practice_generation params.targetQuizId is required");
  }

  const rawTypes = Array.isArray(p.types) ? p.types : [];
  const types: QuestionType[] = [];
  const seenTypes = new Set<QuestionType>();
  for (const t of rawTypes) {
    if (typeof t !== "string") continue;
    if (!ALLOWED_TYPES.has(t as QuestionType)) {
      throw new Error(`followup_practice_generation params.types: unsupported type "${t}"`);
    }
    if (seenTypes.has(t as QuestionType)) continue;
    seenTypes.add(t as QuestionType);
    types.push(t as QuestionType);
  }
  if (types.length === 0) {
    throw new Error(
      "followup_practice_generation params.types must be a non-empty subset of mcq/open/fill_gaps/ordering/classification",
    );
  }

  const chapterIds = asStringArray(p.chapterIds);
  if (chapterIds.length === 0) {
    throw new Error("followup_practice_generation params.chapterIds must be a non-empty array");
  }

  const rawCount = typeof p.countPerType === "number" ? p.countPerType : undefined;
  const countPerType = capNumQuestions(rawCount);

  return {
    courseId,
    offeringId,
    targetQuizId,
    types,
    chapterIds,
    countPerType,
    difficulty: parseDifficulty(p.difficulty),
    focusInstructions: asString(p.focusInstructions) ?? undefined,
  };
}

/**
 * Build the `job_items` rows for a parsed params payload. Exported for tests.
 */
export function buildFollowupItemRows(
  jobId: string,
  params: FollowupPracticeGenerationParams,
): Array<{
  job_id: string;
  item_key: string;
  item_type: string;
  payload: FollowupPracticeGenerationItemPayload;
}> {
  const rows: Array<{
    job_id: string;
    item_key: string;
    item_type: string;
    payload: FollowupPracticeGenerationItemPayload;
  }> = [];
  for (const chapterId of params.chapterIds) {
    for (const type of params.types) {
      rows.push({
        job_id: jobId,
        item_key: `${chapterId}:${type}`,
        item_type: type,
        payload: {
          courseId: params.courseId,
          targetQuizId: params.targetQuizId,
          chapterId,
          type,
          numQuestions: params.countPerType ?? capNumQuestions(undefined),
          difficulty: params.difficulty ?? randomDifficulty(),
          focusInstructions: params.focusInstructions,
        },
      });
    }
  }
  return rows;
}

async function expandJob(ctx: JobExpandHandlerCtx): Promise<{ inserted: number }> {
  const params = parseFollowupParams(ctx.job.params);
  const rows = buildFollowupItemRows(ctx.job.id, params);

  logger.info("followup_practice_generation expandJob", {
    jobId: ctx.job.id,
    courseId: params.courseId,
    targetQuizId: params.targetQuizId,
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

function parseItemPayload(raw: unknown): FollowupPracticeGenerationItemPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("followup_practice_generation item.payload must be a JSON object");
  }
  const p = raw as Record<string, unknown>;
  const courseId = asString(p.courseId);
  const targetQuizId = asString(p.targetQuizId);
  const chapterId = asString(p.chapterId);
  const type = asString(p.type) as QuestionType | null;
  if (!courseId || !targetQuizId || !chapterId || !type || !ALLOWED_TYPES.has(type)) {
    throw new Error(
      "followup_practice_generation item.payload missing courseId/targetQuizId/chapterId/type",
    );
  }
  return {
    courseId,
    targetQuizId,
    chapterId,
    type,
    numQuestions: capNumQuestions(
      typeof p.numQuestions === "number" ? p.numQuestions : undefined,
    ),
    difficulty: parseDifficulty(p.difficulty) ?? "medium",
    focusInstructions: asString(p.focusInstructions) ?? undefined,
  };
}

/**
 * Append freshly-inserted questions to the target quiz. `quiz_questions` order
 * is 0-based and contiguous; a single runner worker per job means the
 * read-then-append has no real race, but we still re-read the current count
 * before each append so concurrent items (or a future N-worker runner) don't
 * collide on `order_num`.
 */
async function linkQuestionsToQuiz(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  targetQuizId: string,
  questionIds: string[],
): Promise<void> {
  if (questionIds.length === 0) return;
  const { count, error: countErr } = await supabase
    .from("quiz_questions")
    .select("id", { count: "exact", head: true })
    .eq("quiz_id", targetQuizId);
  if (countErr) {
    throw new Error(`quiz_questions count failed: ${countErr.message ?? String(countErr)}`);
  }
  const base = typeof count === "number" ? count : 0;
  const rows = questionIds.map((question_id, i) => ({
    quiz_id: targetQuizId,
    question_id,
    order_num: base + i,
  }));
  const { error: linkErr } = await supabase.from("quiz_questions").insert(rows);
  if (linkErr) {
    throw new Error(`quiz_questions insert failed: ${linkErr.message ?? String(linkErr)}`);
  }
}

/**
 * Read-modify-write `jobs.progress` with cumulative question counts. Mirrors
 * the bulk handler; single-worker-per-job makes the race window empty, but we
 * re-read before merging so a future N-worker move won't clobber.
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

  // Reuse the bulk generator dispatch verbatim: same per-type functions, same
  // HTTP contract. Generated questions start hidden in the bank (as bulk
  // generation does — `hidden` gates free-practice listings, not this quiz)
  // and forward the weak-area focus as specialInstructions.
  const generatorPayload: BulkQuestionGenerationItemPayload = {
    courseId: payload.courseId,
    chapterId: payload.chapterId,
    type: payload.type,
    numQuestions: payload.numQuestions,
    difficulty: payload.difficulty,
    startHidden: true,
    specialInstructions: payload.focusInstructions,
  };

  const questions = await callGenerator(generatorPayload, {
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

  const insertedIds = insertResult.inserted.map((r) => r.id);
  await linkQuestionsToQuiz(ctx.supabase, payload.targetQuizId, insertedIds);

  const generated = questions.length;
  const inserted = insertedIds.length;
  const failed = insertResult.errors.length;

  await bumpJobProgress(ctx.supabase, ctx.job.id, { created: inserted, failed });

  return {
    result: {
      type: payload.type,
      chapter_id: payload.chapterId,
      target_quiz_id: payload.targetQuizId,
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
  type: FOLLOWUP_PRACTICE_GENERATION_JOB_TYPE,
  expandJob,
  processItem,
});

export const __followupPracticeGenerationInternals = {
  expandJob,
  processItem,
  linkQuestionsToQuiz,
};
