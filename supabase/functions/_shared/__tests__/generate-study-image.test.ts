/**
 * Tests for the `generate-study-image` edge function.
 *
 * The request body is the whole point here. `/v1/images/generations` rejects
 * the call outright — HTTP 400, "Unknown parameter: 'response_format'" — when
 * a gpt-image model is sent a parameter that only ever belonged to the DALL·E
 * endpoints, and a 400 from the image API surfaces to the caller as a bare
 * "Failed to generate image". So the shape of what we send is asserted
 * directly rather than inferred from a 200.
 */
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  parseResponse,
} from "./handler-harness.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const USER_ID = "user-1";

/** A 1x1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function authUserRoute(): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(JSON.stringify({ id: USER_ID, email: "u@test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function imagesRoute(
  response: unknown,
  opts?: { status?: number },
): MockRoute {
  return {
    match: (url) => url.includes("/v1/images/generations"),
    respond: () =>
      new Response(JSON.stringify(response), {
        status: opts?.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** Usage tracking writes to Supabase and must never decide the outcome. */
function usageRoute(): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/"),
    respond: () =>
      new Response("[]", { status: 201, headers: { "Content-Type": "application/json" } }),
  };
}

const invoke = (harness: ReturnType<typeof createTestHarness>) =>
  import("../../generate-study-image/handler.ts").then(({ handler }) =>
    harness.invoke(handler, { prompt: "a volcano cross-section", context: "Chapter 1" }, {
      headers: { Authorization: "Bearer caller-token" },
    })
  );

Deno.test({
  name: "generate-study-image: does not send response_format, which gpt-image rejects",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [
        authUserRoute(),
        imagesRoute({ data: [{ b64_json: PNG_B64 }] }),
        usageRoute(),
      ],
    });
    try {
      const res = await invoke(harness);
      assertEquals(res.status, 200);

      const call = harness.fetchLog.find((entry) => entry.url.includes("/v1/images/generations"));
      assert(call, "expected a call to the images endpoint");
      const body = JSON.parse(call.body ?? "{}");

      assertFalse(
        "response_format" in body,
        "gpt-image models always answer with b64_json and 400 on this parameter",
      );
      assertEquals(body.model, "gpt-image-2");
      assert(String(body.prompt).includes("a volcano cross-section"));
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "generate-study-image: returns the image as a data URI",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({
      routes: [
        authUserRoute(),
        imagesRoute({ data: [{ b64_json: PNG_B64 }] }),
        usageRoute(),
      ],
    });
    try {
      const res = await invoke(harness);
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.imageUrl, `data:image/png;base64,${PNG_B64}`);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "generate-study-image: 401 without an Authorization header",
  ...OPTS,
  async fn() {
    const harness = createTestHarness({ routes: [] });
    try {
      const { handler } = await import("../../generate-study-image/handler.ts");
      const res = await harness.invoke(handler, { prompt: "anything" });
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
    } finally {
      harness.cleanup();
    }
  },
});
