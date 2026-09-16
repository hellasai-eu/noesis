/**
 * Moderation on the study-session surface of the unified `chat` endpoint,
 * both directions.
 *
 * These assertions used to run against `study-tutor` — a shim that resolved
 * the legacy `progressId` and delegated — so what they covered was always
 * `runChatTurn` plus `studySessionSubject`. The shim is gone (#1441); the
 * endpoint is the one the frontend calls.
 *
 * Input side: the student's message is screened before the model is paid for.
 * Output side: the reply the model produced, which until #1198 reached the
 * pupil and the transcript with nothing screening it.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../chat/handler.ts";
import { createModerationResponse } from "../test-utils.ts";
import { _clearQualityInstructionCache } from "../../../_shared/openai-client.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

/** A study-session turn, as the client sends it: addressed by subject, never
 *  by session id — the function keys the session on the caller. */
const TURN = { kind: "study_session", subjectId: "s1", courseId: "c1" };

const EMPTY_STATE = {
  subject: "",
  current_topic: "",
  learning_goal: "",
  progress_level: "intro",
  known: [],
  gaps: [],
  misconceptions: [],
  difficulty: "same",
  frustration: 0,
};

/** A completed tutor reply, the way background mode delivers it. */
function tutorBackgroundResponse(text: string) {
  return {
    id: "resp_tutor_1",
    status: "completed",
    output: [
      {
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            assistant_text_draft: text,
            response_class: "explain",
            grounding_status: "grounded",
            confidence: 0.9,
            state_patch: EMPTY_STATE,
          }),
        }],
      },
    ],
  };
}

/** The reads every study-session turn makes, before anything is written. */
function subjectRoutes(): MockRoute[] {
  return [
    supabaseRoute("/auth/v1/user", { id: "user-1", email: "student@test.com" }),

    // The session `resolveSession` keys on (caller + subject).
    supabaseRoute("/rest/v1/chat_sessions", {
      id: "p1",
      user_id: "user-1",
      course_id: "c1",
      offering_id: null,
      study_session_id: "s1",
      open_question_id: null,
      status: "in_progress",
      subject_kind: "study_session",
    }),

    // authorize() reads course_id; loadContext() reads the rest.
    supabaseRoute("/rest/v1/study_sessions", {
      id: "s1",
      course_id: "c1",
      title: "Test Session",
      topic: "Test Topic",
      extracted_content: "Some content",
      instructions: null,
      student_notes: null,
      reference_images: [],
      chapter_id: null,
    }),

    supabaseRoute("/rest/v1/courses", {
      id: "c1",
      language: "en",
      institution_id: "i1",
      title: "Test Course",
      description: "A test course",
      institutions: { id: "i1", name: "Test Inst" },
    }),

    supabaseRoute("/rest/v1/study_session_competencies", []),
  ];
}

// ── Input side ─────────────────────────────────────────────────────────

Deno.test({
  name: "chat/study_session: inserts admin_notification when input is flagged by moderation",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        ...subjectRoutes(),

        // Transcript. POST must precede the GET catch-all for the same table.
        supabaseRoute("/rest/v1/chat_messages", {}, { method: "POST" }),
        supabaseRoute("/rest/v1/chat_messages", [
          { id: "m-1", role: "assistant", content: "Welcome!" },
          { id: "m-2", role: "user", content: "bad content" },
        ]),

        supabaseRoute("/rest/v1/chat_session_state", {
          id: "state-1",
          current_state: EMPTY_STATE,
        }),

        // OpenAI moderation API: flag the content
        openaiRoute("/v1/moderations", createModerationResponse(true, { harassment: true })),

        // The session is paused by an UPDATE on the session row.
        supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),

        // admin_notifications POST (insert notification)
        supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
      ],
    });

    try {
      const res = await h.invoke(handler, TURN, {
        headers: { authorization: "Bearer fake-token" },
      });
      const { status, body } = await parseResponse(res);

      // Should return 200 with content_blocked
      assertEquals(status, 200);
      assertEquals(body.error, "content_blocked");
      assertEquals(body.flagged, true);

      // Verify admin_notifications was called
      const notificationCalls = h.fetchLog.filter(
        (entry) =>
          entry.url.includes("/rest/v1/admin_notifications") &&
          entry.method === "POST",
      );
      assertEquals(notificationCalls.length, 1, "Expected exactly one notification insert");

      // Verify notification body contains expected fields
      const notificationBody = JSON.parse(notificationCalls[0].body || "{}");
      assertEquals(notificationBody.course_id, "c1");
      assertEquals(notificationBody.student_id, "user-1");
      assertEquals(notificationBody.type, "content_moderation");
      assertStringIncludes(notificationBody.title, "flagged");
      assertStringIncludes(notificationBody.message, "harassment");
    } finally {
      h.cleanup();
    }
  },
});

// ── Output side (#1198) ────────────────────────────────────────────────

/**
 * Two moderation calls happen per turn — the student's message, then the
 * tutor's reply — and both hit the same endpoint. `moderationResponses` is
 * therefore ordered: [input, output].
 */
function routes(moderationResponses: MockRoute, llmText: string): MockRoute[] {
  return [
    ...subjectRoutes(),

    // Transcript. POST first so it is not swallowed by the GET catch-all.
    supabaseRoute("/rest/v1/chat_messages", {}, { method: "POST" }),
    supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),

    supabaseRoute("/rest/v1/chat_messages", [
      { id: "m-1", role: "assistant", content: "Welcome!" },
      { id: "m-2", role: "user", content: "explain photosynthesis" },
    ]),

    supabaseRoute("/rest/v1/chat_session_state", { id: "state-1", current_state: EMPTY_STATE }),
    // Must precede the catch-all: both are api.openai.com.
    moderationResponses,
    {
      match: (url: string) => url.includes("api.openai.com"),
      respond: () =>
        new Response(JSON.stringify(tutorBackgroundResponse(llmText)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    // Pausing is an UPDATE on the session row.
    supabaseRoute("/rest/v1/chat_sessions", {}, { method: "PATCH" }),
    supabaseRoute("/rest/v1/chat_session_state", {}, { method: "PATCH" }),
    supabaseRoute("/rest/v1/chat_state_history", {}, { method: "POST" }),
    supabaseRoute("/rest/v1/flagged_content", {}, { method: "POST" }),
    supabaseRoute("/rest/v1/admin_notifications", {}, { method: "POST" }),
    supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
  ];
}

/**
 * The assistant row is written in post-stream work, which runs detached once
 * the SSE body closes (`EdgeRuntime.waitUntil` in production, a bare promise
 * locally). Draining the stream therefore does not mean the write has landed,
 * so poll for it rather than asserting on the next tick.
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

// The assistant turn is recorded by one transactional RPC, so this is what a
// delivered reply looks like on the wire.
const isAssistantWrite = (e: { url: string; method: string }) =>
  e.url.includes("/rest/v1/rpc/persist_chat_turn") && e.method === "POST";

/** Answers the input check clean, then the output check with `flagged`. */
function moderationSequence(responses: unknown[]): MockRoute {
  let callIndex = 0;
  return {
    match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
    respond: () => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

Deno.test({
  name: "chat/study_session: withholds a flagged reply, records it, pauses and notifies",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    const h = createTestHarness({
      routes: routes(
        moderationSequence([
          createModerationResponse(false),
          createModerationResponse(true, { "self-harm": true }),
        ]),
        "something the tutor should not have said",
      ),
    });

    try {
      const res = await h.invoke(handler, TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      // Withheld outright: the client gets JSON, never a stream.
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.error, "content_blocked");
      assertEquals(body.blockedSide, "assistant");
      assertEquals(body.flagged, true);
      assertEquals(body.categories, ["self-harm"]);
      assertEquals(String(body.message).includes("not caused by anything you wrote"), true);

      // The only message write is the moderation record — no assistant row,
      // so the reply never enters the transcript or the replayed history.
      const messageWrites = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/chat_messages") && e.method === "POST",
      );
      assertEquals(messageWrites.length, 1, "Expected exactly one message write");
      const row = JSON.parse(messageWrites[0].body ?? "{}");
      assertEquals(row.role, "moderation");
      const record = JSON.parse(row.content);
      assertEquals(record.side, "assistant");
      assertEquals(record.flaggedCategories, ["self-harm"]);
      assertEquals(record.withheld_text, "something the tutor should not have said");

      // `source` is the subject's own name, which is what the historical rows
      // carry — it outlived the endpoint it was named after.
      const flaggedInsert = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/flagged_content") && e.method === "POST",
      );
      assertEquals(flaggedInsert !== undefined, true, "Expected a flagged_content insert");
      assertEquals(JSON.parse(flaggedInsert!.body ?? "{}").data.source, "study-tutor");

      const pause = h.fetchLog.find(
        (e) => e.url.includes("/rest/v1/chat_sessions") && e.method === "PATCH",
      );
      assertEquals(pause !== undefined, true, "Expected the session to be paused");
      assertEquals(JSON.parse(pause!.body ?? "{}").status, "paused");

      const notifications = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      assertEquals(notifications.length, 1, "Expected exactly one notification insert");
      const notif = JSON.parse(notifications[0].body ?? "{}");
      assertEquals(notif.type, "content_moderation");
      assertEquals(notif.student_id, "user-1");
      assertStringIncludes(notif.title, "AI tutor reply flagged");
      assertStringIncludes(notif.message, "self-harm");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/study_session: a failed pause is escalated to the school, not reported as success",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    // The pause is the control that stops the tutor taking another turn, and
    // the client rebuilds pause state from this row on reload. A write that
    // fails silently would resume tutoring with no review, while every other
    // signal said the session was paused — so the failure has to reach a human.
    const base = routes(
      moderationSequence([
        createModerationResponse(false),
        createModerationResponse(true, { violence: true }),
      ]),
      "something the tutor should not have said",
    );
    const failingPause: MockRoute = {
      match: (url: string, init?: RequestInit) =>
        url.includes("/rest/v1/chat_sessions") &&
        (init?.method ?? "GET").toUpperCase() === "PATCH",
      respond: () =>
        new Response(JSON.stringify({ message: "deadlock detected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    };

    const h = createTestHarness({ routes: [failingPause, ...base] });

    try {
      const res = await h.invoke(handler, TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      // The reply is still withheld — that part succeeded.
      const { body } = await parseResponse(res);
      assertEquals(body.error, "content_blocked");
      assertEquals(body.blockedSide, "assistant");

      // But the pupil is not told the session was paused when it was not.
      // Nothing more can pause it once the database refuses the write twice;
      // saying otherwise would be telling a child something untrue about what
      // the platform did on their behalf.
      const message = String(body.message);
      assertEquals(
        message.includes("has been paused"),
        false,
        "Must not claim a pause that did not happen",
      );
      assertStringIncludes(message, "will need to review this session");

      // Retried once before giving up.
      const pauseAttempts = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/chat_sessions") && e.method === "PATCH",
      );
      assertEquals(pauseAttempts.length, 2, "Expected the pause write to be retried once");

      // And the school is told the session is still live.
      const notifications = h.fetchLog.filter(
        (e) => e.url.includes("/rest/v1/admin_notifications") && e.method === "POST",
      );
      assertEquals(notifications.length, 1);
      assertStringIncludes(
        JSON.parse(notifications[0].body ?? "{}").message,
        "must be paused manually",
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/study_session: a clean reply is delivered and persisted",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    const h = createTestHarness({
      routes: routes(
        moderationSequence([createModerationResponse(false), createModerationResponse(false)]),
        "Photosynthesis turns light into sugar.",
      ),
    });

    try {
      const res = await h.invoke(handler, TURN, {
        headers: { authorization: "Bearer fake-token" },
      });

      assertEquals(res.headers.get("Content-Type"), "text/event-stream");
      const reader = res.body!.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      await waitForFetch(h.fetchLog, isAssistantWrite);
      const messageWrites = h.fetchLog.filter(isAssistantWrite);
      assertEquals(messageWrites.length, 1);
      assertEquals(JSON.parse(messageWrites[0].body ?? "{}")._content.length > 0, true);

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
  name: "chat/study_session: a moderation API failure delivers the reply rather than dropping the turn",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();

    // Input moderation answers clean; the output check gets a 500. The
    // documented failure mode is "unscreened and logged", never "the tutor
    // stopped working".
    let callIndex = 0;
    const moderation: MockRoute = {
      match: (url: string) => url.includes("api.openai.com") && url.includes("/v1/moderations"),
      respond: () => {
        const isOutputCheck = callIndex++ > 0;
        return isOutputCheck
          ? new Response(JSON.stringify({ error: "upstream exploded" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
          : new Response(JSON.stringify(createModerationResponse(false)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
      },
    };

    const h = createTestHarness({
      routes: routes(moderation, "Photosynthesis turns light into sugar."),
    });

    try {
      const res = await h.invoke(handler, TURN, {
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
      // Chunked 24 chars at a time, so assert on a fragment inside one chunk.
      assertStringIncludes(sse, "Photosynthesis");

      await waitForFetch(h.fetchLog, isAssistantWrite);
      const messageWrites = h.fetchLog.filter(isAssistantWrite);
      assertEquals(messageWrites.length, 1);
      assertEquals(JSON.parse(messageWrites[0].body ?? "{}")._content.length > 0, true);

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
