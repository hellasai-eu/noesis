/**
 * Streaming Responses calls, via the OpenAI SDK.
 *
 * Everything else here talks to OpenAI through hand-rolled `fetch` in
 * `openai-client.ts`. This module is the exception, and the reason is narrow:
 * resumable background streaming. The SDK exposes
 * `responses.stream(id, { starting_after })`, which is exactly the recovery
 * this needs and which would otherwise be a second SSE client written by hand.
 *
 * ## Why background mode is not optional here
 *
 * #1039: holding a long-lived streamed connection to OpenAI got the body
 * severed at arbitrary offsets — 880ms after 2 frames, 8.5s after 265 — always
 * a clean EOF, never a terminal event. And the stored response 404'd afterwards
 * despite `store: true`, because a *non-background* response is cancelled when
 * its connection dies. Both surfaces moved to background + polling as a result.
 *
 * A background response does not die with its connection. So the severing
 * becomes recoverable: reconnect with the last `sequence_number` and carry on.
 * Streaming naively — `stream: true` alone — would reproduce #1039 exactly.
 *
 * The version is pinned rather than floated on a major. An edge function that
 * resolves a moving target at deploy time can change behaviour without anyone
 * editing it.
 */

import OpenAI from "https://esm.sh/openai@7.9.0";
import { logger } from "./logger.ts";
import { deleteStoredResponse } from "./openai-retention.ts";
import { drainSSEBlocks, normalizeSSENewlines, parseSSEFrame } from "./sse.ts";

/** How many times a severed stream is resumed before falling back to polling. */
const MAX_RESUME_ATTEMPTS = 3;

/** Ceiling on the wait for a background response to finish once resumes run out. */
const POLL_BUDGET_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export interface StreamTurnOptions {
  apiKey: string;
  model: string;
  instructions: string;
  input: Array<{ role: "user" | "assistant"; content: string }>;
  structuredOutput: { name: string; strict: boolean; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  /** OpenAI processing tier. Omit for the account default. */
  serviceTier?: "auto" | "default" | "flex" | "priority";
  /**
   * Whether OpenAI may keep the stored response after the turn settles.
   *
   * Background mode requires `store: true` — that is not negotiable, it is
   * what makes the response survive a severed connection (#1039). What IS
   * negotiable is what happens afterwards: when this is false (the default,
   * matching the institution-level retention policy in openai-retention.ts),
   * the stored copy is deleted from OpenAI once the turn is over.
   */
  retainStored?: boolean;
  /** Called with each new slice of the target field as it arrives. */
  onTextDelta: (delta: string) => void;
  /**
   * Fires once, the moment the target field's closing quote arrives.
   *
   * The reply the pupil reads is one field of a much larger structured object,
   * and everything after that field — the state tail — is generated with
   * nothing visible to show for it. This is the earliest moment the caller can
   * truthfully say "the text is complete", and it needs to say it: waiting for
   * the terminal event makes a finished reply look like a stalled one.
   *
   * Best-effort by nature: a response recovered from the terminal payload or
   * from polling may complete without the extractor ever seeing the closing
   * quote, so a caller must treat "never fired" as possible, not as an error.
   */
  onTextDone?: () => void;
  /**
   * Fires as soon as the response id is known, before the reply is complete.
   *
   * The caller needs it early to be able to *cancel* the generation: a
   * background response outlives its connection by design (#1039), so dropping
   * the stream locally leaves it running and billable. Concurrent input
   * moderation is the case that needs this — a flag arriving mid-generation
   * should stop the work, not just stop watching it.
   */
  onResponseId?: (responseId: string) => void;
  /**
   * Abandons the stream when aborted. The generation is *not* stopped by this
   * — see `onResponseId` — this only stops us reading, resuming and polling.
   */
  signal?: AbortSignal;
}

export interface StreamTurnResult {
  /** The complete structured output, parsed. */
  parsed: Record<string, unknown> | null;
  /** Raw JSON, for diagnosis when parsing fails. */
  rawJson: string;
  /** Token usage, for `trackAIUsage`. */
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
  responseId: string | null;
  /** How many times the upstream stream had to be resumed. */
  resumes: number;
  /** True when resumes ran out and the result came from polling instead. */
  fellBackToPolling: boolean;
}

/** The events that mean the response is finished, one way or another. */
const TERMINAL = new Set(["response.completed", "response.failed", "response.incomplete"]);

function textFrom(response: unknown): string {
  // deno-lint-ignore no-explicit-any
  const output = (response as any)?.output;
  if (!Array.isArray(output)) return "";
  for (const item of output) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

/**
 * Reconnect to a background response and replay from `startingAfter`.
 *
 * Deliberately not the SDK's `responses.stream()`. That helper is stateful: it
 * builds a snapshot and rejects a stream that does not begin with
 * `response.created` — "When snapshot hasn't been set yet, expected
 * 'response.created' event". A resumed stream by definition starts mid-response,
 * so the helper cannot consume one. The raw SSE is parsed instead, with
 * `sse.ts`, which already handles the CRLF framing and `event:` lines that
 * #1039 turned up.
 */
async function resumeFromCursor(
  apiKey: string,
  responseId: string,
  startingAfter: number | null,
  // deno-lint-ignore no-explicit-any
  handleEvent: (event: any) => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = new URL(`https://api.openai.com/v1/responses/${responseId}`);
  url.searchParams.set("stream", "true");
  if (startingAfter !== null) {
    url.searchParams.set("starting_after", String(startingAfter));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
    ...(signal ? { signal } : {}),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Resume failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) return false;
    const { done, value } = await reader.read();
    if (done) break;

    // Normalise the whole buffer, never the chunk: a read can split `\r\n\r\n`
    // anywhere, and normalising the halves separately loses the boundary.
    buffer = normalizeSSENewlines(buffer + decoder.decode(value, { stream: true }));
    const { blocks, rest } = drainSSEBlocks(buffer);
    buffer = rest;

    for (const block of blocks) {
      const frame = parseSSEFrame(block);
      if (!frame?.data) continue;
      if (handleEvent(frame.data)) return true;
    }
  }

  // A final frame need not be followed by a blank line.
  const last = parseSSEFrame(buffer);
  if (last?.data && handleEvent(last.data)) return true;

  return false;
}

/**
 * Run one streaming turn and return the completed structured output.
 *
 * `onTextDelta` fires as text arrives; the return value is only settled once a
 * terminal event lands (or polling resolves it), so a caller can stream to a
 * client and still persist a complete, parsed result afterwards.
 */
export async function streamStructuredTurn(
  options: StreamTurnOptions,
  extractor: {
    feed: (chunk: string) => string;
    getFullJson: () => string;
    isFieldComplete?: () => boolean;
  },
): Promise<StreamTurnResult> {
  const client = new OpenAI({
    apiKey: options.apiKey,
    // The SDK retries by default. Retries here would be invisible to
    // `trackAIUsage`, which records one row per attempt — so they stay ours.
    maxRetries: 0,
  });

  const created = await client.responses.create({
    model: options.model,
    instructions: options.instructions,
    input: options.input,
    text: { format: { type: "json_schema", ...options.structuredOutput } },
    ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
    background: true,
    stream: true,
    store: true,
    // deno-lint-ignore no-explicit-any
  } as any, options.signal ? { signal: options.signal } : undefined);

  let responseId: string | null = null;
  let cursor: number | null = null;
  let terminal: unknown = null;
  let resumes = 0;
  let textDoneFired = false;

  /**
   * One event, from either transport. Returns true when it is terminal.
   *
   * Shared because the resume path parses raw SSE rather than going through
   * the SDK, and the two must agree on the cursor or a resume would ask to
   * continue from the wrong place.
   */
  // deno-lint-ignore no-explicit-any
  const handleEvent = (e: any): boolean => {
    if (typeof e?.sequence_number === "number") cursor = e.sequence_number;
    if (e?.response?.id && !responseId) {
      responseId = e.response.id;
      options.onResponseId?.(responseId as string);
    }

    if (e?.type === "response.output_text.delta" && typeof e.delta === "string") {
      const text = extractor.feed(e.delta);
      if (text) options.onTextDelta(text);
      // After the delta that carried it, so a chunk ending exactly on the
      // closing quote delivers its last characters before the completion fires.
      if (!textDoneFired && extractor.isFieldComplete?.()) {
        textDoneFired = true;
        options.onTextDone?.();
      }
      return false;
    }
    if (TERMINAL.has(e?.type)) {
      terminal = e.response ?? null;
      return true;
    }
    return false;
  };

  /** Drain the SDK's stream. Returns true if it ended terminally. */
  const drain = async (stream: AsyncIterable<unknown>): Promise<boolean> => {
    for await (const event of stream) {
      if (options.signal?.aborted) return false;
      if (handleEvent(event)) return true;
    }
    return false;
  };

  let done = false;
  let fellBackToPolling = false;

  try {
    // The params are cast to `any` above, so TS resolves the non-streaming
    // overload and thinks this is a Response. It is an async iterable of events.
    done = await drain(created as unknown as AsyncIterable<unknown>);

    // A stream that ends without a terminal event is the #1039 signature: a clean
    // EOF mid-response. The generation is still running server-side because it is
    // a background response, so pick it up from the last sequence number.
    while (!done && !options.signal?.aborted && responseId && resumes < MAX_RESUME_ATTEMPTS) {
      resumes++;
      logger.warn("Upstream stream ended without a terminal event; resuming", {
        responseId,
        startingAfter: cursor,
        attempt: resumes,
      });
      try {
        done = await resumeFromCursor(
          options.apiKey,
          responseId,
          cursor,
          handleEvent,
          options.signal,
        );
      } catch (error) {
        logger.warn("Resume attempt failed", { error: (error as Error).message, responseId });
        break;
      }
    }

    // Resumes exhausted. The response is still alive server-side, so wait it out
    // rather than losing a generation that has already been paid for. Text
    // already streamed to the client stands; what polling recovers is the
    // complete object needed to persist the turn.
    if (!done && !options.signal?.aborted && responseId) {
      fellBackToPolling = true;
      const deadline = Date.now() + POLL_BUDGET_MS;
      while (Date.now() < deadline && !options.signal?.aborted) {
        const polled = await client.responses.retrieve(responseId);
        // deno-lint-ignore no-explicit-any
        const status = (polled as any)?.status;
        if (status === "completed" || status === "failed" || status === "incomplete") {
          terminal = polled;
          done = true;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  } finally {
    // The stored copy has served its purpose — resume and polling are over,
    // however they ended. Without institutional opt-in it is deleted, in a
    // `finally` so a drain or poll error cannot leave a failed turn's
    // transcript retained. Best-effort: on the abort path the response may
    // still be cancelling and the delete can lose that race, which costs
    // retention, not correctness.
    if (!options.retainStored && responseId) {
      deleteStoredResponse(options.apiKey, responseId);
    }
  }

  // Prefer the terminal payload's text: the extractor only ever saw the deltas
  // that actually reached us, and a resumed or polled response is the complete
  // record.
  const terminalText = terminal ? textFrom(terminal) : "";
  const rawJson = terminalText || extractor.getFullJson();

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = rawJson ? JSON.parse(rawJson) : null;
  } catch (error) {
    logger.error("Streamed structured output did not parse", {
      error: (error as Error).message,
      responseId,
      length: rawJson.length,
    });
  }

  return {
    parsed,
    rawJson,
    // deno-lint-ignore no-explicit-any
    usage: (terminal as any)?.usage ?? null,
    responseId,
    resumes,
    fellBackToPolling,
  };
}
