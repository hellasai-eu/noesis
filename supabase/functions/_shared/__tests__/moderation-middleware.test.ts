import { assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { withModeration, ModerationResult } from "../moderation-middleware.ts";
import { OpenAIError } from "../openai-client.ts";
import { createMockFetch, createModerationResponse, resetFetchCallCount, getFetchCallCount } from "./test-utils.ts";

// Setup: Mock global fetch and Deno.env
const originalFetch = globalThis.fetch;
const originalEnv = Deno.env.get;

Deno.test("moderation-middleware: allows unflagged input", async () => {
  resetFetchCallCount();
  
  // Mock moderation API to return unflagged
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(false),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const mockLLM = () => Promise.resolve({ assistant_text: "Hello!" });
  
  const result = await withModeration(mockLLM, "Hello, how are you?", {
    throwOnBlocked: false,
  });
  
  assertEquals(result.result.assistant_text, "Hello!");
  assertEquals(result.inputModeration?.flagged, false);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation-middleware: blocks flagged input", async () => {
  resetFetchCallCount();
  
  // Mock moderation API to return flagged
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(true, { hate: true }),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const mockLLM = () => Promise.resolve({ assistant_text: "Response" });
  
  let blockedCalled = false;
  
  await assertRejects(
    async () => {
      await withModeration(mockLLM, "inappropriate content", {
        onInputBlocked: () => {
          blockedCalled = true;
        },
        throwOnBlocked: true,
      });
    },
    OpenAIError,
    "blocked by content moderation"
  );
  
  assertEquals(blockedCalled, true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation-middleware: moderates LLM output", async () => {
  resetFetchCallCount();
  
  // Mock: input unflagged, output flagged
  let callIndex = 0;
  globalThis.fetch = async () => {
    callIndex++;
    if (callIndex === 1) {
      // Input check - unflagged
      return new Response(
        JSON.stringify(createModerationResponse(false)),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    } else {
      // Output check - flagged
      return new Response(
        JSON.stringify(createModerationResponse(true, { violence: true })),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  };
  
  Deno.env.get = () => "test-api-key";
  
  const mockLLM = () => Promise.resolve({ assistant_text: "violent content" });
  
  let outputBlockedCalled = false;
  
  await assertRejects(
    async () => {
      await withModeration(mockLLM, "normal input", {
        onOutputBlocked: () => {
          outputBlockedCalled = true;
        },
        throwOnBlocked: true,
      });
    },
    OpenAIError,
    "blocked by content moderation"
  );
  
  assertEquals(outputBlockedCalled, true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation-middleware: extracts text from different result formats", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(false),
  });
  
  Deno.env.get = () => "test-api-key";
  
  // Test assistant_text format
  const result1 = await withModeration(
    () => Promise.resolve({ assistant_text: "Hello" }),
    "test",
    { throwOnBlocked: false }
  );
  assertEquals(result1.result.assistant_text, "Hello");
  
  // Test content format
  const result2 = await withModeration(
    () => Promise.resolve({ content: "World" }),
    "test",
    { throwOnBlocked: false }
  );
  assertEquals(result2.result.content, "World");
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation-middleware: skips empty input", async () => {
  resetFetchCallCount();
  
  Deno.env.get = () => "test-api-key";
  
  // Set up a fetch mock that consumes the body to avoid leaks
  globalThis.fetch = async () => {
    const response = new Response(
      JSON.stringify(createModerationResponse(false)),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
    // Consume body to avoid leak detection
    await response.text();
    return response;
  };
  
  const mockLLM = () => Promise.resolve({ assistant_text: "Response" });
  
  const result = await withModeration(mockLLM, "", {
    throwOnBlocked: false,
  });
  
  assertEquals(result.result.assistant_text, "Response");
  assertEquals(result.inputModeration, undefined);
  assertEquals(getFetchCallCount(), 0); // No fetch should be called for empty input
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation-middleware: fail-open on moderation API error", async () => {
  resetFetchCallCount();
  
  // Mock moderation API to fail
  globalThis.fetch = createMockFetch({
    status: 500,
    body: { error: "Internal server error" },
  });
  
  Deno.env.get = () => "test-api-key";
  
  const mockLLM = () => Promise.resolve({ assistant_text: "Response" });
  
  // Should not throw, should continue (fail-open)
  const result = await withModeration(mockLLM, "test input", {
    throwOnBlocked: false,
  });
  
  assertEquals(result.result.assistant_text, "Response");
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("moderation-middleware: does not block when throwOnBlocked is false", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = createMockFetch({
    body: createModerationResponse(true, { harassment: true }),
  });
  
  Deno.env.get = () => "test-api-key";
  
  const mockLLM = () => Promise.resolve({ assistant_text: "Response" });
  
  let blockedCalled = false;
  
  // Should not throw when throwOnBlocked is false
  const result = await withModeration(mockLLM, "flagged content", {
    onInputBlocked: () => {
      blockedCalled = true;
    },
    throwOnBlocked: false,
  });
  
  assertEquals(blockedCalled, true);
  assertEquals(result.result.assistant_text, "Response");
  assertEquals(result.inputModeration?.flagged, true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

