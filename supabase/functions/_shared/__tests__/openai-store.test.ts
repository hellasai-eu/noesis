/**
 * OpenAI request retention (`store`) — the privacy default and its one opt-out.
 *
 * Every Responses API call must state `store` explicitly, and the answer is
 * `false` unless the request's institution has the super-admin-controlled
 * `openai_store_enabled` flag on. Background mode is the forced exception
 * (OpenAI requires stored responses to poll), where a DELETE must follow.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  _clearQualityInstructionCache,
  callOpenAI,
  callOpenAIStructured,
  callOpenAIWithPrompt,
} from "../openai-client.ts";
import { _clearOpenAIStoreCache, resolveOpenAIStore } from "../openai-retention.ts";
import { streamStructuredTurn } from "../openai-stream.ts";

const originalFetch = globalThis.fetch;
const originalEnvGet = Deno.env.get;
// Supabase-js starts an internal interval (token refresh) that Deno's leak
// detector flags after the test returns. These tests create real supabase
// clients on purpose (to exercise the resolve path), so sanitization is off.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

function setupEnv() {
  const env: Record<string, string> = {
    OPENAI_API_KEY: "test-openai-key",
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  };
  Deno.env.get = (key: string) => env[key];
}

function restore() {
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnvGet;
  _clearQualityInstructionCache();
  _clearOpenAIStoreCache();
}

interface RecordedCall {
  method: string;
  url: string;
  // deno-lint-ignore no-explicit-any
  body: any;
}

const OPENAI_MESSAGE_RESPONSE = {
  id: "resp_123",
  object: "response",
  status: "completed",
  model: "gpt-5.4-mini",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify({ ok: true }) }],
    },
  ],
};

/**
 * Mock fetch:
 *  - `/rest/v1/institutions` with `select=openai_store_enabled` answers the
 *    retention flag (or 500s when `flagLookupFails`)
 *  - `/rest/v1/courses` with `select=institution_id` answers the
 *    course→institution resolution
 *  - the quality-instruction lookups (`language, institution_id` /
 *    `default_language`) answer null so no quality rules interfere
 *  - OpenAI POSTs are recorded and answered with `openaiResponse`, or with a
 *    `queued` background response when `backgroundQueued` is set
 *  - OpenAI GETs (background polling) answer `openaiResponse` (a 500 when
 *    `pollFails`), DELETEs succeed — all recorded
 */
function makeMockFetch(opts: {
  institutionFlag?: boolean;
  flagLookupFails?: boolean;
  courseInstitutionId?: string | null;
  openaiResponse?: unknown;
  backgroundQueued?: boolean;
  pollFails?: boolean;
  calls: RecordedCall[];
}) {
  return async (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (urlStr.includes("/rest/v1/institutions") && urlStr.includes("openai_store_enabled")) {
      if (opts.flagLookupFails) return json({ message: "boom" }, 500);
      return json({ openai_store_enabled: opts.institutionFlag ?? false });
    }
    if (urlStr.includes("/rest/v1/institutions")) {
      return json({ default_language: null });
    }
    if (urlStr.includes("/rest/v1/courses") && urlStr.includes("select=institution_id")) {
      return json({ institution_id: opts.courseInstitutionId ?? null });
    }
    if (urlStr.includes("/rest/v1/courses")) {
      return json({ language: null, institution_id: null });
    }

    if (urlStr.includes("api.openai.com")) {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : null;
      opts.calls.push({ method, url: urlStr, body });
      if (method === "DELETE") return json({ deleted: true });
      if (method === "GET") {
        if (opts.pollFails) return json({ message: "poll boom" }, 500);
        return json(opts.openaiResponse ?? OPENAI_MESSAGE_RESPONSE);
      }
      if (opts.backgroundQueued) {
        return json({ id: "resp_123", object: "response", status: "queued", output: [] });
      }
      return json(opts.openaiResponse ?? OPENAI_MESSAGE_RESPONSE);
    }

    return new Response("not found", { status: 404 });
  };
}

Deno.test("callOpenAI: sends store:false when there is no usage context", OPTS, async () => {
  setupEnv();
  const calls: RecordedCall[] = [];
  globalThis.fetch = makeMockFetch({ calls }) as typeof fetch;
  try {
    await callOpenAI({ model: "gpt-4.1", instructions: "i", input: "hello" });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].body.store, false);
  } finally {
    restore();
  }
});

Deno.test(
  "callOpenAI: sends store:true when the institution's retention flag is on",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ institutionFlag: true, calls }) as typeof fetch;
    try {
      await callOpenAI({
        model: "gpt-4.1",
        instructions: "i",
        input: "hello",
        usageContext: { functionName: "test", institutionId: "inst-1" },
      });
      assertEquals(calls[0].body.store, true);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAI: resolves the institution through courseId when only a course is known",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({
      institutionFlag: true,
      courseInstitutionId: "inst-1",
      calls,
    }) as typeof fetch;
    try {
      await callOpenAI({
        model: "gpt-4.1",
        instructions: "i",
        input: "hello",
        usageContext: { functionName: "test", courseId: "course-1" },
      });
      assertEquals(calls[0].body.store, true);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "resolveOpenAIStore: a failed flag lookup falls back to store:false",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ flagLookupFails: true, calls }) as typeof fetch;
    try {
      assertEquals(await resolveOpenAIStore({ institutionId: "inst-1" }), false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIWithPrompt: non-background requests carry store:false by default",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ calls }) as typeof fetch;
    try {
      await callOpenAIWithPrompt({ id: "pmpt_1", variables: {} }, "content");
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body.store, false);
      assertEquals(calls[0].body.background, undefined);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIWithPrompt: background mode forces store:true and deletes the stored response afterwards",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ calls }) as typeof fetch;
    try {
      await callOpenAIWithPrompt(
        { id: "pmpt_1", variables: {} },
        "content",
        undefined,
        undefined,
        { enabled: true },
      );
      const post = calls.find((c) => c.method === "POST");
      assert(post, "expected a POST to OpenAI");
      assertEquals(post.body.store, true);
      assertEquals(post.body.background, true);
      const del = calls.find((c) => c.method === "DELETE");
      assert(del, "expected the stored background response to be deleted");
      assert(del.url.endsWith("/v1/responses/resp_123"));
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIWithPrompt: background mode with the flag on stores and does NOT delete",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ institutionFlag: true, calls }) as typeof fetch;
    try {
      await callOpenAIWithPrompt(
        { id: "pmpt_1", variables: {} },
        "content",
        undefined,
        undefined,
        { enabled: true },
        { functionName: "test", institutionId: "inst-1" },
      );
      const post = calls.find((c) => c.method === "POST");
      assert(post);
      assertEquals(post.body.store, true);
      assertEquals(
        calls.filter((c) => c.method === "DELETE").length,
        0,
        "opted-in institution's stored response must be kept",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIWithPrompt: a polled background response is deleted after polling completes",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ backgroundQueued: true, calls }) as typeof fetch;
    try {
      await callOpenAIWithPrompt(
        { id: "pmpt_1", variables: {} },
        "content",
        undefined,
        undefined,
        { enabled: true, pollIntervalMs: 1 },
      );
      assert(
        calls.some((c) => c.method === "GET" && c.url.includes("/v1/responses/resp_123")),
        "expected the background response to be polled",
      );
      const del = calls.find((c) => c.method === "DELETE");
      assert(del, "expected the stored response to be deleted after polling");
      assert(del.url.endsWith("/v1/responses/resp_123"));
      // The delete must come after the poll retrieved the result.
      assert(calls.indexOf(del) > calls.findIndex((c) => c.method === "GET"));
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIWithPrompt: a failed background poll still deletes the stored response",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({
      backgroundQueued: true,
      pollFails: true,
      calls,
    }) as typeof fetch;
    try {
      await assertRejects(() =>
        callOpenAIWithPrompt(
          { id: "pmpt_1", variables: {} },
          "content",
          { maxRetries: 0 },
          undefined,
          { enabled: true, pollIntervalMs: 1 },
        )
      );
      assert(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v1/responses/resp_123")),
        "a failed poll must not leave the stored response retained",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIWithPrompt: an opted-in institution's polled background response is kept",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({
      institutionFlag: true,
      backgroundQueued: true,
      calls,
    }) as typeof fetch;
    try {
      await callOpenAIWithPrompt(
        { id: "pmpt_1", variables: {} },
        "content",
        undefined,
        undefined,
        { enabled: true, pollIntervalMs: 1 },
        { functionName: "test", institutionId: "inst-1" },
      );
      assert(calls.some((c) => c.method === "GET"), "expected polling");
      assertEquals(calls.filter((c) => c.method === "DELETE").length, 0);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIStructured: a polled background response is deleted after polling completes",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ backgroundQueued: true, calls }) as typeof fetch;
    try {
      await callOpenAIStructured({
        promptText: "do the thing",
        model: "gpt-5.4-mini",
        variables: {},
        input: [{ role: "user", content: "hello" }],
        structuredOutput: { name: "out", strict: true, schema: { type: "object" } },
        backgroundOptions: { enabled: true, pollIntervalMs: 1 },
      });
      const post = calls.find((c) => c.method === "POST");
      assert(post);
      assertEquals(post.body.store, true);
      assert(calls.some((c) => c.method === "GET"), "expected polling");
      assert(
        calls.some((c) => c.method === "DELETE" && c.url.endsWith("/v1/responses/resp_123")),
        "expected the stored response to be deleted after polling",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIStructured: non-background requests carry store:false by default",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ calls }) as typeof fetch;
    try {
      await callOpenAIStructured({
        promptText: "do the thing",
        model: "gpt-5.4-mini",
        variables: {},
        input: [{ role: "user", content: "hello" }],
        structuredOutput: { name: "out", strict: true, schema: { type: "object" } },
      });
      assertEquals(calls.length, 1);
      assertEquals(calls[0].body.store, false);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "streamStructuredTurn: a failed poll after id capture still deletes the stored response",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    // One `response.created` frame carrying the id, then a clean EOF with no
    // terminal event — the #1039 signature — so the helper tries to resume
    // (GET, 500s) and then to poll (GET, 500s), which throws. The regression
    // being pinned: that failure path must still delete the stored response.
    const sse = [
      "event: response.created",
      'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_bg1"}}',
      "",
      "",
    ].join("\n");
    globalThis.fetch = (async (
      url: string | Request | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = typeof url === "string"
        ? url
        : url instanceof Request
        ? url.url
        : url.toString();
      const method = (init?.method ?? (url instanceof Request ? url.method : "GET"))
        .toUpperCase();
      calls.push({ method, url: urlStr, body: null });
      if (method === "DELETE") {
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") {
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      // GET: both the resume (?stream=true) and the retrieve poll fail.
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await assertRejects(() =>
        streamStructuredTurn(
          {
            apiKey: "test-openai-key",
            model: "gpt-5.4-mini",
            instructions: "i",
            input: [{ role: "user", content: "hi" }],
            structuredOutput: { name: "out", strict: true, schema: { type: "object" } },
            onTextDelta: () => {},
          },
          { feed: () => "", getFullJson: () => "" },
        )
      );
      assert(
        calls.some((c) => c.method === "DELETE" && c.url.includes("/v1/responses/resp_bg1")),
        "a turn that failed after id capture must still delete the stored response",
      );
    } finally {
      restore();
    }
  },
);
