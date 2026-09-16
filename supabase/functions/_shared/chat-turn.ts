/**
 * The shared tutoring turn.
 *
 * `study-tutor` and `socratic-chat` ran the same sequence twice over mirrored
 * tables: authorise, resolve the session, load the transcript, screen the
 * student's message, call the model, screen the reply, persist, chunk out SSE.
 * Every change had to be made in both places — #1039's background-mode switch
 * was two commits (d14e2cda, aa1fd4f8), and #1198's moderation gate is written
 * out twice today.
 *
 * That sequence lives here once. What differs between the two surfaces is
 * declared by a `ChatSubject`: its prompts, its context, its output schema and
 * how state merges. Adding a third surface should mean writing one of those,
 * not another thousand-line handler.
 *
 * Safety note: the moderation gates in `runChatTurn` are load-bearing. Input
 * moderation runs concurrently with the model call rather than ahead of it —
 * the pupil no longer waits on two OpenAI round-trips in series — and a flagged
 * message therefore costs a generation that is thrown away. Neither runner may
 * persist a turn without awaiting that verdict; see `PreparedTurn`.
 *
 * The output-moderation gate is load-bearing too.
 * It screens the completed reply and *withholds* it — the reply never reaches
 * the pupil, the session pauses, the school is told. That is only possible
 * because nothing streams from OpenAI (#1039/#1050 moved both surfaces to
 * background mode). Any future change that streams token-by-token reopens the
 * gap #1198 closed; see `assistant-moderation.ts`.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "./require-aal2.ts";
import { logger } from "./logger.ts";
import { InteractionLogData, isVerboseLoggingEnabled, logInteraction } from "./agent-logging.ts";
import { callOpenAIStructured, StructuredOutputSchema } from "./openai-client.ts";
import { modelFor, PolicyKey } from "./model-policy.ts";
import { disabledFamilyFor } from "./ai-feature-gate.ts";
import {
  DEFAULT_TUTOR_STATE,
  TUTOR_STATE_SCHEMA_VERSION,
  mergeState,
  readStoredState,
  type UnifiedResponse,
} from "./chat-state.ts";
import { streamStructuredTurn } from "./openai-stream.ts";
import { resolveOpenAIStore } from "./openai-retention.ts";
import { StreamingJsonTextExtractor } from "./streaming-json-parser.ts";
import { extractUsageData, trackAIUsage } from "./usage-tracker.ts";
import type { ModerationResult } from "./moderation.ts";
import {
  PAUSE_FAILED_SUFFIX,
  RECORD_FAILED_SUFFIX,
  assistantBlockedMessage,
  flaggedAssistantRecord,
  persistSessionPause,
  recordFlaggedAssistantReply,
  screenAssistantReply,
} from "./assistant-moderation.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Longest single student message. Mirrored in `src/lib/tutor-input-limit.ts`. */
export const INPUT_CHAR_LIMIT = 4096;

/** Whole-transcript ceiling, past which the session pauses for review. */
export const HISTORY_CHAR_LIMIT = 100000;

/**
 * Messages between routine pauses for instructor review — 40 exchanges.
 *
 * Counted in stored rows, so a student question and the tutor's reply are two.
 * The two surfaces used to choose separately (20 on socratic, 100 on the study
 * tutor), which meant the same child hit review after 10 exchanges on one
 * screen and 50 on another with nothing to explain the difference. One number,
 * shared, is the point of it living here rather than in each subject.
 *
 * Mirrored in `src/lib/tutor-turns-before-review.ts`, which the chat surface
 * uses to show how many messages remain before the pause. Change both together.
 */
export const TURNS_BEFORE_REVIEW = 80;

export const START_CONVERSATION = "__START_CONVERSATION__";

/**
 * How long the streaming surface holds the reply waiting for the input verdict.
 *
 * Not a timeout on moderation — the call runs to completion either way and a
 * late verdict is still acted on. This is only the point past which a pupil
 * stops waiting for it, chosen so the usual case (a verdict in a few hundred
 * milliseconds, well inside the model's own first token) never pays anything,
 * while a moderation call gone slow cannot stall a lesson behind it.
 */
export const MODERATION_HOLD_MS = 1_200;

/**
 * Hard ceiling on the input-moderation call itself.
 *
 * `MODERATION_HOLD_MS` only decides when the pupil stops waiting to *read* the
 * reply. This is what stops the turn hanging: the runners await the verdict
 * before persisting and before `[DONE]`, so without a bound here a moderation
 * call that never answers leaves the reply on screen, unsaved, and the panel
 * typing until its own 90-second stall timeout.
 *
 * Same five seconds and same reasoning as `ASSISTANT_MODERATION_TIMEOUT_MS`: a
 * Moderation call that has not answered in five seconds is a call that has
 * failed. Timing out fails open, exactly as an error does — see
 * `screenPupilMessage`.
 */
export const INPUT_MODERATION_TIMEOUT_MS = 5_000;

/**
 * Hands detached work to the runtime so the isolate outlives the response.
 *
 * Without this an edge isolate is free to stop the moment the handler returns,
 * which silently drops whatever was still in flight. Falls back to catching the
 * rejection when there is no runtime to register with — in tests, and locally.
 */
function detach(work: Promise<unknown>, describe: string): void {
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edgeRuntime) {
    edgeRuntime.waitUntil(work);
  } else {
    work.catch((error) => logger.warn(describe, { error: (error as Error).message }));
  }
}

/**
 * Stops a background generation we have decided to throw away.
 *
 * Not awaited — the turn is already over for the pupil and a failed cancel
 * costs tokens rather than correctness — but registered with the runtime all
 * the same. Merely firing it would race the isolate shutting down, which is
 * precisely the case this exists to prevent: the response would go on
 * generating, and billing, with nobody left to read it.
 */
function cancelUpstreamResponse(apiKey: string, responseId: string): void {
  const work = fetch(`https://api.openai.com/v1/responses/${responseId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((res) => {
    if (!res.ok) {
      logger.warn("Could not cancel the generation for a flagged message", {
        responseId,
        status: res.status,
      });
    }
  });
  detach(work, "Could not cancel the generation for a flagged message");
}

export type SubjectKind = "study_session" | "open_question";

/** The shared module logger, named so helpers can take it as a parameter. */
type TurnLogger = typeof logger;

/** The row every surface now shares. */
export interface ChatSession {
  id: string;
  user_id: string;
  course_id: string;
  offering_id: string | null;
  study_session_id: string | null;
  open_question_id: string | null;
  status: string;
  subject_kind: SubjectKind;
}

export interface ChatMessage {
  id?: string;
  role: string;
  content: string;
}

/**
 * Outcome of a subject's authorisation check.
 *
 * On success it carries the scope the session should be created with. Taking
 * `courseId`/`offeringId` from here rather than from the request body is the
 * point: the body is a claim, and a student who could name any course could
 * otherwise attribute their work to one they are not enrolled in.
 */
export type Authorization =
  | { ok: true; courseId: string; offeringId?: string | null }
  | { ok: false; status: number; error: string };

export interface TurnRequest {
  /** Which surface, and which subject row on it. */
  kind: SubjectKind;
  subjectId: string;
  /**
   * Sent by clients, but never used to scope a session — the authorisation
   * check supplies the course. Kept so the contract stays explicit about what
   * is ignored.
   */
  courseId?: string;
  /**
   * The student turn this request is asking about.
   *
   * Inferring it from "the latest user row" races: two sends before either
   * request loads the transcript both resolve to the *second* message, so one
   * commits, the other is declined by the uniqueness rule, and the first
   * message is never answered at all. The client knows the id — it wrote the
   * row — so it says which one it means.
   *
   * Optional: the compatibility shims and any older client omit it, and fall
   * back to the inference.
   */
  replyTo?: string;
  /** Opening turn: no student message is expected. */
  start?: boolean;
}

export interface TurnContext<TCtx> {
  supabase: SupabaseClient;
  session: ChatSession;
  userId: string;
  /** Prior turns, `user` and `assistant` only — never the withheld records. */
  history: ChatMessage[];
  /** The student's latest message, or "" on an opening turn. */
  userMessage: string;
  /**
   * The id of that message, or null on an opening turn.
   *
   * This is what makes "already answered" a question about *this* turn rather
   * than about the conversation, so a racing retry is declined while two
   * genuinely overlapping turns each still get their own reply.
   */
  lastUserMessageId: string | null;
  isStart: boolean;
  language: string;
  subjectContext: TCtx;
  priorState: Record<string, unknown> | null;
  /**
   * Which state contract this turn speaks.
   *
   * 1 is each surface's own legacy shape; 2 is the unified one. Both exist at
   * once on purpose: the unified schema changes what the model emits, so it
   * lands on the opt-in streaming surface first and `/chat` keeps today's
   * behaviour until that has been watched. Deleting the v1 branches is how this
   * gets promoted.
   */
  stateVersion: 1 | 2;
}

/**
 * What `prepareTurn` produces: either a `Response` that already refuses the
 * turn (unauthorised, paused, flagged, over a guard) or everything a runner
 * needs to call the model.
 */
export type PreparedTurn<TCtx> =
  | { refused: Response }
  | {
      refused?: undefined;
      supabase: SupabaseClient;
      session: ChatSession;
      userId: string;
      turn: TurnContext<TCtx>;
      logData: InteractionLogData;
      timings: Record<string, number>;
      requestStart: number;
      /**
       * The pupil's message, being screened concurrently with the model call.
       * `null` when the turn carries no pupil message (a session opening).
       *
       * Every runner MUST await this before the turn is persisted. The gate did
       * not move — it still holds however the reply is delivered — but it is now
       * the runner's job to await it rather than `prepareTurn`'s to block on it.
       */
      inputModeration: Promise<ModerationResult | null> | null;
    };

export interface ModelRequest {
  systemPrompt: string;
  inputMessages: Array<{ role: "user" | "assistant"; content: string }>;
  structuredOutput: StructuredOutputSchema;
  reasoningEffort?: "low" | "medium";
}

export interface TurnState {
  /** Persisted to `chat_session_state.current_state`. */
  next: Record<string, unknown>;
  /** Sent to the client in the metadata frame. */
  metadata: Record<string, unknown>;
  /** Optional columns on `chat_state_history`. */
  llmDecision?: string | null;
  llmJudgement?: string | null;
  llmConfidence?: number | null;
}

/**
 * Everything that differs between one tutoring surface and another.
 *
 * If a new surface needs more than this, the extra belongs here rather than in
 * a fork of `runChatTurn` — that fork is what this module exists to prevent.
 */
export interface ChatSubject<TCtx, TResponse> {
  kind: SubjectKind;
  /** Used for logs, usage attribution and the model policy lookup. */
  functionName: string;
  promptKey: string;
  modelPolicyKey: PolicyKey;

  /**
   * Turns after which the session pauses for instructor review. The two
   * surfaces chose different numbers (100 for study, 20 for socratic) and both
   * are preserved — this is a pedagogical setting, not an accident.
   */
  pauseEveryNMessages: number;

  /**
   * Does this caller have any business taking a turn on this subject, and if
   * so, under which course and offering? Runs before any session row is
   * created, so an unentitled caller leaves no trace.
   */
  authorize(
    supabase: SupabaseClient,
    args: { subjectId: string; userId: string },
  ): Promise<Authorization>;

  /** Subject matter for the prompt: the study material, or the question. */
  loadContext(
    supabase: SupabaseClient,
    args: { subjectId: string; session: ChatSession },
  ): Promise<TCtx>;

  buildModelRequest(ctx: TurnContext<TCtx>): ModelRequest;

  /** The reply text, or "" if the model produced none. */
  extractText(response: TResponse): string;

  /**
   * The field `extractText` reads, named so a streaming transport can pull it
   * out of the structured output as the JSON arrives rather than waiting for
   * the whole object. Must be the first property the model emits — see the
   * ordering note on each subject's schema.
   */
  streamTextField: string;

  /**
   * Fold the model's output into the state that persists — **v1 only**.
   *
   * Under the unified schema the reply *is* the state, so `reduceUnifiedState`
   * below serves both surfaces and this is not called.
   */
  reduceState(ctx: TurnContext<TCtx>, response: TResponse): TurnState;

  /** Wording for the two admin notifications this surface raises. */
  notification: {
    inputFlaggedTitle: string;
    inputFlaggedMessage: (categories: string[]) => string;
    outputFlaggedTitle: string;
    outputFlaggedMessage: (categories: string[]) => string;
  };

  /** Student-facing copy for the two pause paths. */
  pausedCopy: {
    alreadyPaused: string;
    historyLimit: string;
    messageInterval: (count: number) => string;
    /** Only read when `refuseWhenCompleted` is true. */
    alreadyCompleted?: string;
  };

  /**
   * Whether a completed session refuses further turns.
   *
   * Per-surface because the two genuinely differ, and always have: an open
   * question a student marked complete is finished, and its composer has been
   * disabled since long before this file existed. A study session marked
   * complete can be reopened and continued — "Review" is a normal thing to do —
   * so refusing there would break a working flow.
   *
   * Enforced on the server as well as in the UI because the UI is not the
   * boundary: a stale tab, or a client that simply does not check, would
   * otherwise persist turns onto a question the student has finished.
   */
  refuseWhenCompleted: boolean;

  /**
   * Whether a `STOP` decision finishes the session on the student's behalf.
   *
   * True for an open question: `STOP` is the tutor saying the student has
   * answered it, and the surface has always treated that as the end — the
   * buffered page wrote `status='completed'` from the client the moment the
   * evaluator said so. It could do that because the v1 reply carried
   * `evaluator.stop`; the unified v2 reply carries `decision` instead, so that
   * client-side check silently stopped matching anything when streaming became
   * the only surface students see, and a finished question stayed open.
   *
   * The decision belongs on the server anyway. It is the only side that sees
   * the decision on both transports, it already refuses turns on a completed
   * session (`refuseWhenCompleted`), and a client that simply does not look —
   * `StreamingChatPanel` did not — cannot then leave the row disagreeing with
   * the conversation. Clients learn about it the way they learn about a pause:
   * the `chat_sessions` UPDATE over Realtime.
   *
   * False for a study session, which has no notion of a right answer to stop
   * at; a student marks one complete themselves, and reopens it to review.
   */
  completeOnStop: boolean;
}

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

const SESSION_COLUMNS =
  "id, user_id, course_id, offering_id, study_session_id, open_question_id, status, subject_kind";

/**
 * Fold a unified reply into the state that persists.
 *
 * Shared, and that is the point: under the unified schema the model returns the
 * state directly, so there is nothing surface-specific left to reduce. The
 * Socratic surface gains `mergeState`'s rules — `known` unions, mastery never
 * regresses, frustration clamps — which it never had, because it only ever
 * stored the latest verdict.
 */
export function reduceUnifiedState<TCtx>(
  ctx: TurnContext<TCtx>,
  response: UnifiedResponse,
): TurnState {
  const prior = readStoredState(ctx.priorState);
  const patch = { ...DEFAULT_TUTOR_STATE, ...(response.state_update ?? {}) };
  const merged = mergeState(prior, patch);

  const meta = {
    confidence: response.confidence,
    // Whatever the surface added beyond the core travels in `meta` rather than
    // polluting the state the tutor reasons from.
    ...(typeof response.grounding_status === "string"
      ? { grounding_status: response.grounding_status }
      : {}),
  };

  const next = {
    decision: response.decision,
    state_update: merged,
    meta,
    schema_version: TUTOR_STATE_SCHEMA_VERSION,
  };

  return {
    next: next as unknown as Record<string, unknown>,
    // The frontend's `TutorStatePanel` has rendered exactly this shape all
    // along, against a producer that did not exist until now.
    metadata: { state: { decision: response.decision, state_update: merged, meta }, meta },
    llmDecision: response.decision,
    llmJudgement: merged.judgement,
    llmConfidence: response.confidence,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/**
 * Find the session for this (student, subject), creating it on first contact.
 *
 * Both surfaces used to upsert their progress row from several places with
 * slightly different conflict targets. One place, one conflict target.
 */
export async function resolveSession(
  supabase: SupabaseClient,
  args: {
    kind: SubjectKind;
    subjectId: string;
    userId: string;
    courseId?: string;
    offeringId?: string | null;
  },
): Promise<{ session: ChatSession | null; error?: string }> {
  const column = args.kind === "study_session" ? "study_session_id" : "open_question_id";

  const { data: existing, error: selectError } = await supabase
    .from("chat_sessions")
    .select(SESSION_COLUMNS)
    .eq("user_id", args.userId)
    .eq(column, args.subjectId)
    .maybeSingle();

  if (selectError) return { session: null, error: selectError.message };
  if (existing) return { session: existing as ChatSession };

  if (!args.courseId) {
    return { session: null, error: "courseId is required to open a new session" };
  }

  const { data: created, error: insertError } = await supabase
    .from("chat_sessions")
    .insert({
      user_id: args.userId,
      course_id: args.courseId,
      offering_id: args.offeringId ?? null,
      [column]: args.subjectId,
      status: "in_progress",
      started_at: new Date().toISOString(),
    })
    .select(SESSION_COLUMNS)
    .single();

  if (created) return { session: created as ChatSession };

  // Two turns can race here — an opening turn and its retry, or a double
  // submit. Both see no session, both insert, and one loses on the uniqueness
  // constraint. The loser's row is the winner's, so re-read it rather than
  // failing a legitimate turn.
  if (insertError?.code === UNIQUE_VIOLATION) {
    const { data: raced, error: reselectError } = await supabase
      .from("chat_sessions")
      .select(SESSION_COLUMNS)
      .eq("user_id", args.userId)
      .eq(column, args.subjectId)
      .maybeSingle();

    if (raced) return { session: raced as ChatSession };
    return {
      session: null,
      error: reselectError?.message ?? "Failed to open a session",
    };
  }

  return { session: null, error: insertError?.message ?? "Failed to open a session" };
}

/**
 * Why a session was paused. Stored on the session row, so the pause and its
 * reason are one fact rather than two that have to be correlated.
 */
export type PauseReason =
  | "assistant_moderation"
  | "input_moderation"
  | "history_limit"
  | "message_interval";

/**
 * Pause a session, recording why, and say whether the write actually landed.
 *
 * The reason travels *with* the status deliberately. It is what the pupil is
 * shown, and writing it separately — as a `role='moderation'` row the client
 * had to find and correlate — is what made every interleaving of those two
 * writes its own bug. One UPDATE, one Realtime payload, one read.
 */
async function pauseSession(
  supabase: SupabaseClient,
  sessionId: string,
  reason: PauseReason,
): Promise<boolean> {
  return await persistSessionPause({
    write: () =>
      supabase
        .from("chat_sessions")
        .update({ status: "paused", pause_reason: reason, updated_at: new Date().toISOString() })
        .eq("id", sessionId),
    logger,
    context: { sessionId, reason },
  });
}

/**
 * The states a session may be completed *out of*.
 *
 * `not_started` is the column default and `in_progress` is what both runners
 * write, so this is every live session — named positively rather than as "not
 * completed" so that `paused` is excluded by construction. A session paused for
 * moderation must stay paused until someone reviews it, and the reply that
 * triggers a completion is exactly the kind that gets flagged after delivery.
 */
const COMPLETABLE_STATUSES = ["not_started", "in_progress"];

/**
 * End the session if the tutor's decision was `STOP` and this surface ends on
 * one. Returns whether the row was written.
 *
 * This is where a finished open question is actually finished. The buffered
 * page used to do it from the client, off `evaluator.stop` in the v1 reply; the
 * unified v2 reply carries `decision` instead, so that check quietly matched
 * nothing once streaming became the surface students get, and a question the
 * tutor had closed stayed open — composer enabled, badge unset. Deciding it
 * here covers both transports and every client, and the panel hears about it
 * the same way it hears about a pause: the `chat_sessions` UPDATE, over
 * Realtime.
 *
 * Best-effort, and never fatal: the reply is already generated and persisted by
 * the time this runs, so failing the turn over the completion flag would throw
 * away a good answer to protect a badge. A failure is logged, and the student
 * still has the mark-complete control they had before the tutor could do it for
 * them.
 *
 * The status filter also keeps a re-run from moving `completed_at` forward.
 */
export async function completeSessionOnStop(
  supabase: SupabaseClient,
  args: {
    sessionId: string;
    completeOnStop: boolean;
    decision: string | null | undefined;
    judgement: string | null | undefined;
  },
): Promise<boolean> {
  if (!args.completeOnStop || args.decision !== "STOP") return false;

  // A correct answer is what finishes a question, and this is the only place
  // that fact is enforced rather than asked for.
  //
  // The v1 Socratic schema made it structural — `stop` was documented as true
  // only when the judgement was CORRECT, and the surface's own prompt bound the
  // two together. The unified contract asks for the same thing in prose, which
  // is weaker: a model that reads "the exchange is finished" off a student
  // saying they give up would close an unanswered question permanently, since
  // `refuseWhenCompleted` then turns away every later turn.
  //
  // So the pairing is checked here too. Declining is not a failure — the reply
  // is delivered either way, and the student keeps both the composer and the
  // mark-complete control they already had.
  if (args.judgement !== "CORRECT") {
    logger.info("STOP without a correct answer did not complete the session", {
      sessionId: args.sessionId,
      judgement: args.judgement ?? null,
    });
    return false;
  }

  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from("chat_sessions")
      .update({ status: "completed", completed_at: now, updated_at: now })
      .eq("id", args.sessionId)
      .in("status", COMPLETABLE_STATUSES);

    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    // Caught rather than propagated, because both call sites sit in deferred
    // work whose remaining statements — the interaction log, the turn timings —
    // must still run. A transport failure here costs a badge, not a record.
    logger.warn("Failed to complete the session on STOP", {
      error: (error as Error).message,
      sessionId: args.sessionId,
    });
    return false;
  }
}

async function notifyAdmins(
  supabase: SupabaseClient,
  args: { courseId: string; userId: string; title: string; message: string },
): Promise<void> {
  const { error } = await supabase.from("admin_notifications").insert({
    course_id: args.courseId,
    student_id: args.userId,
    type: "content_moderation",
    title: args.title,
    message: args.message,
  });
  if (error) {
    logger.warn("Failed to insert admin notification", { error: error.message, userId: args.userId });
  }
}

/**
 * Chunk a finished reply into the Chat-Completions-shaped SSE frames the
 * client already parses, then a metadata frame, then `[DONE]`.
 *
 * Nothing streams from OpenAI any more (#1039). The client contract is kept
 * verbatim so `parseSSEStream` and the typing animation need no change.
 */
function sseResponse(
  text: string,
  metadata: Record<string, unknown>,
  postWork: () => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const CHUNK = 24;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));

      for (let i = 0; i < text.length; i += CHUNK) {
        send(JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + CHUNK) } }] }));
      }
      send(JSON.stringify({ type: "metadata", ...metadata }));
      send("[DONE]");
      controller.close();

      // `start()` is synchronous now the reply is already complete, so the
      // follow-up work cannot be awaited here. Register it with the runtime so
      // the isolate outlives the closed response, and never let it reject
      // silently.
      const work = postWork();
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
      if (edgeRuntime) {
        edgeRuntime.waitUntil(work);
      } else {
        work.catch((err) => logger.warn("Post-stream work failed", { error: (err as Error).message }));
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Everything a tutoring turn does before the model is called, for any
 * transport: resolve and authorise the caller, resolve the session, refuse a
 * paused one, load the transcript, apply the length/history/interval guards,
 * load subject context and prior state, and screen the student's message.
 *
 * Input moderation is *started* here and awaited by the runner. It used to be
 * awaited here too, which put its whole latency in front of every clean turn;
 * it now runs concurrently with the model call. The gate did not move — it
 * still holds however the reply is delivered — but the runner is now the thing
 * that must not forget, which is why `inputModeration` is a required field on
 * `PreparedTurn` rather than an optional one a runner can quietly ignore.
 *
 * The caller is resolved from the bearer token and authorised against the
 * subject; no identifier from the request body is trusted for authorisation.
 */
export async function prepareTurn<TCtx, TResponse>(
  req: Request,
  subject: ChatSubject<TCtx, TResponse>,
  stateVersion: 1 | 2 = 1,
): Promise<PreparedTurn<TCtx>> {
  const requestStart = Date.now();
  const timings: Record<string, number> = {};

  const body = (await req.json()) as TurnRequest;
  const { kind, subjectId, replyTo, start } = body;

  if (kind !== subject.kind || !subjectId) {
    return refuse({ error: "Missing or mismatched subject" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("Missing required environment variables");
  const supabase = createClient(supabaseUrl, serviceKey);

  // ── Caller gate ────────────────────────────────────────────────────────────
  // Resolve the caller from the token, then authorise that identity against the
  // resource. An id from the body is a claim, not a credential.
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return refuse({ error: "Unauthorized" }, 401);

  const token = authHeader.replace("Bearer ", "");
  const { data: { user: callerUser }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !callerUser) return refuse({ error: "Unauthorized" }, 401);
  // Service-role client, so RLS's aal2 enforcement never runs here — refuse
  // an MFA-enrolled caller whose token is still aal1.
  if (!callerMfaSatisfied(callerUser, token)) {
    return refuse({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
  }
  const userId = callerUser.id;

  // Entitlement first, and only then a session. Resolving first would create a
  // row for a caller who turns out to have no business here, and would take
  // the course from the request body rather than from the check.
  const authorization = await subject.authorize(supabase, { subjectId, userId });
  if (!authorization.ok) {
    logger.warn("Refused a tutoring turn the caller is not entitled to", { userId, subjectId, kind });
    return refuse({ error: authorization.error }, authorization.status);
  }

  const { session, error: sessionError } = await resolveSession(supabase, {
    kind,
    subjectId,
    userId,
    // Scope comes from the authorisation check and only from there. The body
    // also carries a `courseId`, and deliberately does not reach this: a
    // student who could name any course could otherwise open a session
    // attributed to one they are not enrolled in.
    courseId: authorization.courseId,
    offeringId: authorization.offeringId,
  });
  if (!session) {
    logger.error("Failed to resolve chat session", { error: sessionError, subjectId, kind });
    return refuse({ error: sessionError ?? "Session not found" }, 404);
  }

  // Scope a session that has none. The client opens a session when the student
  // starts a turn and cannot know the authorised offering, and every row
  // backfilled from `open_question_progress` predates the column being
  // populated at all. Both leave `offering_id` NULL, which downgrades that
  // session's RLS from section-scoped to course-wide — so it is repaired here,
  // from the authorisation check rather than from anything the caller sent.
  if (!session.offering_id && authorization.offeringId) {
    const { error: scopeError } = await supabase
      .from("chat_sessions")
      .update({ offering_id: authorization.offeringId })
      .eq("id", session.id)
      .is("offering_id", null);

    if (scopeError) {
      logger.warn("Failed to scope session to its offering", { error: scopeError.message });
    } else {
      session.offering_id = authorization.offeringId;
    }
  }

  if (session.status === "paused") {
    logger.warn("Session blocked - paused", { sessionId: session.id });
    return refuse(
      { error: "session_paused", message: subject.pausedCopy.alreadyPaused, paused: true, blocked: true },
      403,
    );
  }

  // The student's turn is already written when this refuses it — the client
  // persists it before the request, which is what makes a retry idempotent —
  // and it is deliberately left where it is.
  //
  // An earlier draft withdrew it, and could not stop: the browser could not
  // delete it (only staff have a DELETE policy on `chat_messages`), so it moved
  // server-side; then `replyTo` was a caller-supplied id, so it was narrowed to
  // the newest row; then to the newest *recent* row. Each bound was real and
  // none was sufficient, because "this row belongs to this request" cannot be
  // established from inside the request that refuses it — the row predates it
  // by design.
  //
  // So it stays, exactly as a refused turn already stays on a *paused* session.
  // The cost is one unanswered turn in a completed question's transcript, which
  // is replayed if the question is reopened; the alternative was privileged
  // deletion on an unprovable premise. Moving the write server-side would
  // remove the whole question, and is the change to make if this ever matters
  // more than it does today.
  if (subject.refuseWhenCompleted && session.status === "completed") {
    logger.info("Session blocked - already completed", { sessionId: session.id });
    return refuse(
      {
        error: "session_completed",
        message: subject.pausedCopy.alreadyCompleted ?? "This question is already marked complete.",
        completed: true,
        blocked: true,
      },
      403,
    );
  }

  const { getEffectiveLanguage } = await import("./language-utils.ts");
  const language = await getEffectiveLanguage(supabase, session.course_id);

  const logData: InteractionLogData = {
    function_name: subject.functionName,
    trace_id: crypto.randomUUID(),
    course_id: session.course_id,
    user_id: userId,
    language,
    is_first_message: !!start,
  };
  logger.setContext({ courseId: session.course_id });

  // ── School AI toggle ───────────────────────────────────────────────────────
  // The school's own admin can switch tutoring off
  // (`institutions.ai_features_disabled`, _shared/ai-feature-gate.ts). Checked
  // here — session resolved, nothing generated yet — so both tutor surfaces
  // refuse with a clean 403 instead of failing mid-turn at the client
  // chokepoint (which still backstops this).
  const disabledFamily = await disabledFamilyFor(
    modelFor(subject.modelPolicyKey).policy,
    { courseId: session.course_id },
  );
  if (disabledFamily) {
    return refuse({ error: "The AI tutor is switched off by your school." }, 403);
  }

  // ── Transcript ─────────────────────────────────────────────────────────────
  // `moderation` rows are the withheld replies. They are excluded here, which
  // is what keeps flagged text out of both the pupil's view and the history
  // replayed to the model.
  const tHistory = Date.now();
  const { data: rows, error: historyError } = await supabase
    .from("chat_messages")
    .select("id, role, content")
    .eq("session_id", session.id)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: true });
  timings.db_history = Date.now() - tHistory;
  if (historyError) logger.warn("Failed to load chat history", { error: historyError.message });

  const history = (rows ?? []) as ChatMessage[];
  const isStart = !!start;

  // The turn being answered: the one the request names, or — for a client that
  // does not name one — the latest, which is what the inference was always
  // doing and is right whenever only one turn is in flight.
  //
  // A named id is checked against this session's own transcript rather than
  // trusted. It is a body value, and the uniqueness rule is global: naming
  // another session's message would block *their* reply.
  const namedTurn = replyTo ? history.find((m) => m.id === replyTo && m.role === "user") : undefined;
  if (replyTo && !namedTurn) {
    return refuse({ error: "That message is not part of this conversation." }, 400);
  }

  const answering = namedTurn ?? [...history].reverse().find((m) => m.role === "user");
  const lastUserMessageId = answering?.id ?? null;
  if (!isStart && !answering) {
    return refuse({ error: "No user message found. Please send a message first." }, 400);
  }
  const userMessage = isStart ? "" : answering!.content;

  if (userMessage.length > INPUT_CHAR_LIMIT) {
    logger.warn("User message exceeds character limit", { length: userMessage.length });
    return refuse(
      {
        error: "message_too_long",
        message: `Your message is too long (${userMessage.length} characters). Please shorten it to ${INPUT_CHAR_LIMIT} characters or less.`,
        maxLength: INPUT_CHAR_LIMIT,
        currentLength: userMessage.length,
      },
      400,
    );
  }

  const historySize = history.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  if (historySize > HISTORY_CHAR_LIMIT) {
    logger.info("Session paused due to history size", { historySize, sessionId: session.id });
    await pauseSession(supabase, session.id, "history_limit");
    return refuse({
      error: "session_paused",
      message: subject.pausedCopy.historyLimit,
      paused: true,
      blocked: true,
      historySize,
      reason: "history_limit",
    });
  }

  if (!isStart && history.length > 0 && history.length % subject.pauseEveryNMessages === 0) {
    logger.info("Session paused at review interval", { count: history.length, sessionId: session.id });
    await pauseSession(supabase, session.id, "message_interval");
    return refuse({
      error: "session_paused",
      message: subject.pausedCopy.messageInterval(history.length),
      paused: true,
      blocked: true,
      messageCount: history.length,
    });
  }

  const subjectContext = await subject.loadContext(supabase, { subjectId, session });

  // ── State ──────────────────────────────────────────────────────────────────
  const { data: stateRow } = await supabase
    .from("chat_session_state")
    .select("id, current_state")
    .eq("session_id", session.id)
    .maybeSingle();

  const priorState = (stateRow?.current_state as Record<string, unknown>) ?? null;
  logData.incoming_state = priorState ?? undefined;

  const turn: TurnContext<TCtx> = {
    supabase,
    session,
    userId,
    history,
    userMessage,
    lastUserMessageId,
    isStart,
    stateVersion,
    language,
    subjectContext,
    priorState,
  };

  // ── Input moderation ───────────────────────────────────────────────────────
  // Started here, awaited by the runner. It runs *concurrently* with the model
  // call rather than ahead of it: the pupil used to wait on two OpenAI
  // round-trips in series, and moderation is the shorter of the two, so
  // sequencing it first added its whole latency to every clean turn.
  //
  // The trade is explicit. The old comment here read "ahead of the model call,
  // so a flagged message costs nothing at OpenAI" — that is what we give up. A
  // flagged message now costs a generation we throw away. Clean turns vastly
  // outnumber flagged ones, so the arithmetic favours it, but the arithmetic is
  // the reason and not an accident.
  //
  // Runs at classroom sensitivity rather than OpenAI's defaults — the two
  // categories a lesson trips innocently (`violence`, `hate`) are held to a
  // higher score before they pause a session. Abuse aimed at the tutor is not
  // one of them: `harassment` keeps OpenAI's own verdict. See
  // `CHAT_MODERATION_THRESHOLDS`.
  const inputModeration = userMessage
    ? screenPupilMessage(userMessage, timings, logger)
    : null;

  return { supabase, session, userId, turn, logData, timings, requestStart, inputModeration };
}

/**
 * Screens the pupil's message. Never rejects: a moderation outage must not take
 * the tutor down with it, so a failure resolves `null` and the turn proceeds
 * unscreened, exactly as the output gate fails open (`assistant-moderation.ts`).
 */
function screenPupilMessage(
  userMessage: string,
  timings: Record<string, number>,
  logger: TurnLogger,
): Promise<ModerationResult | null> {
  const tMod = Date.now();
  return (async () => {
    const { moderateContent, CHAT_MODERATION_THRESHOLDS } = await import("./moderation.ts");
    const result = await moderateContent({
      content: userMessage,
      thresholds: CHAT_MODERATION_THRESHOLDS,
      timeoutMs: INPUT_MODERATION_TIMEOUT_MS,
    });
    timings.input_moderation = Date.now() - tMod;

    // A flag the thresholds tolerated is the one event that tells you whether
    // they are set right, and it is invisible in the turn otherwise — the
    // lesson simply continues. Log it so the calibration is reviewable.
    if (result.suppressedCategories.length > 0) {
      logger.info("Input flag tolerated by classroom thresholds", {
        suppressedCategories: result.suppressedCategories,
        categoryScores: result.suppressedCategories.map(
          (category) => `${category}=${result.categoryScores[category]?.toFixed(3) ?? "n/a"}`,
        ),
      });
    }

    return result;
  })().catch((error) => {
    timings.input_moderation = Date.now() - tMod;
    logger.warn("Input moderation unavailable - message delivered unscreened", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
}

/** What the pupil is told when their own message is what stopped the turn. */
export const INPUT_BLOCKED_MESSAGE =
  "Your message has been flagged by our content moderation system. This session " +
  "has been paused and flagged for review. Please contact your instructor to continue.";

/**
 * Everything that follows a flagged pupil message: the record, the pause, the
 * notification.
 *
 * Shared because the two runners now discover the flag at different moments —
 * the buffered one before it has sent anything, the streaming one possibly
 * mid-reply — and the consequences must not drift apart between them just
 * because the timing differs.
 *
 * Each consequence is attempted independently, for the reason the output gate
 * already learned: chained awaits meant one failing write skipped the pause and
 * the notification too, so a transport blip could leave a flagged session
 * running and the school never told.
 */
export async function applyInputFlagConsequences<TCtx, TResponse>(options: {
  supabase: SupabaseClient;
  session: ChatSession;
  userId: string;
  subject: ChatSubject<TCtx, TResponse>;
  result: ModerationResult;
  logger: TurnLogger;
}): Promise<void> {
  const { supabase, session, userId, subject, result, logger } = options;

  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      logger.error(`Failed to ${what} for a flagged message`, {
        error: (error as Error).message,
        sessionId: session.id,
      });
    }
  };

  await attempt("record the flagged message", async () => {
    const { error } = await supabase.from("chat_messages").insert({
      session_id: session.id,
      role: "moderation",
      content: JSON.stringify({ type: "moderation", result }),
      flagged_offensive: true,
    });
    if (error) throw new Error(error.message);
  });

  let paused = false;
  await attempt("pause the session", async () => {
    paused = await pauseSession(supabase, session.id, "input_moderation");
  });

  await attempt("notify the school", () =>
    notifyAdmins(supabase, {
      courseId: session.course_id,
      userId,
      title: subject.notification.inputFlaggedTitle,
      message:
        subject.notification.inputFlaggedMessage(result.flaggedCategories) +
        (paused ? "" : PAUSE_FAILED_SUFFIX),
    })
  );
}

/** Wraps a refusal so `prepareTurn` returns one shape. */
const refuse = (body: unknown, status = 200): { refused: Response } => ({
  refused: json(body, status),
});

/**
 * Run one tutoring turn and return the reply as a single buffered SSE burst.
 *
 * Nothing streams from OpenAI here (#1039): the reply is generated in
 * background mode and chunked out once complete, which is what lets the
 * output-moderation gate below *withhold* a flagged reply rather than retract
 * it. See `runStreamingChatTurn` for the surface that trades that away.
 */
export async function runChatTurn<TCtx, TResponse>(
  req: Request,
  subject: ChatSubject<TCtx, TResponse>,
): Promise<Response> {
  // v1: today's per-surface schemas. The unified contract changes what the
  // model emits, so it lands on the opt-in streaming surface first and this one
  // keeps its behaviour until that has been watched in the wild.
  const prepared = await prepareTurn(req, subject, 1);
  if (prepared.refused) return prepared.refused;

  const { supabase, session, userId, turn, logData, timings, requestStart, inputModeration } =
    prepared;
  const { history, isStart, priorState } = turn;

  // ── Model ──────────────────────────────────────────────────────────────────
  const request = subject.buildModelRequest(turn);
  const tLlm = Date.now();

  // Background mode, never a streamed body: holding a long-lived streaming
  // connection is what broke #1039, and a background response survives a
  // severed connection because the generation is not tied to it.
  // The failure is held rather than thrown, because the moderation verdict is
  // still outstanding and outranks it. Throwing here would mean a flagged
  // message whose generation happened to fail was never recorded, never paused
  // and never reported — the model breaking would silently disarm the gate.
  let response: TResponse | null = null;
  let modelError: unknown = null;
  try {
    response = await callOpenAIStructured<TResponse>({
      ...modelFor(subject.modelPolicyKey),
      promptText: request.systemPrompt,
      variables: {},
      input: request.inputMessages,
      structuredOutput: request.structuredOutput,
      backgroundOptions: { enabled: true },
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      usageContext: {
        functionName: subject.functionName,
        promptKey: subject.promptKey,
        courseId: session.course_id,
        // Omitting userId would null out per-user cost attribution on every turn.
        userId,
      },
    });
  } catch (error) {
    modelError = error;
  }

  timings.llm = Date.now() - tLlm;

  // ── Input moderation, collected ────────────────────────────────────────────
  // Started before the model call and awaited here, so the pupil waits for
  // whichever of the two is slower rather than for their sum. Nothing has been
  // sent yet on this surface, so a flag still blocks exactly as it did when the
  // gate ran first — the refusal below is the same one `prepareTurn` used to
  // return. What changed is only that the generation was already paid for.
  const inputVerdict = inputModeration ? await inputModeration : null;
  if (inputVerdict?.flagged) {
    logger.warn("Input flagged by moderation - discarding the reply", {
      categories: inputVerdict.flaggedCategories,
      sessionId: session.id,
    });
    await applyInputFlagConsequences({
      supabase,
      session,
      userId,
      subject,
      result: inputVerdict,
      logger,
    });
    return json({
      error: "content_blocked",
      message: INPUT_BLOCKED_MESSAGE,
      flaggedOffensive: true,
      categories: inputVerdict.flaggedCategories,
      flagged: true,
    });
  }

  // The message was clean, so the generation failing is now the only thing
  // wrong with this turn. Hand it back to the handler's error path unchanged.
  if (modelError) throw modelError;

  const replyText = response ? subject.extractText(response) : "";
  if (!replyText) {
    logger.error("Tutor returned no assistant text", { sessionId: session.id });
    return json({
      error: "tutor_empty_response",
      code: "tutor_empty_response",
      message: "The tutor did not produce a reply. Please try again.",
    });
  }

  // ── Output moderation (#1198) ──────────────────────────────────────────────
  // The reply is complete here, so a flag withholds it outright rather than
  // retracting it after the pupil has read it. Fails open: if the Moderation
  // API does not answer, the reply is delivered and logged as unscreened.
  const screening = await screenAssistantReply({ text: replyText, logger });
  timings.output_moderation = screening.durationMs;

  if (screening.flagged) {
    logger.warn("Assistant reply flagged by moderation - withholding turn", {
      categories: screening.categories,
      sessionId: session.id,
    });

    const { error: recordError } = await supabase.from("chat_messages").insert({
      session_id: session.id,
      role: "moderation",
      content: flaggedAssistantRecord(screening, replyText),
      flagged_offensive: true,
    });
    if (recordError) {
      logger.warn("Failed to record withheld assistant reply", { error: recordError.message });
    }

    await recordFlaggedAssistantReply({
      supabase,
      screening,
      text: replyText,
      source: subject.functionName,
      context: { chat_session_id: session.id, course_id: session.course_id, user_id: userId },
      logger,
    });

    const paused = await pauseSession(supabase, session.id, "assistant_moderation");
    await notifyAdmins(supabase, {
      courseId: session.course_id,
      userId,
      title: subject.notification.outputFlaggedTitle,
      message:
        subject.notification.outputFlaggedMessage(screening.categories) +
        (paused ? "" : PAUSE_FAILED_SUFFIX),
    });

    return json({
      error: "content_blocked",
      blockedSide: "assistant",
      message: assistantBlockedMessage(paused),
      flaggedOffensive: true,
      categories: screening.categories,
      flagged: true,
    });
  }

  // ── Persist and reply ──────────────────────────────────────────────────────
  const state = subject.reduceState(turn, response as TResponse);

  // One transaction, not three round-trips. Written separately, the message
  // could land while the state upsert failed: the reply would reach the pupil
  // and `[DONE]` would report success, while the next turn read the previous
  // turn's learning state and the history chain skipped a transition — the
  // tutor's model of what the student knows regressing with nothing to say so.
  //
  // `priorState` is passed rather than re-read inside the function: it is the
  // state this turn was reasoned from, not whatever the row holds by the time
  // the write runs.
  const { data: persistedId, error: persistError } = await supabase.rpc("persist_chat_turn", {
    _session_id: session.id,
    _content: replyText,
    _state: state.next,
    _transition_type: isStart ? "init" : "turn",
    _state_before: priorState,
    _llm_decision: state.llmDecision ?? null,
    _llm_judgement: state.llmJudgement ?? null,
    _llm_confidence: state.llmConfidence ?? null,
    _in_reply_to: turn.lastUserMessageId,
  });

  // NULL means the student's turn had already been answered — a racing retry,
  // declined at the write. Not a fault: the reply that exists stands, and this
  // one is dropped rather than duplicating it.
  if (!persistError && persistedId === null) {
    logger.info("Turn already answered; dropping the duplicate reply", {
      sessionId: session.id,
    });
    return json({
      error: "turn_already_answered",
      code: "turn_already_answered",
      message: "This message has already been answered. Reload to see the reply.",
    });
  }

  if (persistError) {
    // Nothing was recorded, so the turn did not happen. Delivering the reply
    // anyway would show the student text that vanishes on reload and leave the
    // tutor reasoning from state that never advanced. Failing here is what
    // lets the client's retry path re-ask and get a turn that is actually
    // recorded — the reply is regenerated, which costs a call but keeps the
    // transcript and the state honest.
    logger.error("Failed to record the tutoring turn", {
      error: persistError.message,
      sessionId: session.id,
    });
    return json(
      {
        error: "turn_not_recorded",
        code: "turn_not_recorded",
        message: "The tutor's reply could not be saved. Please try again.",
      },
      500,
    );
  }

  logData.presenter_output = replyText;

  // Only what nothing reads back *on this response* is left until after it
  // closes. The completion is read back — over Realtime, by whichever panel is
  // open — which is exactly why it does not need to hold the reply up.
  const postWork = async (): Promise<void> => {
    // Reached only when the turn was persisted: every path above this point
    // returns rather than falling through, so a reply that was not recorded
    // cannot mark the question finished. Output screening has already run and
    // withheld a flagged reply outright on this surface, so unlike the
    // streaming path there is nothing left here to order against.
    await completeSessionOnStop(supabase, {
      sessionId: session.id,
      completeOnStop: subject.completeOnStop,
      decision: state.llmDecision,
      judgement: state.llmJudgement,
    });

    timings.total = Date.now() - requestStart;
    logger.info(`Timings: ${Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" ")}`);

    if (await isVerboseLoggingEnabled(supabase)) {
      logData.response_time_ms = timings.total;
      await logInteraction(supabase, logData);
    }
  };

  return sseResponse(replyText, state.metadata, postWork);
}


/**
 * Run one tutoring turn and stream the reply as the model produces it.
 *
 * ## How this differs from `runChatTurn`, and what it costs
 *
 * The gates are identical — both call `prepareTurn`, so authorisation, the
 * pause guards and input moderation are shared and cannot drift.
 *
 * What differs is the output-moderation gate. `runChatTurn` holds the finished
 * reply and screens it before a single byte reaches the pupil, which is what
 * lets a flagged reply be withheld outright (#1198). Streaming makes that
 * impossible: the text is read as it arrives. So here moderation runs *after*
 * the reply is complete, and a flag can only annotate, pause and notify — the
 * pupil has already read it, and by deliberate product choice the text stays on
 * screen rather than being retracted.
 *
 * That is a real weakening of #1198, accepted for this opt-in surface. The
 * audit trail is not weakened: the flag still lands as a `role='moderation'`
 * row and a `flagged_content` record, exactly as the buffered path writes them.
 *
 * ## Why `[DONE]` goes out before screening
 *
 * Screening used to run before `[DONE]`, holding the stream open so a flag
 * could be delivered in-band. The client finalises the turn on `[DONE]` — it
 * is what ends `parseSSEStream` and clears the typing state — so that put a
 * Moderation round-trip (up to `ASSISTANT_MODERATION_TIMEOUT_MS`) between the
 * last word of a finished reply and the bubble settling: a visible stall on a
 * turn the pupil had already read.
 *
 * So the stream terminates once the turn is *persisted*, and screening runs
 * behind `waitUntil`. Every consequence of a flag is unchanged; only its route
 * to the pupil moved. The `moderation` row is now the sole carrier, and an
 * open panel picks it up over Realtime (`StreamingChatPanel`), which also
 * reaches a pupil who has navigated within the SPA — something the in-band
 * frame never did.
 */
export async function runStreamingChatTurn<TCtx, TResponse>(
  req: Request,
  subject: ChatSubject<TCtx, TResponse>,
): Promise<Response> {
  // v2: the unified state contract. This surface is opt-in and labelled
  // experimental, which is exactly what makes it the right place to run a
  // schema change past real students first.
  const prepared = await prepareTurn(req, subject, 2);
  if (prepared.refused) return prepared.refused;

  const { supabase, session, userId, turn, logData, timings, requestStart, inputModeration } =
    prepared;
  const { isStart, priorState } = turn;

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const request = subject.buildModelRequest(turn);
  const policy = modelFor(subject.modelPolicyKey);
  // Background streaming must send `store: true` (that is what makes #1039's
  // severed connections survivable), so retention is decided here and the
  // stored copy is deleted after the turn unless the institution opted in.
  const retainStored = await resolveOpenAIStore({ courseId: session.course_id });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // The pupil navigated away. The generation is a background response,
          // so it survives and the turn is still persisted below.
        }
      };

      // ── The input-moderation gate, on a streaming surface ──────────────────
      //
      // Moderation runs concurrently with the generation now, which raises a
      // question the buffered path never had to answer: what does the pupil see
      // in the window before the verdict lands?
      //
      // Deltas are *held* rather than dropped or forwarded. The generation
      // still starts immediately — that is where the latency win comes from —
      // but nothing reaches the screen until either the verdict arrives or
      // `MODERATION_HOLD_MS` elapses. In the common case the verdict beats the
      // model's first token outright and the hold costs nothing at all, while a
      // flagged message is stopped before a single word of the reply is read.
      //
      // The hold is capped rather than unbounded because a moderation call that
      // has gone slow must not be able to stall a lesson. Past the cap the
      // reply flows and a late flag is handled after the fact — the pupil has
      // read it, so the honest response is to stop, record, pause and tell the
      // school, which is what `applyInputFlagConsequences` does either way.
      let gateOpen = inputModeration === null;
      let blocked = false;
      const held: string[] = [];
      const abort = new AbortController();
      let upstreamResponseId: string | null = null;

      const flush = () => {
        for (const delta of held) {
          send(JSON.stringify({ choices: [{ delta: { content: delta } }] }));
        }
        held.length = 0;
      };

      // ── "The reply is finished", ahead of the paperwork ────────────────────
      //
      // The visible reply is one field of the structured object; everything
      // after its closing quote — decision, confidence, the whole state_update
      // — is generated with nothing to show for it, and then the turn still
      // awaits the moderation verdict and the persist before `[DONE]`. The
      // client finalises the bubble on `[DONE]`, so without this frame a reply
      // the pupil has finished reading keeps a blinking cursor for the length
      // of that tail.
      //
      // `text_done` says only that the *text* is complete. It promises nothing
      // about persistence — the notices and `[DONE]` still carry that — so it
      // may go out the moment the extractor closes the field. Two guards: never
      // on a blocked turn, and never before the gate has flushed what the pupil
      // is being told is finished.
      let textComplete = false;
      let textDoneSent = false;
      const sendTextDone = () => {
        if (textDoneSent || !textComplete || blocked || !gateOpen) return;
        textDoneSent = true;
        send(JSON.stringify({ type: "text_done" }));
      };

      const openGate = () => {
        if (gateOpen || blocked) return;
        gateOpen = true;
        flush();
        // The text can finish inside the hold — a short reply, a slow verdict —
        // in which case the completion was noted but not yet announced.
        sendTextDone();
      };

      const holdTimer = setTimeout(openGate, MODERATION_HOLD_MS);

      // Resolves once the verdict is in hand, however the turn ends. Awaited
      // after the stream so a verdict that lost the race is never dropped.
      const verdictSettled = inputModeration
        ? inputModeration.then((verdict) => {
            if (verdict?.flagged) {
              blocked = true;
              // Nothing held is ever sent: on this branch the pupil has seen
              // only what escaped before the verdict, which past the cap may be
              // some of the reply and inside it is nothing.
              held.length = 0;
              abort.abort();
              // A background response outlives its connection by design, so
              // abandoning the stream is not enough to stop the work. Cancel it.
              if (upstreamResponseId) {
                cancelUpstreamResponse(apiKey, upstreamResponseId);
              }
            } else {
              openGate();
            }
            return verdict;
          })
        : Promise.resolve(null);

      const tLlm = Date.now();
      let result;
      try {
        result = await streamStructuredTurn(
          {
            apiKey,
            model: policy.model,
            ...(policy.serviceTier ? { serviceTier: policy.serviceTier } : {}),
            instructions: request.systemPrompt,
            input: request.inputMessages,
            structuredOutput: request.structuredOutput as unknown as {
              name: string;
              strict: boolean;
              schema: Record<string, unknown>;
            },
            ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
            retainStored,
            signal: abort.signal,
            // Captured so a flagged verdict can cancel the generation rather
            // than merely stop reading it.
            onResponseId: (id) => {
              upstreamResponseId = id;
              if (blocked) cancelUpstreamResponse(apiKey, id);
            },
            // Same wire shape as the buffered path, so `parseSSEStream` on the
            // client needs no change — the frames simply arrive earlier.
            onTextDelta: (delta) => {
              if (blocked) return;
              if (!gateOpen) {
                held.push(delta);
                return;
              }
              send(JSON.stringify({ choices: [{ delta: { content: delta } }] }));
            },
            onTextDone: () => {
              textComplete = true;
              sendTextDone();
            },
          },
          new StreamingJsonTextExtractor(subject.streamTextField),
        );
      } catch (error) {
        clearTimeout(holdTimer);

        // The verdict outranks the failure, and is awaited before it is
        // reported. Two cases land here and both need it: an abort, which *is*
        // the flag stopping this turn and must not be dressed up as a tutor
        // error; and a genuine stream failure on a turn whose verdict has not
        // arrived yet, where throwing first would mean a flagged message whose
        // generation happened to fail was never recorded, paused or reported.
        const verdict = await verdictSettled.catch(() => null);
        if (verdict?.flagged) {
          logger.warn("Input flagged by moderation - streamed turn abandoned", {
            categories: verdict.flaggedCategories,
            reachedThePupil: gateOpen,
            sessionId: session.id,
          });
          // No in-band frame — the pause on `chat_sessions` is the single
          // carrier this panel reads. See 20260903140000.
          send("[DONE]");
          try {
            controller.close();
          } catch {
            // Already closed by a client disconnect.
          }
          await applyInputFlagConsequences({
            supabase,
            session,
            userId,
            subject,
            result: verdict,
            logger,
          });
          return;
        }

        logger.exception(error as Error, "Streaming turn failed");
        send(JSON.stringify({ type: "error", message: "The tutor could not reply. Please try again." }));
        send("[DONE]");
        controller.close();
        return;
      }

      timings.llm = Date.now() - tLlm;
      clearTimeout(holdTimer);

      // ── The verdict, however late ──────────────────────────────────────────
      // Awaited unconditionally. The stream can finish before moderation
      // answers, and a turn must never be persisted on the strength of a
      // verdict nobody waited for.
      const inputVerdict = await verdictSettled;
      if (inputVerdict?.flagged) {
        logger.warn("Input flagged by moderation - abandoning the streamed reply", {
          categories: inputVerdict.flaggedCategories,
          // Whether the pupil read any of it. Inside the hold this is false and
          // the block is total; past it, some of the reply was on screen and
          // the consequences below are the whole of the response.
          reachedThePupil: gateOpen,
          sessionId: session.id,
        });

        // Deliberately no in-band moderation frame, however tempting it is
        // while the stream is still open. `StreamingChatPanel` derives this
        // state from one place — the pause on `chat_sessions`, which names its
        // own cause in `pause_reason` — and its docstring records why: an
        // earlier draft correlated a second source against the session row and
        // every interleaving of the writes, reads and events was its own bug.
        // The pause below is the carrier, and it distinguishes this pupil's
        // flagged message from a withheld tutor reply. See 20260903140000.
        send("[DONE]");
        try {
          controller.close();
        } catch {
          // Already closed by a client disconnect.
        }

        // The reply is deliberately not persisted. This turn should not have
        // happened, and the session is about to be paused for review; leaving
        // the tutor's answer to a flagged message in the transcript would mean
        // an instructor opening the session reads the reply as though it stood.
        await applyInputFlagConsequences({
          supabase,
          session,
          userId,
          subject,
          result: inputVerdict,
          logger,
        });

        timings.total = Date.now() - requestStart;
        logger.info(`Timings: ${Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" ")}`);
        return;
      }

      const response = result.parsed as TResponse | null;
      const replyText = response ? subject.extractText(response) : "";

      if (!replyText) {
        send(JSON.stringify({ type: "error", message: "The tutor did not produce a reply. Please try again." }));
        send("[DONE]");
        controller.close();
        return;
      }

      // Unified: the reply *is* the state, so this is the shared reducer rather
      // than the subject's own.
      const state = reduceUnifiedState(turn, response as unknown as UnifiedResponse);
      send(JSON.stringify({ type: "metadata", ...state.metadata }));

      // Same transaction the buffered path uses: message, state and history
      // together, so a turn cannot be half-recorded.
      const { data: persistedId, error: persistError } = await supabase.rpc("persist_chat_turn", {
        _session_id: session.id,
        _content: replyText,
        _state: state.next,
        _transition_type: isStart ? "init" : "turn",
        _state_before: priorState,
        _llm_decision: state.llmDecision ?? null,
        _llm_judgement: state.llmJudgement ?? null,
        _llm_confidence: state.llmConfidence ?? null,
        _in_reply_to: turn.lastUserMessageId,
      });
      // Declined: this student turn was answered while this generation ran.
      // The pupil has already read *this* reply, so the honest thing is to say
      // the conversation moved on rather than pretend it was saved.
      if (!persistError && persistedId === null) {
        logger.info("Streamed turn already answered; dropping the duplicate", {
          sessionId: session.id,
        });
        // A notice, not an error: the reply was delivered and the stream has
        // more to say — the moderation screening below may still fire. Sending
        // `type:"error"` here made the client throw and cancel the reader, so a
        // flagged reply arrived after the pupil had stopped listening.
        send(JSON.stringify({
          type: "notice",
          code: "turn_already_answered",
          message: "This message was already answered. Reload to see the saved reply.",
        }));
      } else if (persistError) {
        // The buffered path can refuse the turn outright here. This one cannot
        // — the headers and the text are already gone — so the next best thing
        // is to say so rather than let `[DONE]` imply the reply was kept. It
        // was not: nothing was written, so it vanishes on reload and the tutor
        // reasons from state that never advanced.
        logger.error("Failed to record the streamed turn", {
          error: persistError.message,
          sessionId: session.id,
        });
        // Also a notice. The text is already on screen and screening has not
        // run yet; terminating here would deliver flagged content with no
        // warning and leave the panel unpaused while the server pauses.
        send(JSON.stringify({
          type: "notice",
          code: "turn_not_recorded",
          message: "The tutor's reply could not be saved, so it will not appear if you reload. Please try again.",
        }));
      }

      // Usage attribution is manual here: this path does not go through
      // `openai-client.ts`, which is what normally records it. Without this,
      // every turn on this surface would cost money against no one.
      if (result.usage) {
        // `extractUsageData` reads a Responses payload, so it is handed the
        // shape it expects rather than the SDK's stream result.
        const usage = extractUsageData(
          {
            id: result.responseId,
            model: policy.model,
            status: "completed",
            usage: result.usage,
          },
          timings.llm,
        );
        if (usage) {
          trackAIUsage(usage, {
            functionName: `${subject.functionName}-stream`,
            promptKey: subject.promptKey,
            courseId: session.course_id,
            userId,
          }).catch((err) =>
            logger.warn("Failed to track AI usage", { error: (err as Error).message })
          );
        }
      }

      // Whether the tutor's STOP may end the question. Decided here, applied
      // after screening below. `persistedId === null` is a turn that was
      // already answered — the reply on screen was not the one recorded — so
      // it does not get to close anything.
      const mayComplete = !persistError && persistedId !== null;

      // The turn is persisted, so it is finished as far as the pupil is
      // concerned. Terminating here is what takes screening off the critical
      // path: the client finalises the bubble on `[DONE]`, so holding the
      // stream open for the Moderation round-trip stalled a reply that was
      // already complete and already read.
      send("[DONE]");
      try {
        controller.close();
      } catch {
        // Already closed by a client disconnect.
      }

      const screenAfterwards = async (): Promise<void> => {
        try {
          await screenAndReport();
        } finally {
          // Completion is deferred with the screening, and ordered *after* it.
          //
          // Two reasons, one placement. It is a best-effort write on a reply
          // the pupil has already read, so awaiting it before `[DONE]` put a
          // second database round-trip between the last word of a finished
          // answer and the bubble settling — the same stall that moved
          // screening off the critical path in the first place. And screening
          // may pause this session: `completeSessionOnStop` will not complete a
          // paused row, so running it here is what stops a reply that was
          // withdrawn for review from also closing the question, and what keeps
          // a `completed_at` off a session that is actually paused.
          //
          // In the `finally` so a screening *failure* still completes: nothing
          // was paused in that case, so the question is genuinely finished.
          // The turn's timings and interaction log are here for the same
          // reason — this is the only place they are written now that nothing
          // downstream awaits this work.
          if (mayComplete) {
            await completeSessionOnStop(supabase, {
              sessionId: session.id,
              completeOnStop: subject.completeOnStop,
              decision: state.llmDecision,
              judgement: state.llmJudgement,
            });
          }

          timings.total = Date.now() - requestStart;
          logger.info(`Timings: ${Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" ")}`);

          logData.presenter_output = replyText;
          if (await isVerboseLoggingEnabled(supabase)) {
            logData.response_time_ms = timings.total;
            await logInteraction(supabase, logData);
          }
        }
      };

      const screenAndReport = async (): Promise<void> => {
        const screening = await screenAssistantReply({ text: replyText, logger });
        timings.output_moderation = screening.durationMs;

        if (screening.flagged) {
          logger.warn("Streamed reply flagged after delivery", {
            categories: screening.categories,
            sessionId: session.id,
          });

          // Each consequence is attempted independently. Chained awaits meant
          // one failing write skipped the pause and the notification too — so
          // a transport blip could leave a flagged session running and the
          // school never told.
          const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
            try {
              await fn();
            } catch (error) {
              logger.error(`Failed to ${what} for a flagged reply`, {
                error: (error as Error).message,
                sessionId: session.id,
              });
            }
          };

          // This row is now the *only* thing that tells the pupil. The stream
          // is closed by the time a verdict exists, so unlike the in-band frame
          // it replaced there is no second channel to fall back on: if this
          // write is lost, they keep the flagged reply and are shown a bare
          // "paused for review" that neither names the cause nor says it was
          // not their doing. So it gets a retry, for the same reason the pause
          // does — a transport blip must not be the difference between a child
          // being told and not.
          let recorded = false;
          await attempt("record the withheld text", async () => {
            for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
              const { error } = await supabase.from("chat_messages").insert({
                session_id: session.id,
                role: "moderation",
                content: flaggedAssistantRecord(screening, replyText),
                flagged_offensive: true,
              });
              if (!error) {
                recorded = true;
                return;
              }
              if (attemptNo === 2) throw new Error(error.message);
              logger.warn("Retrying the withheld-reply record", {
                error: error.message,
                sessionId: session.id,
              });
            }
          });

          await attempt("save the flagged content record", () =>
            recordFlaggedAssistantReply({
              supabase,
              screening,
              text: replyText,
              source: `${subject.functionName}-stream`,
              context: { chat_session_id: session.id, course_id: session.course_id, user_id: userId },
              logger,
            })
          );

          let paused = false;
          await attempt("pause the session", async () => {
            paused = await pauseSession(supabase, session.id, "assistant_moderation");
          });

          await attempt("notify the school", () =>
            notifyAdmins(supabase, {
              courseId: session.course_id,
              userId,
              title: subject.notification.outputFlaggedTitle,
              message:
                subject.notification.outputFlaggedMessage(screening.categories) +
                (paused ? "" : PAUSE_FAILED_SUFFIX) +
                (recorded ? "" : RECORD_FAILED_SUFFIX),
            })
          );
          // The pupil is told by the `moderation` row this wrote, which reaches
          // an open panel over Realtime. There is no stream left to say it on —
          // which is why, when that row is missing, the message above says so.
        }
      };

      // The stream is already closed, so this runs with nothing waiting on it.
      // `waitUntil` is what keeps the isolate alive to finish it; without a
      // runtime that offers one the promise is merely floated, which is the
      // same contract `sseResponse` uses on the buffered path.
      const work = screenAfterwards();
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
      if (edgeRuntime) {
        edgeRuntime.waitUntil(work);
      } else {
        work.catch((err) =>
          logger.warn("Post-delivery screening failed", { error: (err as Error).message })
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
