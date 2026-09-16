/**
 * The unified `chat` endpoint on the open-question surface.
 *
 * These assertions used to run against `socratic-chat`, which had become a
 * shim that translated the old body onto this one and delegated — so the
 * behaviour under test was always `runChatTurn`'s. The shim is gone (#1441)
 * and the tests address the endpoint the frontend actually calls.
 *
 * Two things moved layer when the shim went, rather than disappearing:
 *   - the over-long message check. The shim rejected `userMessage` before
 *     authentication because that was its contract; the unified core reads the
 *     student's turn from the transcript, so the same refusal is asserted on
 *     the turn it is answering.
 *   - request validation. `{questionId, courseId, userMessage}` is not a
 *     contract any more; `{kind, subjectId}` is.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../chat/handler.ts";
import { _clearQualityInstructionCache } from "../../../_shared/openai-client.ts";
import { createModerationResponse } from "../test-utils.ts";

/** Every request past validation needs a bearer token (#1136). */
const AUTH = { Authorization: "Bearer test-token" };

/** The opening turn on the open-question surface, as the client sends it. */
const START_TURN = { kind: "open_question", subjectId: "q1", courseId: "c1", start: true };
/** A reply turn: the student's message is already in the transcript. */
const REPLY_TURN = { kind: "open_question", subjectId: "q1", courseId: "c1" };

/**
 * What `verifyQuestionEnrollment` reads: a published `offering_questions` row
 * for the question, and a `class_enrollments` row for the caller in that
 * offering's class.
 */
const ENROLLED: MockRoute[] = [
  {
    match: (url: string) => url.includes("/rest/v1/offering_questions"),
    respond: () =>
      new Response(
        JSON.stringify([{ offering_id: "off-1", offerings: { id: "off-1", class_id: "class-1" } }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  },
  {
    match: (url: string) => url.includes("/rest/v1/class_enrollments"),
    respond: () =>
      new Response(JSON.stringify([{ class_id: "class-1" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
  // The offering the question was published through supplies the session's
  // course and offering, so the row is scoped rather than course-wide.
  {
    match: (url: string) => url.includes("/rest/v1/offerings"),
    respond: () =>
      new Response(JSON.stringify({ id: "off-1", course_id: "c1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  },
];

/**
 * The unified session row. `resolveSession` selects it first and only inserts
 * when the select comes back empty, so the GET route is what most tests need.
 */
function chatSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    user_id: "user-123",
    course_id: "c1",
    offering_id: null,
    study_session_id: null,
    open_question_id: "q1",
    status: "in_progress",
    subject_kind: "open_question",
    ...overrides,
  };
}

const OPTS = { sanitizeOps: false, sanitizeResources: false };

// ── Routing and validation ─────────────────────────────────────────────

Deno.test("chat: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/chat", { method: "OPTIONS" });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("chat: returns 400 for a body that is not JSON", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: "not json",
    });
    const res = await handler(req);
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Invalid JSON body");
  } finally {
    h.cleanup();
  }
});

Deno.test("chat: returns 400 when kind names no known subject", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { kind: "quiz", subjectId: "q1" }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Unknown chat subject");
  } finally {
    h.cleanup();
  }
});

Deno.test("chat: returns 400 when subjectId is missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, { kind: "open_question", courseId: "c1" }, {
      headers: AUTH,
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 400);
    assertEquals(body.error, "Missing or mismatched subject");
  } finally {
    h.cleanup();
  }
});

// ── Input too long ─────────────────────────────────────────────────────

Deno.test({
  name: "chat: returns 400 when the turn being answered exceeds 4096 chars",
  ...OPTS,
  async fn() {
    // The cap is on the student's message, which now lives in the transcript
    // rather than in the request body — so this is asserted on the row the
    // turn is answering.
    const longMessage = "a".repeat(4097);
    const h = createTestHarness({
      routes: [
        ...ENROLLED,
        supabaseRoute("/rest/v1/courses", { language: "en" }),
        supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
        supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
        supabaseRoute("/rest/v1/chat_sessions", chatSession()),
        supabaseRoute("/rest/v1/chat_messages", [
          { id: "m-1", role: "user", content: longMessage },
        ]),
      ],
    });
    try {
      const res = await h.invoke(handler, REPLY_TURN, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "message_too_long");
      assertEquals(body.maxLength, 4096);
      assertEquals(body.currentLength, 4097);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat: a turn at exactly 4096 chars is not refused for length",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...ENROLLED,
        supabaseRoute("/rest/v1/courses", { language: "en" }),
        supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
        supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
        supabaseRoute("/rest/v1/chat_sessions", chatSession()),
        supabaseRoute("/rest/v1/chat_messages", [
          { id: "m-1", role: "user", content: "a".repeat(4096) },
        ]),
        supabaseRoute("/rest/v1/questions", {
          question: "Q?",
          answer_key: { model_answer: "A", rubric: null, explanation: "E" },
          explanation: "E",
        }),
        supabaseRoute("/rest/v1/question_competencies", []),
      ],
    });
    try {
      const res = await h.invoke(handler, REPLY_TURN, { headers: AUTH });
      const { body } = await parseResponse(res);
      // It fails later on unmocked downstream calls; the point is that it is
      // not rejected for length.
      assertEquals(body.error !== "message_too_long", true);
    } finally {
      h.cleanup();
    }
  },
});

// ── Paused session blocked ─────────────────────────────────────────────

Deno.test({
  name: "chat: returns 403 when session is paused",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...ENROLLED,
        supabaseRoute("/rest/v1/courses", { language: "en" }),
        supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
        supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
        supabaseRoute("/rest/v1/chat_sessions", chatSession({ status: "paused" })),
      ],
    });
    try {
      const res = await h.invoke(handler, REPLY_TURN, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "session_paused");
      assertEquals(body.paused, true);
    } finally {
      h.cleanup();
    }
  },
});

// ── Assistant-turn persistence ─────────────────────────────────────────

Deno.test({
  name: "chat: records the assistant turn through persist_chat_turn",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    // Minimal valid socratic response, returned the way background mode
    // delivers it: a completed Responses payload rather than an SSE body.
    const fullJson = JSON.stringify({
      assistant_text: "Hello student!",
      judgement: "CORRECT",
      stop: false,
      confidence: 0.9,
      reason: "test",
      missing: [],
      misconceptions: [],
    });
    // status "completed" on the POST short-circuits polling, so the test does
    // not sit through the 2s poll interval. The result extraction being
    // exercised — output[] -> message -> output_text -> JSON.parse — is the
    // same either way.
    const backgroundResponse = {
      id: "resp_test_1",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: fullJson }],
        },
      ],
    };

    const h = createTestHarness({
      routes: [
        ...ENROLLED,
        supabaseRoute("/rest/v1/courses", { language: "en" }),
        supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
        supabaseRoute("/rest/v1/chat_sessions", chatSession()),
        supabaseRoute("/rest/v1/chat_messages", [], { method: "POST" }),
        supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
        supabaseRoute("/rest/v1/chat_messages", []),
        // POST (upsert) must come before the catch-all GET for the same table
        supabaseRoute("/rest/v1/chat_session_state", { id: "state-1" }, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_session_state", null),
        supabaseRoute("/rest/v1/questions", {
          question: "Q?",
          answer_key: { model_answer: "A", rubric: null, explanation: "E" },
          explanation: "E",
        }),
        supabaseRoute("/rest/v1/question_competencies", []),
        // Output moderation (#1198) runs on the completed reply, so it must
        // be routed before the catch-all or it would be handed the Responses
        // payload and report itself unscreened.
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        {
          match: (url: string) => url.includes("api.openai.com"),
          respond: () =>
            new Response(JSON.stringify(backgroundResponse), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        },
        supabaseRoute("/rest/v1/chat_state_history", []),
        supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
      ],
    });

    try {
      const res = await h.invoke(handler, START_TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      // Drain the SSE stream. The assistant row is now written before the
      // stream is built, but draining still exercises the emit path.
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Message, state and history are one transaction now, so the assertion
      // is on the call that carries all three rather than on a bare insert.
      const persist = h.fetchLog.find(
        (e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST",
      );
      assertEquals(persist !== undefined, true, "Expected a persist_chat_turn call");

      const args = JSON.parse(persist!.body ?? "{}");
      assertEquals(args._session_id, "sess-1");
      assertEquals(typeof args._content, "string");
      assertEquals(args._transition_type, "init");
    } finally {
      h.cleanup();
    }
  },
});

// ── Output moderation (#1198) ──────────────────────────────────────────

/**
 * A completed Socratic reply, delivered the way background mode delivers it.
 * `text` is what the tutor said, and therefore what output moderation screens.
 */
function socraticBackgroundResponse(text: string) {
  return {
    id: "resp_test_out",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            assistant_text: text,
            judgement: "CORRECT",
            stop: false,
            confidence: 0.9,
            reason: "test",
            missing: [],
            misconceptions: [],
          }),
        }],
      },
    ],
  };
}

/**
 * Everything the flagged-output path writes to, plus the reads that get it
 * there. An opening turn skips input moderation, so the single
 * `/v1/moderations` route is unambiguously the output check.
 */
function outputModerationRoutes(moderation: MockRoute, llmText: string): MockRoute[] {
  return [
    ...ENROLLED,
    supabaseRoute("/rest/v1/courses", { language: "en" }),
    supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
    supabaseRoute("/rest/v1/chat_sessions", chatSession()),
    supabaseRoute("/rest/v1/chat_messages", [], { method: "POST" }),
    supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),
    supabaseRoute("/rest/v1/chat_messages", []),
    supabaseRoute("/rest/v1/chat_session_state", { id: "state-1" }, { method: "POST" }),
    supabaseRoute("/rest/v1/chat_session_state", null),
    supabaseRoute("/rest/v1/questions", {
      question: "Q?",
      answer_key: { model_answer: "A", rubric: null, explanation: "E" },
      explanation: "E",
    }),
    supabaseRoute("/rest/v1/question_competencies", []),
    // Must precede the catch-all: both are api.openai.com.
    moderation,
    {
      match: (url: string) => url.includes("api.openai.com"),
      respond: () =>
        new Response(JSON.stringify(socraticBackgroundResponse(llmText)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    supabaseRoute("/rest/v1/flagged_content", [], { method: "POST" }),
    supabaseRoute("/rest/v1/admin_notifications", [], { method: "POST" }),
    supabaseRoute("/rest/v1/chat_state_history", []),
    supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
  ];
}

Deno.test({
  name: "chat: withholds a flagged open-question reply, records it, pauses and notifies",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    const h = createTestHarness({
      routes: outputModerationRoutes(
        openaiRoute("/v1/moderations", createModerationResponse(true, { violence: true })),
        "something the tutor should not have said",
      ),
    });

    try {
      const res = await h.invoke(handler, START_TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      // The reply never becomes a stream: it is withheld, not retracted.
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.error, "content_blocked");
      assertEquals(body.blockedSide, "assistant");
      assertEquals(body.flagged, true);
      assertEquals(body.categories, ["violence"]);
      // The pupil is not told they caused it.
      assertEquals(String(body.message).includes("not caused by anything you wrote"), true);

      // The withheld text is recorded as role='moderation' — a role no reader
      // replays to a model or shows to a student — and carries the flag.
      const chatInserts = h.fetchLog.filter(
        (e) => e.url.includes("chat_messages") && e.method === "POST",
      );
      assertEquals(chatInserts.length, 1, "Expected exactly one chat write");
      const row = JSON.parse(chatInserts[0].body ?? "{}");
      assertEquals(row.role, "moderation");
      assertEquals(row.flagged_offensive, true);
      const record = JSON.parse(row.content);
      assertEquals(record.side, "assistant");
      assertEquals(record.flaggedCategories, ["violence"]);
      assertEquals(record.withheld_text, "something the tutor should not have said");

      // flagged_content keeps the reply for review. `source` is the subject's
      // own name, which is what the historical rows carry — it outlived the
      // endpoint it was named after.
      const flaggedInsert = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/flagged_content") && e.method === "POST",
      );
      assertEquals(flaggedInsert !== undefined, true, "Expected a flagged_content insert");
      const flaggedRow = JSON.parse(flaggedInsert!.body ?? "{}");
      assertEquals(flaggedRow.data.type, "assistant_reply");
      assertEquals(flaggedRow.data.source, "socratic-chat");

      // The session is paused, matching the input-side behaviour.
      // The session row also gets a PATCH that scopes it to its offering, so
      // the pause is identified by what it writes rather than by being first.
      const pauseWrite = h.fetchLog.find(
        (e) =>
          e.url.includes("/rest/v1/chat_sessions") &&
          e.method === "PATCH" &&
          (e.body ?? "").includes("paused"),
      );
      assertEquals(pauseWrite !== undefined, true, "Expected the session to be paused");
      assertEquals(JSON.parse(pauseWrite!.body ?? "{}").status, "paused");

      // The school is told, and told it was the tutor.
      const notifications = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      assertEquals(notifications.length, 1, "Expected exactly one notification insert");
      const notif = JSON.parse(notifications[0].body ?? "{}");
      assertEquals(notif.type, "content_moderation");
      assertEquals(notif.student_id, "user-123");
      assertStringIncludes(notif.title, "AI tutor reply flagged");
      assertStringIncludes(notif.message, "violence");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat: a clean open-question reply is delivered and persisted unflagged",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    const h = createTestHarness({
      routes: outputModerationRoutes(
        openaiRoute("/v1/moderations", createModerationResponse(false)),
        "A perfectly ordinary Socratic nudge.",
      ),
    });

    try {
      const res = await h.invoke(handler, START_TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      assertEquals(res.headers.get("Content-Type"), "text/event-stream");
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      const row = JSON.parse(
        h.fetchLog.find((e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST")!
          .body ?? "{}",
      );
      assertEquals(row._session_id, "sess-1");
      assertEquals(row._content, "A perfectly ordinary Socratic nudge.");

      // Nothing was paused and nobody was notified.
      assertEquals(
        h.fetchLog.some((e) =>
          e.url.includes("/rest/v1/admin_notifications") && e.method === "POST"
        ),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat: a moderation API failure delivers the reply rather than dropping the turn",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    // The documented failure mode is "unscreened and logged", never "the
    // tutor stopped working" — a moderation outage must not read to a pupil
    // as the tutor breaking.
    const h = createTestHarness({
      routes: outputModerationRoutes(
        openaiRoute("/v1/moderations", { error: "upstream exploded" }, { status: 500 }),
        "A perfectly ordinary Socratic nudge.",
      ),
    });

    try {
      const res = await h.invoke(handler, START_TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      assertEquals(res.headers.get("Content-Type"), "text/event-stream");
      let sse = "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
      }
      // The reply is chunked 24 chars at a time, so assert on a fragment that
      // survives a chunk boundary rather than on the whole sentence.
      assertStringIncludes(sse, "perfectly ordinary");

      const row = JSON.parse(
        h.fetchLog.find((e) => e.url.includes("rpc/persist_chat_turn") && e.method === "POST")!
          .body ?? "{}",
      );
      assertEquals(row._session_id, "sess-1");
      assertEquals(row._content, "A perfectly ordinary Socratic nudge.");
      assertEquals(
        h.fetchLog.some((e) =>
          e.url.includes("/rest/v1/admin_notifications") && e.method === "POST"
        ),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});
