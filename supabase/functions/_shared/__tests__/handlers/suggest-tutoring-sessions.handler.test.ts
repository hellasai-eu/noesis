import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  authorizedCallerRoutes,
  BEARER_AUTH,
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../suggest-tutoring-sessions/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const CHAPTER = {
  id: "ch-1",
  title: "Polynomials",
  chapter_number: 3,
  content: "A polynomial is a sum of terms of the form ax^n.",
  openai_file_id: null,
  material_id: "mat-1",
};

/** Wrap a structured payload the way the Responses API returns it. */
function aiResponse(payload: unknown) {
  return {
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(payload) }],
    }],
  };
}

function baseRoutes(
  overrides: { ai?: unknown; chapter?: unknown; materialFileId?: string | null } = {},
) {
  return [
    ...authorizedCallerRoutes(),
    supabaseRoute("/rest/v1/material_chapters", overrides.chapter ?? CHAPTER),
    supabaseRoute("/rest/v1/course_materials", {
      course_id: "course-1",
      openai_file_id: overrides.materialFileId ?? null,
    }),
    supabaseRoute("/rest/v1/study_sessions", [{ title: "Existing session", topic: "Basics" }]),
    supabaseRoute("/rest/v1/ai_usage_logs", {}, { method: "POST" }),
    openaiRoute(
      "/v1/responses",
      overrides.ai ?? aiResponse({
        status: "success",
        message: "Three sessions proposed.",
        sessions: [
          { title: "Recognising Polynomials", topic: "Identify a polynomial", instructions: "Start from examples." },
          { title: "Degree and Leading Term", topic: "Read off the degree", instructions: "Contrast with roots." },
        ],
      }),
      { method: "POST" },
    ),
  ];
}

Deno.test("suggest-tutoring-sessions: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/suggest-tutoring-sessions", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "suggest-tutoring-sessions: an unauthenticated caller is refused before the chapter is read",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { chapterId: "ch-1" });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Unauthorized");
      // The gate is the whole boundary here (verify_jwt = false + service role),
      // so nothing downstream of it may have run — least of all the paid call.
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "suggest-tutoring-sessions: rejects a missing chapterId",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, {}, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertEquals(body.error, "chapterId is required");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "suggest-tutoring-sessions: returns the proposed sessions for an authorized manager",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: baseRoutes() });
    try {
      const res = await h.invoke(handler, { chapterId: "ch-1" }, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, true);
      assertEquals(body.sessions.length, 2);
      assertEquals(body.sessions[0].title, "Recognising Polynomials");
      assertEquals(body.sessions[0].topic, "Identify a polynomial");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "suggest-tutoring-sessions: caps the model at three sessions and drops half-filled ones",
  ...OPTS,
  async fn() {
    // A strict structured-output schema cannot express `maxItems`, so a model
    // that returns six is not a malformed response — it is the case the
    // handler's own slice exists for. A session missing any of its three
    // fields is half a suggestion and must not occupy a slot: the instructor
    // cannot even save a draft with a blank objective.
    const h = createTestHarness({
      routes: baseRoutes({
        ai: aiResponse({
          status: "success",
          message: "Proposed.",
          sessions: [
            { title: "   ", topic: "blank title", instructions: "x" },
            { title: "No objective", topic: "  ", instructions: "x" },
            { title: "No tutor brief", topic: "a", instructions: "" },
            { title: "One", topic: "a", instructions: "x" },
            { title: "Two", topic: "b", instructions: "y" },
            { title: "Three", topic: "c", instructions: "z" },
            { title: "Four", topic: "d", instructions: "w" },
          ],
        }),
      }),
    });
    try {
      const res = await h.invoke(handler, { chapterId: "ch-1" }, { headers: BEARER_AUTH });
      const { body } = await parseResponse(res);
      assertEquals(body.sessions.length, 3);
      assertEquals(body.sessions.map((s: { title: string }) => s.title), ["One", "Two", "Three"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "suggest-tutoring-sessions: a chapter with no content is reported, not sent to OpenAI",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes({
        chapter: { ...CHAPTER, content: null, openai_file_id: null, material_id: "mat-1" },
      }),
    });
    try {
      const res = await h.invoke(handler, { chapterId: "ch-1" }, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, false);
      assertEquals(body.sessions.length, 0);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "suggest-tutoring-sessions: never falls back to the whole textbook when the chapter has no content",
  ...OPTS,
  async fn() {
    // The parent material's file is the whole book with no chapter boundaries.
    // Sending it would let the model plan sessions from any part of the book
    // and write them as drafts labelled with the chapter the instructor chose —
    // wrong in a way the instructor cannot see from the result. Refuse instead.
    const h = createTestHarness({
      routes: baseRoutes({
        chapter: { ...CHAPTER, content: null, openai_file_id: null, material_id: "mat-1" },
        materialFileId: "file-whole-textbook",
      }),
    });
    try {
      const res = await h.invoke(handler, { chapterId: "ch-1" }, { headers: BEARER_AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.success, false);
      assertEquals(body.sessions.length, 0);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
      assertEquals(
        h.fetchLog.some((e) => (e.body ?? "").includes("file-whole-textbook")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});
