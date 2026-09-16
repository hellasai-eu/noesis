import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  _clearQualityInstructionCache,
  appendQualityInstruction,
  callOpenAI,
  callOpenAIStructured,
  callOpenAIWithPrompt,
} from "../openai-client.ts";
import { GREEK_QUALITY_INSTRUCTION } from "../language-utils.ts";

const originalFetch = globalThis.fetch;
const originalEnvGet = Deno.env.get;
// Supabase-js starts an internal interval (token refresh) that Deno's
// leak detector flags after the test returns. These tests create real
// supabase clients on purpose (to exercise the resolve path), so we
// disable sanitization for them.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

function setupEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    OPENAI_API_KEY: "test-openai-key",
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    ...extra,
  };
  Deno.env.get = (key: string) => env[key];
}

function restore() {
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnvGet;
  _clearQualityInstructionCache();
}

/**
 * Build a mock fetch that:
 *  - answers Supabase REST reads of /rest/v1/courses with `{ language: courseLanguage }`
 *  - answers Supabase REST reads of /rest/v1/institutions with `{ default_language: null }`
 *  - forwards /v1/responses (OpenAI) calls to `onOpenAICall` and returns `openaiResponse`
 */
function makeMockFetch(opts: {
  courseLanguage: string | null;
  openaiResponse: unknown;
  onOpenAICall: (body: any) => void;
}) {
  return async (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/rest/v1/courses")) {
      return new Response(
        JSON.stringify({ language: opts.courseLanguage, institution_id: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("/rest/v1/institutions")) {
      return new Response(
        JSON.stringify({ default_language: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (urlStr.includes("api.openai.com/v1/responses")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      opts.onOpenAICall(body);
      return new Response(
        JSON.stringify(opts.openaiResponse),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  };
}

Deno.test("appendQualityInstruction: returns base instructions when suffix missing", () => {
  assertEquals(appendQualityInstruction("base", undefined), "base");
  assertEquals(appendQualityInstruction("base", ""), "base");
});

Deno.test("appendQualityInstruction: joins with blank line when suffix present", () => {
  assertEquals(
    appendQualityInstruction("base", "extra"),
    "base\n\nextra",
  );
});

Deno.test({
  name: "callOpenAI: appends Greek quality instruction when course language is Greek",
  ...OPTS,
  fn: async () => {
    setupEnv();
    _clearQualityInstructionCache();

    let capturedBody: any = null;
    globalThis.fetch = makeMockFetch({
      courseLanguage: "el",
      openaiResponse: {
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        ],
      },
      onOpenAICall: (body) => {
        if (body.instructions !== undefined) capturedBody = body;
      },
    });

    await callOpenAI({
      model: "gpt-4.1",
      instructions: "Base system prompt",
      input: "hello",
      usageContext: { functionName: "test", courseId: "course-greek" },
    });

    assert(capturedBody, "Expected an OpenAI call to be captured");
    assert(
      capturedBody.instructions.includes("Base system prompt"),
      "Expected base instructions to be preserved",
    );
    assert(
      capturedBody.instructions.includes(GREEK_QUALITY_INSTRUCTION),
      "Expected Greek quality instruction to be appended",
    );

    restore();
  },
});

Deno.test({
  name: "callOpenAI: leaves instructions unchanged when course language is English",
  ...OPTS,
  fn: async () => {
    setupEnv();
    _clearQualityInstructionCache();

    let capturedBody: any = null;
    globalThis.fetch = makeMockFetch({
      courseLanguage: "en",
      openaiResponse: {
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
        ],
      },
      onOpenAICall: (body) => {
        if (body.instructions !== undefined) capturedBody = body;
      },
    });

    await callOpenAI({
      model: "gpt-4.1",
      instructions: "Base system prompt",
      input: "hello",
      usageContext: { functionName: "test", courseId: "course-english" },
    });

    assertEquals(capturedBody.instructions, "Base system prompt");
    restore();
  },
});

Deno.test("callOpenAI: no-op when usageContext is missing (no DB lookup)", async () => {
  setupEnv();
  _clearQualityInstructionCache();

  let dbCalled = false;
  let capturedBody: any = null;
  globalThis.fetch = async (url: string | Request | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/rest/v1/")) {
      dbCalled = true;
    }
    if (urlStr.includes("api.openai.com")) {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(
        JSON.stringify({
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("nf", { status: 404 });
  };

  await callOpenAI({
    model: "gpt-4.1",
    instructions: "Base",
    input: "hello",
  });

  assertEquals(dbCalled, false, "Should not hit the database without usageContext.courseId");
  assertEquals(capturedBody.instructions, "Base");

  restore();
});

Deno.test({
  name: "callOpenAIStructured (promptText): appends quality to instructions for Greek course",
  ...OPTS,
  fn: async () => {
    setupEnv();
    _clearQualityInstructionCache();

    let capturedBody: any = null;
    globalThis.fetch = makeMockFetch({
      courseLanguage: "el",
      openaiResponse: {
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok": true}' }] },
        ],
      },
      onOpenAICall: (body) => {
        if (body.instructions !== undefined) capturedBody = body;
      },
    });

    await callOpenAIStructured({
      promptText: "System prompt {{lang}}",
      model: "gpt-5.4-mini",
      variables: { lang: "Greek" },
      input: [{ role: "user", content: "hi" }],
      structuredOutput: {
        name: "ok_schema",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      usageContext: { functionName: "test", courseId: "course-greek" },
      retryOptions: { maxRetries: 0, initialDelayMs: 1, exponentialBackoff: false },
    });

    assert(capturedBody, "Expected OpenAI call to be captured");
    assert(capturedBody.instructions.includes("System prompt Greek"));
    assert(capturedBody.instructions.includes(GREEK_QUALITY_INSTRUCTION));
    restore();
  },
});

Deno.test({
  name: "callOpenAIStructured (promptId): prepends quality message to input for Greek course",
  ...OPTS,
  fn: async () => {
    setupEnv();
    _clearQualityInstructionCache();

    let capturedBody: any = null;
    globalThis.fetch = makeMockFetch({
      courseLanguage: "el",
      openaiResponse: {
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok": true}' }] },
        ],
      },
      onOpenAICall: (body) => {
        if (body.prompt?.id) capturedBody = body;
      },
    });

    await callOpenAIStructured({
      promptId: "saved-prompt-123",
      variables: {},
      input: [{ role: "user", content: "hello" }],
      structuredOutput: {
        name: "ok_schema",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      usageContext: { functionName: "test", courseId: "course-greek" },
      retryOptions: { maxRetries: 0, initialDelayMs: 1, exponentialBackoff: false },
    });

    assert(capturedBody, "Expected saved-prompt OpenAI call to be captured");
    assert(Array.isArray(capturedBody.input), "input should be an array");
    assertEquals(capturedBody.input[0].role, "user");
    assertEquals(capturedBody.input[0].content, [{ type: "input_text", text: GREEK_QUALITY_INSTRUCTION }]);
    // Original message follows the injected quality instruction
    assertEquals(capturedBody.input[1].content, "hello");
    restore();
  },
});

Deno.test({
  name: "callOpenAIWithPrompt: prepends quality message to input for Greek course",
  ...OPTS,
  fn: async () => {
    setupEnv();
    _clearQualityInstructionCache();

    let capturedBody: any = null;
    globalThis.fetch = makeMockFetch({
      courseLanguage: "el",
      openaiResponse: {
        output: [
          {
            type: "function_call",
            name: "noop",
            call_id: "c1",
            arguments: '{"result":"ok"}',
          },
        ],
      },
      onOpenAICall: (body) => {
        if (body.prompt?.id) capturedBody = body;
      },
    });

    await callOpenAIWithPrompt(
      { id: "saved-prompt-abc", variables: {} },
      "student question",
      { maxRetries: 0, initialDelayMs: 1, exponentialBackoff: false },
      undefined,
      undefined,
      { functionName: "test", courseId: "course-greek" },
    );

    assert(capturedBody);
    assert(Array.isArray(capturedBody.input));
    assertEquals(capturedBody.input[0].role, "user");
    assertEquals(
      capturedBody.input[0].content[0].text,
      GREEK_QUALITY_INSTRUCTION,
    );
    restore();
  },
});
