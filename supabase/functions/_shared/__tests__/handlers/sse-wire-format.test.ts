/**
 * SSE wire-format contract for the streaming chat handlers.
 *
 * Every other layer asserts DATA — database rows, RLS, parsed objects. None
 * asserted the SHAPE of what reaches the browser, and that gap shipped a
 * completely broken feature past a fully green suite (#1051): a `sendSSE`
 * template literal carrying an escaped `\\n\\n` emitted two literal backslash-n
 * characters instead of the blank line SSE framing requires. parseSSEStream
 * would have hit EOF without recognising a single frame — no assistant text, no
 * metadata, nothing on screen — while the reply sat correctly persisted in the
 * database. Tests passed, deno check passed, lint passed.
 *
 * The handler test for that path drains the response body and asserts the DB
 * write. Draining is not parsing: a body of literal backslashes drains happily.
 *
 * So these tests parse the handler's own output with _shared/sse.ts — a real
 * parser with its own tests (#1047) — and assert the frames a browser would
 * actually receive.
 */

import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, supabaseRoute } from "../handler-harness.ts";
import { handler as chatHandler } from "../../../chat/handler.ts";
import { _clearQualityInstructionCache } from "../../../_shared/openai-client.ts";
import { drainSSEBlocks, normalizeSSENewlines, parseSSEFrame } from "../../sse.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

interface DecodedStream {
  /** Concatenated `choices[0].delta.content` across every delta frame. */
  content: string;
  /** The `{ type: "metadata", … }` frame, if one was emitted. */
  metadata: Record<string, unknown> | null;
  /** Whether a terminating `[DONE]` sentinel was seen. */
  sawDone: boolean;
  frameCount: number;
  /** Bytes left over after the last complete frame. Must be empty. */
  unterminated: string;
}

/**
 * Reads a handler Response the way the browser does.
 *
 * Deliberately goes through the shared SSE parser rather than string-matching
 * the body: the point is to fail for exactly the reasons parseSSEStream would.
 * A hand-rolled `body.includes("Hello")` assertion passes on the broken build,
 * because the text IS in there — just never delimited into a frame.
 */
async function decodeSSE(res: Response): Promise<DecodedStream> {
  const raw = normalizeSSENewlines(await res.text());
  const { blocks, rest } = drainSSEBlocks(raw);

  let content = "";
  let metadata: Record<string, unknown> | null = null;
  let sawDone = false;
  let frameCount = 0;

  // Only COMPLETE frames, deliberately excluding `rest`. parseSSEStream
  // discards whatever is left in its buffer at EOF, so counting the trailing
  // remainder here would make this helper more permissive than the browser: a
  // handler that dropped its final delimiter would pass the test and lose the
  // frame in production. `unterminated` is asserted empty by the callers.
  for (const block of blocks) {
    const frame = parseSSEFrame(block);
    if (!frame) continue;
    frameCount++;

    if (frame.type === "[DONE]") {
      sawDone = true;
      continue;
    }
    if (!frame.data) continue;

    if (frame.data.type === "metadata") {
      metadata = frame.data;
      continue;
    }

    const choices = frame.data.choices as Array<{ delta?: { content?: string } }> | undefined;
    const delta = choices?.[0]?.delta?.content;
    if (delta) content += delta;
  }

  return { content, metadata, sawDone, frameCount, unterminated: rest.trim() };
}

const SOCRATIC_REPLY = "Σκέψου τι σημαίνει «συνεχής» στο κλειστό διάστημα.";

function socraticHarness() {
  const fullJson = JSON.stringify({
    assistant_text: SOCRATIC_REPLY,
    judgement: "PARTIAL",
    stop: false,
    confidence: 0.8,
    reason: "test",
    missing: ["continuity"],
    misconceptions: [],
  });

  // status "completed" on the POST short-circuits polling so the test does not
  // sit through the poll interval.
  const backgroundResponse = {
    id: "resp_sse_1",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: fullJson }] }],
  };

  return createTestHarness({
    routes: [
      supabaseRoute("/rest/v1/courses", { language: "en" }),
      supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
      // The enrollment gate (#1136): a published offering_questions row for the
      // question, and the caller enrolled in that offering's class.
      supabaseRoute("/rest/v1/offering_questions", [
        { offering_id: "off-1", offerings: { id: "off-1", class_id: "class-1" } },
      ]),
      supabaseRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
      supabaseRoute("/rest/v1/offerings", { id: "off-1", course_id: "c1" }),
      supabaseRoute("/rest/v1/chat_sessions", {
        id: "sess-1",
        user_id: "user-123",
        course_id: "c1",
        offering_id: null,
        study_session_id: null,
        open_question_id: "q1",
        status: "in_progress",
        subject_kind: "open_question",
      }),
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
}

Deno.test({
  name: "chat/open_question: response body parses as SSE and carries the reply",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();
    const h = socraticHarness();

    try {
      const res = await h.invoke(
        chatHandler,
        { kind: "open_question", subjectId: "q1", courseId: "c1", start: true },
        { headers: { authorization: "Bearer fake-token" } },
      );

      assertEquals(res.headers.get("content-type"), "text/event-stream");

      const stream = await decodeSSE(res);

      // The assertion that #1051 would have failed: with literal backslash-n
      // delimiters no block boundary exists, so nothing parses into a frame.
      assert(stream.frameCount > 0, "no SSE frames parsed from the response body");
      assertEquals(stream.content, SOCRATIC_REPLY);
      assert(stream.sawDone, "stream did not terminate with [DONE]");
      assertEquals(stream.unterminated, "", "trailing bytes after the last complete frame");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/open_question: emits a metadata frame the frontend contract expects",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();
    const h = socraticHarness();

    try {
      const res = await h.invoke(
        chatHandler,
        { kind: "open_question", subjectId: "q1", courseId: "c1", start: true },
        { headers: { authorization: "Bearer fake-token" } },
      );

      const { metadata } = await decodeSSE(res);

      // parseSSEStream surfaces this as `metadata.state`, and the UI reads
      // state.decision / state.evaluator off it.
      assert(metadata, "no metadata frame emitted");
      const state = metadata!.state as Record<string, unknown>;
      assertEquals(state.decision, "ASK");
      assert(state.evaluator, "metadata.state.evaluator missing");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/open_question: every frame is delimited by a real blank line",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();
    const h = socraticHarness();

    try {
      const res = await h.invoke(
        chatHandler,
        { kind: "open_question", subjectId: "q1", courseId: "c1", start: true },
        { headers: { authorization: "Bearer fake-token" } },
      );

      const body = await res.text();

      // Pinned explicitly because this is the exact byte-level defect from
      // #1051, and it is invisible to every other kind of assertion: the text
      // is all present, just never framed.
      assert(body.includes("\n\n"), "body contains no blank-line frame delimiter");
      assert(
        !body.includes("\\n"),
        "body contains a literal backslash-n — the delimiter was escaped (#1051)",
      );
      assert(body.startsWith("data: "), "first frame is not an SSE data line");
    } finally {
      h.cleanup();
    }
  },
});

// ── study-session surface ──────────────────────────────────────────────
//
// The handler tests for this surface stop at validation and moderation and
// never reach the LLM — so the path that actually produces SSE had no
// coverage at all before this file.

const TUTOR_REPLY = "Η **παλινόρθωση** ήταν η επαναφορά του παλαιού καθεστώτος.";

function tutorHarness() {
  const fullJson = JSON.stringify({
    assistant_text_draft: TUTOR_REPLY,
    response_class: "ON_TRACK",
    grounding_status: "GROUNDED",
    confidence: 0.9,
    state_patch: {
      subject: "Ιστορία",
      current_topic: "Παλινόρθωση",
      learning_goal: "",
      progress_level: "developing",
      known: [],
      gaps: [],
      misconceptions: [],
      difficulty: "same",
      frustration: 0,
    },
  });

  const backgroundResponse = {
    id: "resp_sse_tutor",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: fullJson }] }],
  };

  return createTestHarness({
    routes: [
      supabaseRoute("/auth/v1/user", { id: "user-123", email: "test@test.com" }),
      // The session row keyed on the caller, plus the study session it names.
      supabaseRoute("/rest/v1/chat_sessions", {
        id: "prog-1",
        user_id: "user-123",
        course_id: "c1",
        offering_id: null,
        study_session_id: "sess-1",
        open_question_id: null,
        status: "in_progress",
        subject_kind: "study_session",
      }),
      supabaseRoute("/rest/v1/study_sessions", {
        id: "sess-1",
        course_id: "c1",
        title: "Test session",
        topic: "Παλινόρθωση",
        extracted_content: "Η παλινόρθωση ήταν η επαναφορά του παλαιού καθεστώτος.",
        instructions: null,
        student_notes: null,
        reference_images: [],
        chapter_id: null,
      }),
      supabaseRoute("/rest/v1/courses", {
        id: "c1",
        title: "ΙΣΤΟΡΙΑ",
        description: "",
        language: "el",
        institutions: { id: "inst-1", name: "Test" },
      }),
      supabaseRoute("/rest/v1/study_session_competencies", []),
      // The turn reads history here, then writes the reply back.
      supabaseRoute("/rest/v1/chat_messages", [], { method: "POST" }),
      supabaseRoute("/rest/v1/rpc/persist_chat_turn", "msg-1", { method: "POST" }),

      supabaseRoute("/rest/v1/chat_messages", [
        { role: "user", content: "Τι ήταν η παλινόρθωση;", created_at: "2026-01-01T00:00:00Z" },
      ]),
      supabaseRoute("/rest/v1/chat_session_state", { id: "st-1" }, { method: "POST" }),
      supabaseRoute("/rest/v1/chat_session_state", null),
      supabaseRoute("/rest/v1/chat_state_history", []),
      {
        match: (url: string) => url.includes("api.openai.com/v1/moderations"),
        respond: () =>
          new Response(
            JSON.stringify({ id: "modr-1", model: "omni", results: [{ flagged: false, categories: {}, category_scores: {} }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
      {
        match: (url: string) => url.includes("api.openai.com"),
        respond: () =>
          new Response(JSON.stringify(backgroundResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
    ],
  });
}

Deno.test({
  name: "chat/study_session: response body parses as SSE and carries the reply",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();
    const h = tutorHarness();

    try {
      const res = await h.invoke(
        chatHandler,
        { kind: "study_session", subjectId: "sess-1", courseId: "c1" },
        { headers: { authorization: "Bearer fake-token" } },
      );

      assertEquals(res.headers.get("content-type"), "text/event-stream");

      const stream = await decodeSSE(res);
      assert(stream.frameCount > 0, "no SSE frames parsed from the response body");
      assertEquals(stream.content, TUTOR_REPLY);
      assert(stream.sawDone, "stream did not terminate with [DONE]");
      assertEquals(stream.unterminated, "", "trailing bytes after the last complete frame");

      // The tutor's metadata carries the merged session state the player reads.
      assert(stream.metadata, "no metadata frame emitted");
      const meta = stream.metadata!.meta as Record<string, unknown>;
      assertEquals(meta.response_class, "ON_TRACK");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/study_session: every frame is delimited by a real blank line",
  ...OPTS,
  async fn() {
    _clearQualityInstructionCache();
    const h = tutorHarness();

    try {
      const res = await h.invoke(
        chatHandler,
        { kind: "study_session", subjectId: "sess-1", courseId: "c1" },
        { headers: { authorization: "Bearer fake-token" } },
      );

      const body = await res.text();
      assert(body.includes("\n\n"), "body contains no blank-line frame delimiter");
      assert(!body.includes("\\n"), "body contains a literal backslash-n (#1051)");
    } finally {
      h.cleanup();
    }
  },
});
