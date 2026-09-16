import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
  openaiRoute,
  parseResponse,
} from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../chat-stream/handler.ts";
import { createModerationResponse } from "../test-utils.ts";

/**
 * The streaming surface trades #1198's withhold-before-display for live text.
 * These pin what it must still do — the gates that are shared with `chat`, and
 * the after-the-fact record that is all a flag can produce here.
 */

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH = { authorization: "Bearer test-token" };

const BODY = { kind: "open_question", subjectId: "q1", courseId: "c1" };

const SESSION = {
  id: "sess-1",
  user_id: "user-1",
  course_id: "c1",
  offering_id: "off-1",
  study_session_id: null,
  open_question_id: "q1",
  status: "in_progress",
  subject_kind: "open_question",
};

/** What `verifyQuestionEnrollment` and the subject's authorize() read. */
const ENTITLED: MockRoute[] = [
  supabaseRoute("/rest/v1/offering_questions", [
    { offering_id: "off-1", offerings: { id: "off-1", class_id: "class-1" } },
  ]),
  supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
  supabaseRoute("/rest/v1/offerings", { id: "off-1", course_id: "c1" }),
];

/** A transcript ending on a student turn, so the turn is not an opening one. */
const TRANSCRIPT = [
  { role: "user", content: "why is the sky blue?" },
];

function baseRoutes(extra: MockRoute[] = []): MockRoute[] {
  return [
    supabaseRoute("/auth/v1/user", { id: "user-1", email: "s@t.local" }),
    ...ENTITLED,
    supabaseRoute("/rest/v1/chat_sessions", SESSION),
    supabaseRoute("/rest/v1/chat_messages", {}, { method: "POST" }),
    supabaseRoute("/rest/v1/chat_messages", TRANSCRIPT),
    supabaseRoute("/rest/v1/chat_session_state", null),
    supabaseRoute("/rest/v1/courses", { id: "c1", language: "en" }),
    supabaseRoute("/rest/v1/questions", {
      question: "Q?",
      answer_key: { model_answer: "A", rubric: null, explanation: "E" },
      explanation: "E",
    }),
    supabaseRoute("/rest/v1/question_competencies", []),
    supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
    ...extra,
  ];
}

/**
 * Usage tracking is fire-and-forget by design — a usage row must never be the
 * reason a turn fails — so it can land after the stream closes. Poll for it
 * rather than asserting on the next tick.
 */
async function waitForFetch(
  fetchLog: { url: string; method: string }[],
  predicate: (entry: { url: string; method: string }) => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fetchLog.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ── The gates shared with `chat` ───────────────────────────────────────

Deno.test("chat-stream: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const res = await handler(new Request("http://localhost/chat-stream", { method: "OPTIONS" }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("chat-stream: rejects an unknown subject before doing anything", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { kind: "not_a_surface", subjectId: "x" });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Unknown chat subject");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "chat-stream: 401 without a bearer token, and spends nothing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, BODY);
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("api.openai.com")),
        false,
        "an unauthenticated caller must not reach OpenAI",
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: a completed question is refused, and the turn is left alone",
  ...OPTS,
  async fn() {
    /*
      The student's turn is already written when this refuses it, and it stays.

      An earlier draft withdrew it and could not stop narrowing: the browser
      could not delete it (only staff hold a DELETE policy), so it moved
      server-side; then `replyTo` was caller-supplied, so it was bounded to the
      newest row, then to the newest *recent* row. None was sufficient, because
      "this row belongs to this request" cannot be established from inside the
      request that refuses it. So nothing is deleted — the same as a refused
      turn on a paused session — and this pins that no privileged delete creeps
      back in.
    */
    const deletes: string[] = [];
    const trackDelete: MockRoute = {
      match: (url: string, init?: RequestInit) =>
        url.includes("/rest/v1/chat_messages") &&
        (init?.method ?? "GET").toUpperCase() === "DELETE",
      respond: (url: string) => {
        deletes.push(url);
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    };

    const h = createTestHarness({
      routes: [
        trackDelete,
        supabaseRoute("/auth/v1/user", { id: "user-1", email: "s@t.local" }),
        ...ENTITLED,
        supabaseRoute("/rest/v1/chat_sessions", { ...SESSION, status: "completed" }),
        supabaseRoute("/rest/v1/chat_messages", [
          { id: "msg-u1", role: "user", created_at: new Date().toISOString() },
        ]),
        supabaseRoute("/rest/v1/courses", { id: "c1", language: "en" }),
      ],
    });
    try {
      const res = await h.invoke(handler, { ...BODY, replyTo: "msg-u1" }, { headers: AUTH });
      const { status, body } = await parseResponse(res);

      assertEquals(status, 403);
      assertEquals(body.error, "session_completed");
      assertEquals(deletes.length, 0, "a refusal must not delete a student's turn");
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: a paused session is refused before the model",
  ...OPTS,
  async fn() {
    const paused = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "user-1", email: "s@t.local" }),
        ...ENTITLED,
        supabaseRoute("/rest/v1/chat_sessions", { ...SESSION, status: "paused" }),
        supabaseRoute("/rest/v1/courses", { id: "c1", language: "en" }),
      ],
    });
    try {
      const res = await paused.invoke(handler, BODY, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "session_paused");
      assertEquals(
        paused.fetchLog.some((e) => e.url.includes("api.openai.com")),
        false,
      );
    } finally {
      paused.cleanup();
    }
  },
});

// ── Input moderation, now concurrent with the generation ───────────────
//
// The gate did not move, but its timing did. Moderation used to run before the
// model call and short-circuit it; it now runs alongside, so the pupil waits
// for the slower of the two rather than their sum. What that buys in latency it
// pays for in a generation thrown away, and what it must NOT cost is the gate:
// the reply still never reaches the pupil, the turn is still not recorded, the
// session is still paused and the school is still told.

Deno.test({
  name: "chat-stream: a flagged message reaches the model but never the pupil",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes([
        openaiRoute("/v1/moderations", createModerationResponse(true, { harassment: true })),
        streamRoute,
        supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
        supabaseRoute("/rest/v1/chat_messages", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });

      // A stream, not a JSON refusal: it opened before a verdict existed.
      assertEquals(res.headers.get("Content-Type"), "text/event-stream");
      const body = await drain(res);

      // Whether the generation actually started is a race, and deliberately not
      // asserted: concurrency means the verdict may land first, in which case
      // the abort pre-empts the request and the turn costs nothing. That is the
      // good outcome, not a broken test. What is invariant is everything below.

      // Not one word of the reply was shown. Deltas are held until the verdict,
      // and a flagged verdict discards them rather than flushing them.
      assertEquals(
        body.includes('"delta"'),
        false,
        "a flagged message must not have the reply streamed back to the pupil",
      );
      assertEquals(
        body.includes("Light scatters"),
        false,
        "no part of the reply may reach the pupil",
      );
      // Nor the announcement that it finished: `text_done` tells the client to
      // settle a bubble, and on this branch there is no bubble to settle.
      assertEquals(body.includes("text_done"), false);
      assertStringIncludes(body, "[DONE]");

      // Not persisted: this turn should not have happened, and an instructor
      // opening the session must not find the tutor's answer standing in it.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("rpc/persist_chat_turn")),
        false,
        "a flagged turn must not be recorded",
      );

      // The pause is the single carrier the panel reads — no in-band frame.
      assertEquals(
        body.includes("moderation_flag"),
        false,
        "moderation state has one source: the pause on chat_sessions",
      );
      // The consequences run after the stream closes, so they are waited for
      // rather than assumed — `drain` returning does not mean they have landed.
      const isNotification = (e: { url: string; method: string }) =>
        e.url.includes("/rest/v1/admin_notifications") && e.method === "POST";
      await waitForFetch(h.fetchLog, isNotification);

      const pauses = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/chat_sessions") && e.method === "PATCH",
      );
      assertEquals(pauses.length >= 1, true, "the session must be paused");
      assertEquals(h.fetchLog.filter(isNotification).length, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: a hung moderation call cannot hang the turn",
  ...OPTS,
  async fn() {
    // Moderation that never answers. The runner awaits the verdict before it
    // persists the turn and before `[DONE]`, so without a bound on the call
    // itself the pupil would be left reading an unsaved reply while the panel
    // typed on until its own 90-second stall timeout.
    //
    // The mock honours the abort signal, which is the whole point: a mock that
    // simply never settled would hang regardless of whether the timeout works,
    // and would prove nothing. This waits out the real
    // `INPUT_MODERATION_TIMEOUT_MS`, so it is the slowest test in the file by
    // design — it is buying the guarantee that the bound is actually wired.
    const hangingModeration: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
      respond: (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Signal timed out.", "TimeoutError")));
        }),
    };

    const h = createTestHarness({
      routes: baseRoutes([
        hangingModeration,
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      // The turn completes. Fails open, as the output gate does: an unscreened
      // message is the accepted cost of a moderation outage, and is logged as
      // exactly that — a tutor that stops answering is not.
      assertStringIncludes(body, "[DONE]");
      assertStringIncludes(body, '"type":"metadata"');

      // The deferred-send path: the text here finishes while the gate is still
      // closed, where `text_done` may only be *noted*, and the gate opening —
      // here, the moderation timeout failing open — is what flushes the deltas
      // and announces it. A completion noted behind a closed gate must not be
      // lost when the gate opens.
      assertStringIncludes(body, '"type":"text_done"');

      const persist = h.fetchLog.filter(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      assertEquals(persist.length, 1, "the turn must still be recorded");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: a flagged message still pauses when the generation fails",
  ...OPTS,
  async fn() {
    // No `/v1/responses` route: the stream 404s. The verdict must still be
    // honoured — a model outage must not be able to disarm the gate.
    const h = createTestHarness({
      routes: baseRoutes([
        openaiRoute("/v1/moderations", createModerationResponse(true, { harassment: true })),
        supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
        supabaseRoute("/rest/v1/chat_messages", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      // Reported as a flagged turn, not as a broken tutor.
      assertEquals(
        body.includes("could not reply"),
        false,
        "the flag outranks the failure and must not be reported as a tutor error",
      );

      const isNotification = (e: { url: string; method: string }) =>
        e.url.includes("/rest/v1/admin_notifications") && e.method === "POST";
      await waitForFetch(h.fetchLog, isNotification);

      const pauses = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/chat_sessions") && e.method === "PATCH",
      );
      assertEquals(pauses.length >= 1, true, "the session must be paused");
      assertEquals(h.fetchLog.filter(isNotification).length, 1);
    } finally {
      h.cleanup();
    }
  },
});

// ── A real streamed turn ───────────────────────────────────────────────

const REPLY = "Light scatters in the atmosphere. What colour scatters most?";

/**
 * The structured output the subject expects, as one JSON string.
 *
 * The unified state contract (v2), which the streaming surface runs. The
 * buffered endpoint still speaks each surface's legacy shape, so a fixture in
 * the old form here would pass against `state_update ?? {}` while testing
 * nothing about the merge.
 */
const FULL_JSON = JSON.stringify({
  assistant_text: REPLY,
  decision: "ASK",
  confidence: 0.8,
  state_update: {
    subject: "physics",
    current_topic: "scattering",
    goal: "explain why the sky is blue",
    progress_level: "developing",
    known: ["light has a spectrum"],
    gaps: ["wavelength dependence"],
    misconceptions: [],
    difficulty: "same",
    frustration: 0.1,
    hint_level: 1,
    judgement: "PARTIAL",
    answer_allowed: false,
  },
  reason: "partial",
});

/**
 * An upstream SSE body: the JSON delivered as `output_text.delta` events in
 * small slices, then a terminal `response.completed` carrying the whole thing.
 *
 * Slicing matters — it is what exercises `StreamingJsonTextExtractor`, which
 * has to find `assistant_text` across chunk boundaries.
 */
function upstreamStream(json: string, sliceSize = 17): string {
  let seq = 0;
  const frames: string[] = [];
  frames.push(
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      sequence_number: seq++,
      response: { id: "resp_stream_1" },
    })}\n\n`,
  );
  for (let i = 0; i < json.length; i += sliceSize) {
    frames.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: seq++,
        delta: json.slice(i, i + sliceSize),
      })}\n\n`,
    );
  }
  frames.push(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: seq++,
      response: {
        id: "resp_stream_1",
        status: "completed",
        model: "gpt-5.6-terra",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        output: [{ type: "message", content: [{ type: "output_text", text: json }] }],
      },
    })}\n\n`,
  );
  return frames.join("");
}

const streamRoute: MockRoute = {
  match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/responses"),
  respond: () =>
    new Response(upstreamStream(FULL_JSON), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
};

Deno.test({
  name: "chat-stream: streams the reply and records the turn in one transaction",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes([
        // Input clean, then output clean.
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals(res.headers.get("Content-Type"), "text/event-stream");

      const body = await drain(res);

      // The reply reached the client as deltas in the shape parseSSEStream
      // already understands, so the frontend contract is unchanged.
      assertStringIncludes(body, '"delta"');
      const text = [...body.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => JSON.parse(`"${m[1]}"`))
        .join("");
      assertStringIncludes(text, "Light scatters");
      assertStringIncludes(body, '"type":"metadata"');
      assertStringIncludes(body, "[DONE]");

      // One transactional write, not three loose ones.
      const persist = h.fetchLog.filter(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      assertEquals(persist.length, 1, "the turn must be recorded exactly once");
      const args = JSON.parse(persist[0].body ?? "{}");
      assertEquals(args._session_id, "sess-1");
      assertStringIncludes(args._content, "Light scatters");

      // This path bypasses openai-client.ts, which is what normally records
      // usage — so without an explicit call every turn here would cost money
      // against nobody.
      const isUsageWrite = (e: { url: string; method: string }) =>
        e.url.includes("/rest/v1/ai_usage_logs") && e.method === "POST";
      await waitForFetch(h.fetchLog, isUsageWrite);
      const usage = h.fetchLog.find(isUsageWrite);
      assertEquals(usage !== undefined, true, "expected a usage row for the streamed turn");
      const usageRow = JSON.parse(usage!.body ?? "{}");
      assertEquals(usageRow.user_id, "user-1", "usage must be attributed to the caller");
      assertEquals(usageRow.output_tokens, 20);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: text_done marks the end of the reply, before the paperwork",
  ...OPTS,
  async fn() {
    // The reply is one field of the structured object, and everything after it
    // — the state tail, the verdict await, the persist — happens with nothing
    // visible to show for it. `text_done` is what lets the client settle the
    // bubble at the moment the text actually ends instead of blinking a cursor
    // through all of that. It must land after the last delta (nothing follows
    // it that the pupil has not seen) and before the metadata that trails the
    // full object.
    const h = createTestHarness({
      routes: baseRoutes([
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      const textDoneAt = body.indexOf('"type":"text_done"');
      assertEquals(textDoneAt >= 0, true, "expected a text_done frame on a clean streamed turn");
      assertEquals(
        body.indexOf('"type":"text_done"', textDoneAt + 1),
        -1,
        "text_done must be sent exactly once",
      );

      // After every delta: a settled bubble must already hold the whole reply.
      assertEquals(
        body.lastIndexOf('"delta"') < textDoneAt,
        true,
        "text_done must follow the last content delta",
      );
      // Before the paperwork's own frames.
      assertEquals(
        textDoneAt < body.indexOf('"type":"metadata"'),
        true,
        "text_done must precede the metadata frame",
      );
      assertEquals(textDoneAt < body.indexOf("[DONE]"), true);
    } finally {
      h.cleanup();
    }
  },
});

// ── The weakened gate, and what it must still do ───────────────────────

Deno.test({
  name: "chat-stream: a reply flagged after delivery is recorded, pauses and notifies",
  ...OPTS,
  async fn() {
    let moderationCalls = 0;
    const moderation: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
      respond: () => {
        // First call screens the student's message, second the tutor's reply.
        moderationCalls++;
        const flagged = moderationCalls > 1;
        return new Response(
          JSON.stringify(createModerationResponse(flagged, flagged ? { violence: true } : undefined)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    };

    const h = createTestHarness({
      routes: baseRoutes([
        moderation,
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/flagged_content", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      // The pupil read the reply — that is the accepted trade of this surface.
      assertStringIncludes(body, "Light scatters");
      // The verdict does not travel on the stream: it is not known until after
      // `[DONE]`. The `moderation` row below is what reaches the pupil, over
      // Realtime.
      assertEquals(body.includes("moderation_flag"), false);

      // The assistant turn stays, per the product choice to leave the text.
      const persist = h.fetchLog.filter(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      assertEquals(persist.length, 1);

      // Screening now lands after the stream closes, so wait for it rather
      // than reading `fetchLog` on the next tick.
      await waitForFetch(
        h.fetchLog,
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );

      // The audit trail is the part that is NOT weakened.
      const moderationRow = h.fetchLog.find(
        (e) =>
          e.url.includes("/rest/v1/chat_messages") &&
          e.method === "POST" &&
          (e.body ?? "").includes("moderation"),
      );
      assertEquals(moderationRow !== undefined, true, "expected a role='moderation' record");

      const flagged = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/flagged_content") && e.method === "POST",
      );
      assertEquals(flagged !== undefined, true, "expected a flagged_content record");

      const pause = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/chat_sessions") && e.method === "PATCH",
      );
      assertEquals(pause !== undefined, true, "expected the session to be paused");

      const notifications = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      assertEquals(notifications.length, 1, "the school must be told exactly once");

      // The pause names its own cause. This is the *only* thing the pupil's
      // warning is derived from — correlating a separate moderation row against
      // the status is what produced five rounds of interleaving bugs — so a
      // pause written without its reason silently degrades the warning to the
      // generic "paused for review".
      assertStringIncludes(pause?.body ?? "", '"pause_reason":"assistant_moderation"');
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: [DONE] does not wait for the reply to be screened",
  ...OPTS,
  async fn() {
    // The point of the change: the client finalises the turn on `[DONE]`, so
    // screening in front of it stalled a reply that was already complete and
    // already read. The gate here holds the reply's screening open for as long
    // as the test likes — if `[DONE]` were still behind it, `drain` would hang.
    let releaseScreening: () => void = () => {};
    const screeningGate = new Promise<void>((resolve) => {
      releaseScreening = resolve;
    });

    let moderationCalls = 0;
    const moderation: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
      respond: async () => {
        moderationCalls++;
        // The student's message is screened inline and must not be gated —
        // that check still blocks, and gating it would deadlock the turn.
        const isReplyScreening = moderationCalls > 1;
        if (isReplyScreening) await screeningGate;
        return new Response(
          JSON.stringify(
            createModerationResponse(
              isReplyScreening,
              isReplyScreening ? { violence: true } : undefined,
            ),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    };

    const h = createTestHarness({
      routes: baseRoutes([
        moderation,
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/flagged_content", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      // Delivered and terminated while screening is still outstanding.
      assertStringIncludes(body, "Light scatters");
      assertStringIncludes(body, "[DONE]");

      // The turn is persisted before the stream ends — that is what makes it
      // safe to end it, since the reply survives a reload.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST"),
        true,
        "the turn must be persisted before [DONE]",
      );

      // ...and no verdict yet, because the screening call has not returned.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/flagged_content")),
        false,
        "screening must still be outstanding once the stream has closed",
      );

      // Released, the flag lands with nothing waiting on it.
      releaseScreening();
      await waitForFetch(
        h.fetchLog,
        (e) => e.url.includes("/rest/v1/flagged_content") && e.method === "POST",
      );
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/flagged_content") && e.method === "POST"),
        true,
        "the audit record must still be written after the stream closes",
      );
    } finally {
      h.cleanup();
    }
  },
});

// ── Recovery from the #1039 failure ────────────────────────────────────

/**
 * The #1039 signature: the body ends cleanly, mid-response, with no terminal
 * event. This is the whole reason the response is created with
 * `background: true` — the generation survives its connection, so the stream
 * can be picked up from the last sequence number instead of the turn dying.
 */
function severedStream(json: string, upTo: number): string {
  let seq = 0;
  const frames: string[] = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      sequence_number: seq++,
      response: { id: "resp_stream_1" },
    })}\n\n`,
  ];
  for (let i = 0; i < upTo; i += 17) {
    frames.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: seq++,
        delta: json.slice(i, Math.min(i + 17, upTo)),
      })}\n\n`,
    );
  }
  // No terminal event: the body simply ends.
  return frames.join("");
}

/** The remainder, delivered on the resumed connection, then completing. */
function resumedStream(json: string, from: number): string {
  let seq = 100;
  const frames: string[] = [];
  for (let i = from; i < json.length; i += 17) {
    frames.push(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        sequence_number: seq++,
        delta: json.slice(i, i + 17),
      })}\n\n`,
    );
  }
  frames.push(
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: seq++,
      response: {
        id: "resp_stream_1",
        status: "completed",
        model: "gpt-5.6-terra",
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        output: [{ type: "message", content: [{ type: "output_text", text: json }] }],
      },
    })}\n\n`,
  );
  return frames.join("");
}

Deno.test({
  name: "chat-stream: a severed upstream stream is resumed, not lost",
  ...OPTS,
  async fn() {
    const CUT_AT = 40;
    const upstreamCalls: string[] = [];

    const severing: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/responses"),
      respond: (url: string) => {
        upstreamCalls.push(url);
        // The first call is the create; anything after is a resume.
        const body = upstreamCalls.length === 1
          ? severedStream(FULL_JSON, CUT_AT)
          : resumedStream(FULL_JSON, CUT_AT);
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    };

    const h = createTestHarness({
      routes: baseRoutes([
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        severing,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      // It reconnected rather than giving up.
      assertEquals(
        upstreamCalls.length >= 2,
        true,
        "a stream ending without a terminal event must be resumed",
      );

      // And the resume asked to continue from where it stopped, rather than
      // replaying the whole response and duplicating text.
      assertStringIncludes(upstreamCalls[1], "starting_after");

      // The turn completed and was recorded, despite the severing.
      const persist = h.fetchLog.filter(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      assertEquals(persist.length, 1, "the recovered turn must still be recorded once");
      assertStringIncludes(JSON.parse(persist[0].body ?? "{}")._content, "Light scatters");
      assertStringIncludes(body, "[DONE]");
    } finally {
      h.cleanup();
    }
  },
});

// ── Failure paths that must not read as success ────────────────────────

Deno.test({
  name: "chat-stream: a turn that could not be recorded says so rather than implying success",
  ...OPTS,
  async fn() {
    // The buffered path can refuse outright here. This one cannot — the text
    // has already gone — so it must at least tell the pupil the reply was not
    // kept, instead of sending [DONE] over a turn that vanishes on reload.
    const failingPersist: MockRoute = {
      match: (url: string, init?: RequestInit) =>
        url.includes("rpc/persist_chat_turn") &&
        (init?.method ?? "GET").toUpperCase() === "POST",
      respond: () =>
        new Response(JSON.stringify({ message: "deadlock detected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    };

    const h = createTestHarness({
      routes: baseRoutes([
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        streamRoute,
        failingPersist,
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      assertStringIncludes(body, '"code":"turn_not_recorded"');

      // Sent as a NOTICE, not an error. `{type:"error"}` makes the client
      // reject and cancel the reader, so the moderation verdict that follows a
      // delivered reply would never reach the pupil.
      assertStringIncludes(body, '"type":"notice"');
      assertEquals(
        body.includes('"type":"error"'),
        false,
        "an unrecorded turn is not fatal to the stream",
      );

      // The stream still terminates cleanly — an unrecorded turn must not also
      // hang the client.
      assertStringIncludes(body, "[DONE]");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: a lost withheld-reply record is retried, then escalated",
  ...OPTS,
  async fn() {
    // That row is the pupil's only warning once the stream has closed, so a
    // transport blip must not decide whether a child is told. It is retried;
    // and if it is still lost, the school is told plainly that the pupil has
    // not been told, because nobody can infer that from the pause alone.
    let moderationCalls = 0;
    const moderation: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
      respond: () => {
        moderationCalls++;
        const flagged = moderationCalls > 1;
        return new Response(
          JSON.stringify(createModerationResponse(flagged, flagged ? { violence: true } : undefined)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    };

    // Every write of the moderation row fails, both tries.
    let moderationRowWrites = 0;
    const failingModerationRow: MockRoute = {
      match: (url: string, init?: RequestInit) =>
        url.includes("/rest/v1/chat_messages") &&
        (init?.method ?? "GET").toUpperCase() === "POST" &&
        (init?.body as string ?? "").includes("moderation"),
      respond: () => {
        moderationRowWrites++;
        return new Response(JSON.stringify({ message: "connection reset" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    };

    const h = createTestHarness({
      // Ahead of `baseRoutes`, whose generic `chat_messages` POST would
      // otherwise match first and quietly succeed — first match wins.
      routes: [
        failingModerationRow,
        ...baseRoutes([
          moderation,
          streamRoute,
          supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
          supabaseRoute("/rest/v1/flagged_content", {}, { method: "POST" }),
          supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
          supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
        ]),
      ],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      await drain(res);

      await waitForFetch(
        h.fetchLog,
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );

      assertEquals(moderationRowWrites, 2, "the record must be retried before being given up on");

      const notification = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      assertEquals(notification !== undefined, true, "expected the school to be notified");
      // The part a human has to act on: the pupil is looking at flagged text
      // with no explanation, and only a person can give them one now.
      assertStringIncludes(notification?.body ?? "", "has NOT been");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: a failure while recording a flag still pauses and notifies",
  ...OPTS,
  async fn() {
    // The stream is closed before screening starts, so a failure here can no
    // longer strand the client. What it can still do is skip the consequences,
    // which is what the independent `attempt()` calls exist to prevent.
    let moderationCalls = 0;
    const moderation: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
      respond: () => {
        moderationCalls++;
        const flagged = moderationCalls > 1;
        return new Response(
          JSON.stringify(createModerationResponse(flagged, flagged ? { violence: true } : undefined)),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    };

    const failingRecord: MockRoute = {
      match: (url: string, init?: RequestInit) =>
        url.includes("/rest/v1/flagged_content") &&
        (init?.method ?? "GET").toUpperCase() === "POST",
      respond: () => {
        throw new Error("connection reset");
      },
    };

    const h = createTestHarness({
      routes: baseRoutes([
        moderation,
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
        failingRecord,
        supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      const body = await drain(res);

      // The stream terminated rather than stranding the client.
      assertStringIncludes(body, "[DONE]");
      // And the reply itself still reached the pupil.
      assertStringIncludes(body, "Light scatters");

      // The consequences are attempted independently, so one failed write does
      // not also silently skip the pause and the notification. Both land after
      // the stream closes.
      await waitForFetch(
        h.fetchLog,
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      const pause = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/chat_sessions") && e.method === "PATCH",
      );
      assertEquals(pause !== undefined, true, "a failed record must not skip the pause");
      const notified = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      assertEquals(notified !== undefined, true, "a failed record must not skip the school");
    } finally {
      h.cleanup();
    }
  },
});

// ── Which turn is being answered ───────────────────────────────────────

/**
 * A transcript with two student turns and no reply yet — the shape that made
 * inference wrong. "The latest user row" resolves both in-flight requests to
 * the second message, so the first is never answered.
 */
const TWO_PENDING_TURNS = [
  { id: "msg-u1", role: "user", content: "question one" },
  { id: "msg-u2", role: "user", content: "question two" },
];

function routesWithTranscript(transcript: unknown[], extra: MockRoute[] = []): MockRoute[] {
  return [
    supabaseRoute("/auth/v1/user", { id: "user-1", email: "s@t.local" }),
    ...ENTITLED,
    supabaseRoute("/rest/v1/chat_sessions", SESSION),
    supabaseRoute("/rest/v1/chat_messages", {}, { method: "POST" }),
    supabaseRoute("/rest/v1/chat_messages", transcript),
    supabaseRoute("/rest/v1/chat_session_state", null),
    supabaseRoute("/rest/v1/courses", { id: "c1", language: "en" }),
    supabaseRoute("/rest/v1/questions", {
      question: "Q?",
      answer_key: { model_answer: "A", rubric: null, explanation: "E" },
      explanation: "E",
    }),
    supabaseRoute("/rest/v1/question_competencies", []),
    supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
    ...extra,
  ];
}

Deno.test({
  name: "chat-stream: answers the turn the request names, not merely the latest",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: routesWithTranscript(TWO_PENDING_TURNS, [
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, { ...BODY, replyTo: "msg-u1" }, { headers: AUTH });
      await drain(res);

      const persist = h.fetchLog.find(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      const args = JSON.parse(persist!.body ?? "{}");

      // Bound to the turn it was asked about. Inference would have said msg-u2
      // here, and msg-u1 would never have been answered by anyone.
      assertEquals(args._in_reply_to, "msg-u1");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: falls back to the latest turn when the request names none",
  ...OPTS,
  async fn() {
    // The compatibility shims and any older client omit `replyTo`, and must
    // keep working.
    const h = createTestHarness({
      routes: routesWithTranscript(TWO_PENDING_TURNS, [
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        streamRoute,
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
      ]),
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      await drain(res);

      const persist = h.fetchLog.find(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      assertEquals(JSON.parse(persist!.body ?? "{}")._in_reply_to, "msg-u2");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat-stream: refuses a turn id that is not in this conversation",
  ...OPTS,
  async fn() {
    // `replyTo` is a body value and the uniqueness rule is global, so naming
    // another session's message would block that session's reply. It is
    // checked against this transcript rather than trusted.
    const h = createTestHarness({
      routes: routesWithTranscript(TWO_PENDING_TURNS, [
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        streamRoute,
      ]),
    });
    try {
      const res = await h.invoke(
        handler,
        { ...BODY, replyTo: "msg-belonging-to-someone-else" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);

      assertEquals(status, 400);
      assertStringIncludes(body.error, "not part of this conversation");
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/v1/responses")),
        false,
        "a request naming a foreign turn must not reach the model",
      );
    } finally {
      h.cleanup();
    }
  },
});
