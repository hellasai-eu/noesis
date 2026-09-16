import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CHAT_MODERATION_THRESHOLDS,
  moderateContent,
  saveFlaggedContent,
  type ModerationResult,
} from "./moderation.ts";

/**
 * Output-side moderation for the two tutors (#1198).
 *
 * Both tutors moderated the student's message and nothing else: the model's
 * reply reached the pupil, and was written to chat history, unscreened. This
 * closes that gap on the terms of option A in #1198 — screen the completed
 * reply, and on a flag record it, pause the session and tell the school,
 * rather than letting the turn pass as though it were fine.
 *
 * Neither handler streams from OpenAI any more (#1039/#1050 moved both to
 * background mode), so the whole reply is in hand before the first SSE byte
 * is written. Screening it there costs one Moderation API round-trip and
 * withholds a flagged reply outright, which is strictly better than the
 * retract-after-display that option A had to assume.
 */

export type AssistantScreeningOutcome = "clean" | "flagged" | "unscreened";

export interface AssistantScreening {
  /**
   * - `clean`      — screened, nothing flagged. Deliver the reply.
   * - `flagged`    — screened, flagged. Withhold, record, pause, notify.
   * - `unscreened` — the Moderation API did not answer. Deliver the reply.
   */
  outcome: AssistantScreeningOutcome;
  flagged: boolean;
  categories: string[];
  result: ModerationResult | null;
  /** Present only when `outcome === "unscreened"`. */
  error: string | null;
  /** Wall-clock cost of the screening call, for the per-turn timing line. */
  durationMs: number;
}

/**
 * The screening call is on the interactive path, so it gets a hard ceiling
 * rather than inheriting the function's overall budget. A Moderation call
 * that has not answered in five seconds is a call that has failed, and the
 * pupil should not be watching a spinner for it.
 */
export const ASSISTANT_MODERATION_TIMEOUT_MS = 5_000;

export interface ScreenAssistantReplyOptions {
  /** The completed assistant reply. */
  text: string;
  apiKey?: string;
  logger?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
  };
}

/**
 * Screens a completed assistant reply.
 *
 * **Fails open, deliberately.** If the Moderation API errors, rate-limits or
 * times out, this returns `unscreened` and the caller delivers the reply. The
 * alternative — dropping the turn — would make a moderation outage look to a
 * pupil like the tutor breaking, and would take a teaching surface down with a
 * dependency that teaches nothing. The cost of failing open is a reply nobody
 * checked; it is logged as exactly that, and the provider's own refusal path
 * (the OpenAI 403 both handlers already catch) still stands behind it.
 */
export async function screenAssistantReply(
  options: ScreenAssistantReplyOptions,
): Promise<AssistantScreening> {
  const { text, apiKey, logger } = options;
  const startedAt = Date.now();

  try {
    const result = await moderateContent({
      content: text,
      apiKey,
      // Same classroom sensitivity as the input gate. A tutor explaining a
      // battle should not be able to pause its own pupil's session.
      thresholds: CHAT_MODERATION_THRESHOLDS,
      timeoutMs: ASSISTANT_MODERATION_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;

    logger?.info("Output moderation result", {
      flagged: result.flagged,
      categories: result.flaggedCategories,
      // What the classroom thresholds let through. The signal that tells you
      // whether they are set right, so it belongs in the log either way.
      suppressedCategories: result.suppressedCategories,
      outputLength: text.length,
      durationMs,
    });

    return {
      outcome: result.flagged ? "flagged" : "clean",
      flagged: result.flagged,
      categories: result.flaggedCategories,
      result,
      error: null,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);

    // Fail open: the reply goes out unscreened, and says so in the log.
    logger?.warn("Output moderation unavailable - reply delivered unscreened", {
      error: message,
      outputLength: text.length,
      durationMs,
    });

    return {
      outcome: "unscreened",
      flagged: false,
      categories: [],
      result: null,
      error: message,
      durationMs,
    };
  }
}

export interface RecordFlaggedAssistantReplyOptions {
  supabase: SupabaseClient;
  screening: AssistantScreening;
  /** The withheld reply, kept verbatim so a reviewer can read what was said. */
  text: string;
  /** Which tutor produced it — `socratic-chat` or `study-tutor`. */
  source: string;
  /** Identifiers for the reviewer: question/session, course, student. */
  context: Record<string, unknown>;
  logger?: { error: (msg: string, data?: Record<string, unknown>) => void };
}

/**
 * Writes the withheld reply to `flagged_content` for review. Best-effort: a
 * failure here is logged, never thrown, because the pause and the notification
 * are the parts a school actually depends on.
 */
export async function recordFlaggedAssistantReply(
  options: RecordFlaggedAssistantReplyOptions,
): Promise<void> {
  const { supabase, screening, text, source, context, logger } = options;

  await saveFlaggedContent({
    supabase,
    data: {
      type: "assistant_reply",
      source,
      assistant_text: text,
      categories: screening.categories,
      category_scores: screening.result?.categoryScores ?? {},
      ...context,
    },
    description: `AI tutor reply flagged by moderation (${source}): ${
      screening.categories.join(", ") || "unknown categories"
    }`,
    logger,
  });
}

/**
 * Runs the write that pauses a session, retrying once, and reports whether the
 * session is *actually* paused.
 *
 * The pause is the control that stops a misbehaving tutor from taking another
 * turn. Firing it and ignoring the result meant a failed write left the session
 * active while everything downstream — the response to the pupil, the message
 * to the school — said it had been paused; the client rebuilds pause state from
 * the database on reload, so tutoring would simply resume with no review. A
 * safety control that reports success it did not achieve is worse than one that
 * is absent, because nobody goes looking for it.
 *
 * The caller passes a thunk rather than a built query so the retry issues a
 * fresh request. A `false` return is not swallowed: the caller must tell a
 * human, because at that point only a human can pause the session.
 */
export async function persistSessionPause(options: {
  write: () => PromiseLike<{ error: { message: string } | null }>;
  logger?: { error: (msg: string, data?: Record<string, unknown>) => void };
  context?: Record<string, unknown>;
}): Promise<boolean> {
  const { write, logger, context } = options;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await write();
      if (!error) return true;
      logger?.error("Failed to pause session after moderation flag", {
        ...context,
        attempt,
        error: error.message,
      });
    } catch (error) {
      logger?.error("Failed to pause session after moderation flag", {
        ...context,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return false;
}

/**
 * Appended to the school's notification when the automatic pause did not take.
 * The incident still has to reach a human who can act on it.
 */
/**
 * Appended when the withheld-reply record could not be written.
 *
 * On the streaming surface that record is the pupil's only warning — the stream
 * has closed by the time a verdict exists. If it is lost, the pupil is left
 * looking at flagged text under a bare "paused for review" notice, with nothing
 * saying it was not their doing. Nobody downstream can infer that from the
 * pause alone, so the school is told plainly that the child has not been told.
 */
export const RECORD_FAILED_SUFFIX =
  " WARNING: the withheld reply could not be recorded, so the student has NOT been" +
  " shown any explanation — they can still see the flagged text and will need one" +
  " from a person.";

export const PAUSE_FAILED_SUFFIX =
  " WARNING: the automatic pause did not take — this session is still active and must be paused manually.";

/** The chat-history payload recording a withheld reply, for instructor review. */
export function flaggedAssistantRecord(
  screening: AssistantScreening,
  text: string,
): string {
  return JSON.stringify({
    type: "moderation",
    side: "assistant",
    decision: "blocked",
    categories: screening.result?.categories ?? {},
    flaggedCategories: screening.categories,
    withheld_text: text,
    timestamp: new Date().toISOString(),
  });
}

/**
 * The student-facing copy for a withheld reply.
 *
 * Kept apart from the input-side copy on purpose. The input-side message tells
 * a pupil their own message was flagged; saying that when the *tutor* produced
 * the flagged text would blame a child for something they did not do.
 *
 * The pause claim is conditional on the pause having actually happened. When
 * the write fails twice there is nothing more this handler can do to pause the
 * session — the database is refusing — but it must not tell a child something
 * untrue about what the platform did on their behalf. The withholding and the
 * notification are true in both cases, so those are what the copy asserts.
 */
export function assistantBlockedMessage(sessionPaused: boolean): string {
  const withheld =
    "The tutor's reply was withheld by our content moderation system before it reached you. " +
    "This was not caused by anything you wrote. ";

  return sessionPaused
    ? withheld + "The session has been paused and your instructor has been notified."
    : withheld + "Your instructor has been notified and will need to review this session before you continue.";
}
