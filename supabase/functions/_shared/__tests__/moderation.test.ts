import { assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { CHAT_MODERATION_THRESHOLDS, MODERATION_MODEL, moderateContent } from "../moderation.ts";
import { createMockFetch, createModerationResponse, resetFetchCallCount } from "./test-utils.ts";

const originalFetch = globalThis.fetch;
const originalEnv = Deno.env.get;

Deno.test("moderation: returns flagged result", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(true, { hate: true, harassment: true }),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const result = await moderateContent({ content: "test content" });
  
  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories.includes("hate"), true);
  assertEquals(result.flaggedCategories.includes("harassment"), true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation: returns unflagged result", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(false),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const result = await moderateContent({ content: "normal content" });
  
  assertEquals(result.flagged, false);
  assertEquals(result.flaggedCategories.length, 0);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation: handles array input", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(false),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const result = await moderateContent({
    content: ["line 1", "line 2", "line 3"],
  });
  
  assertEquals(result.flagged, false);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation: throws on API error", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    status: 401,
    body: { error: "Unauthorized" },
  });
  
  Deno.env.get = () => "test-api-key";
  
  await assertRejects(
    async () => {
      await moderateContent({ content: "test" });
    },
    Error,
    "Moderation API error"
  );
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation: includes category scores", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(true, { violence: true }),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const result = await moderateContent({ content: "test" });
  
  assertEquals(result.flagged, true);
  assertEquals(typeof result.categoryScores.violence, "number");
  assertEquals(result.categoryScores.violence > 0, true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation: uses custom API key when provided", async () => {
  resetFetchCallCount();
  
  let receivedAuth = "";
  globalThis.fetch = async (url: string | Request | URL, init?: RequestInit) => {
    if (init?.headers) {
      // Handle both Headers object and plain object
      if (init.headers instanceof Headers) {
        receivedAuth = init.headers.get("Authorization") || "";
      } else {
        // Plain object case
        const headersObj = init.headers as Record<string, string>;
        receivedAuth = headersObj["Authorization"] || "";
      }
    }
    return new Response(
      JSON.stringify(createModerationResponse(false)),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  
  Deno.env.get = () => undefined; // No env var
  
  await moderateContent({ 
    content: "test",
    apiKey: "custom-key-123"
  });
  
  assertEquals(receivedAuth.includes("custom-key-123"), true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});


// ── Model selection ──────────────────────────────────────────────────────────

Deno.test("moderation: asks for the omni model rather than the API default", async () => {
  resetFetchCallCount();

  let requestedModel: unknown = undefined;
  globalThis.fetch = async (_url: string | Request | URL, init?: RequestInit) => {
    requestedModel = JSON.parse(String(init?.body)).model;
    return new Response(
      JSON.stringify(createModerationResponse(false)),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  Deno.env.get = () => "test-api-key";

  await moderateContent({ content: "test" });

  assertEquals(requestedModel, "omni-moderation-latest");
  assertEquals(requestedModel, MODERATION_MODEL);

  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

// ── Category thresholds ──────────────────────────────────────────────────────

/**
 * `createModerationResponse` pins every flagged category to 0.9, which is above
 * all three classroom thresholds. Threshold behaviour needs the scores chosen
 * per test, so these build the payload directly.
 */
function scoredModerationResponse(scores: Record<string, number>) {
  const base = createModerationResponse(false);
  const categories = { ...base.results[0].categories } as Record<string, boolean>;
  const categoryScores = { ...base.results[0].category_scores } as Record<string, number>;

  for (const [category, score] of Object.entries(scores)) {
    categories[category] = true;
    categoryScores[category] = score;
  }

  return {
    ...base,
    results: [{ flagged: true, categories, category_scores: categoryScores }],
  };
}

function mockModeration(scores: Record<string, number>) {
  resetFetchCallCount();
  globalThis.fetch = createMockFetch({ body: scoredModerationResponse(scores) });
  Deno.env.get = () => "test-api-key";
}

function restore() {
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
}

Deno.test("moderation: tolerates a low-scoring violence flag under the chat thresholds", async () => {
  mockModeration({ violence: 0.55 });

  const result = await moderateContent({
    content: "why did the Second World War start",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  assertEquals(result.flagged, false);
  assertEquals(result.flaggedCategories, []);
  assertEquals(result.suppressedCategories, ["violence"]);
  // The raw verdict survives for the audit trail even though it did not block.
  assertEquals(result.categories.violence, true);

  restore();
});

Deno.test("moderation: still blocks a violence flag above its threshold", async () => {
  mockModeration({ violence: 0.95 });

  const result = await moderateContent({
    content: "test",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories, ["violence"]);
  assertEquals(result.suppressedCategories, []);

  restore();
});

Deno.test("moderation: a score exactly at the threshold still blocks", async () => {
  mockModeration({ hate: CHAT_MODERATION_THRESHOLDS.hate });

  const result = await moderateContent({
    content: "test",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories, ["hate"]);

  restore();
});

Deno.test("moderation: an untuned category blocks even when a tuned one is tolerated", async () => {
  mockModeration({ violence: 0.4, "sexual/minors": 0.4 });

  const result = await moderateContent({
    content: "test",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories, ["sexual/minors"]);
  assertEquals(result.suppressedCategories, ["violence"]);

  restore();
});

Deno.test("moderation: thresholds only loosen the two categories they name", async () => {
  mockModeration({ "self-harm/intent": 0.4, "harassment/threatening": 0.4 });

  const result = await moderateContent({
    content: "test",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  // Neither is in the map, so both keep OpenAI's own threshold — including the
  // whole `harassment` family, which no longer has an entry at all.
  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories.includes("self-harm/intent"), true);
  assertEquals(result.flaggedCategories.includes("harassment/threatening"), true);
  assertEquals(result.suppressedCategories, []);

  restore();
});

Deno.test("moderation: a pupil abusing the tutor blocks rather than being tolerated", async () => {
  // The score `omni-moderation-latest` actually returned for "fuck you", which
  // the old `harassment: 0.85` ceiling tolerated: OpenAI flagged it, the gate
  // did not, and the lesson continued with nobody told. `harassment` carries no
  // ceiling now, so OpenAI's own verdict stands.
  mockModeration({ harassment: 0.842 });

  const result = await moderateContent({
    content: "fuck you",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories, ["harassment"]);
  assertEquals(result.suppressedCategories, []);

  restore();
});

Deno.test("moderation: without thresholds the API verdict passes through verbatim", async () => {
  mockModeration({ violence: 0.4 });

  const result = await moderateContent({ content: "test" });

  assertEquals(result.flagged, true);
  assertEquals(result.flaggedCategories, ["violence"]);
  assertEquals(result.suppressedCategories, []);

  restore();
});

Deno.test("moderation: thresholds never turn a clean verdict into a flag", async () => {
  resetFetchCallCount();
  globalThis.fetch = createMockFetch({ body: createModerationResponse(false) });
  Deno.env.get = () => "test-api-key";

  const result = await moderateContent({
    content: "test",
    thresholds: CHAT_MODERATION_THRESHOLDS,
  });

  assertEquals(result.flagged, false);
  assertEquals(result.suppressedCategories, []);

  restore();
});
