import { assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { callOpenAIStructured, OpenAIError, OpenAIRateLimitError, OpenAIServerError } from "../openai-client.ts";
import { resetFetchCallCount, getFetchCallCount, incrementFetchCallCount } from "./test-utils.ts";

const originalFetch = globalThis.fetch;
const originalEnv = Deno.env.get;

Deno.test("openai-client: retries on 429 with exponential backoff", async () => {
  resetFetchCallCount();
  
  const callTimes: number[] = [];
  const startTime = Date.now();
  
  // Mock: fail twice with 429, then succeed
  globalThis.fetch = async () => {
    incrementFetchCallCount();
    const callCount = getFetchCallCount();
    const now = Date.now();
    callTimes.push(now - startTime);
    
    if (callCount < 3) {
      return new Response(
        JSON.stringify({ error: "Rate limited" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    
    return new Response(
      JSON.stringify({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: '{"result": "success"}',
          }],
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  
  Deno.env.get = () => "test-api-key";
  
  const result = await callOpenAIStructured({
    promptId: "test-prompt",
    variables: {},
    input: [],
    structuredOutput: {
      name: "test",
      strict: true,
      schema: { 
        type: "object", 
        properties: { result: { type: "string" } },
        required: ["result"],
        additionalProperties: false,
      },
    },
    retryOptions: {
      maxRetries: 2,
      initialDelayMs: 100, // Fast for testing
      exponentialBackoff: true,
    },
  });
  
  assertEquals(getFetchCallCount(), 3); // Initial + 2 retries
  assertEquals(result.result, "success");
  
  // Verify exponential backoff delays (with some tolerance)
  if (callTimes.length >= 3) {
    const delay1 = callTimes[1] - callTimes[0];
    const delay2 = callTimes[2] - callTimes[1];
    
    // First delay should be ~100ms, second ~200ms (with tolerance)
    assertEquals(delay1 >= 90 && delay1 <= 150, true, `Delay 1 was ${delay1}ms, expected ~100ms`);
    assertEquals(delay2 >= 190 && delay2 <= 250, true, `Delay 2 was ${delay2}ms, expected ~200ms`);
  }
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: stops after max retries", async () => {
  resetFetchCallCount();
  
  // Mock: always return 429
  globalThis.fetch = async () => {
    incrementFetchCallCount();
    return new Response(
      JSON.stringify({ error: "Rate limited" }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  };
  
  Deno.env.get = () => "test-api-key";
  
  await assertRejects(
    async () => {
      await callOpenAIStructured({
        promptId: "test-prompt",
        variables: {},
        input: [],
        structuredOutput: {
          name: "test",
          strict: true,
          schema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 50, // Fast for testing
        },
      });
    },
    OpenAIRateLimitError
  );
  
  assertEquals(getFetchCallCount(), 3); // Initial + 2 retries
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: respects custom retry options", async () => {
  resetFetchCallCount();
  
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount < 2) {
      return new Response(
        JSON.stringify({ error: "Rate limited" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: '{"done": true}' }],
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  
  Deno.env.get = () => "test-api-key";
  
  const result = await callOpenAIStructured({
    promptId: "test",
    variables: {},
    input: [],
    structuredOutput: {
      name: "test",
      strict: true,
      schema: {
        type: "object",
        properties: { done: { type: "boolean" } },
        required: ["done"],
        additionalProperties: false,
      },
    },
    retryOptions: {
      maxRetries: 1, // Only 1 retry
      initialDelayMs: 50, // Fast delay
      exponentialBackoff: false, // No exponential backoff
    },
  });
  
  assertEquals(callCount, 2); // Initial + 1 retry
  assertEquals(result.done, true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: succeeds immediately without retry", async () => {
  resetFetchCallCount();
  
  globalThis.fetch = async () => {
    incrementFetchCallCount();
    return new Response(
      JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: '{"success": true}' }],
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  
  Deno.env.get = () => "test-api-key";
  
  const result = await callOpenAIStructured({
    promptId: "test",
    variables: {},
    input: [],
    structuredOutput: {
      name: "test",
      strict: true,
      schema: {
        type: "object",
        properties: { success: { type: "boolean" } },
        required: ["success"],
        additionalProperties: false,
      },
    },
  });
  
  assertEquals(getFetchCallCount(), 1); // Only one call, no retries
  assertEquals(result.success, true);
  
  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: uses default retry options when not specified", async () => {
  resetFetchCallCount();
  
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount < 2) {
      return new Response(
        JSON.stringify({ error: "Rate limited" }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: '{"default": true}' }],
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  
  Deno.env.get = () => "test-api-key";
  
  const result = await callOpenAIStructured({
    promptId: "test",
    variables: {},
    input: [],
    structuredOutput: {
      name: "test",
      strict: true,
      schema: {
        type: "object",
        properties: { default: { type: "boolean" } },
        required: ["default"],
        additionalProperties: false,
      },
    },
    // No retryOptions - should use defaults (3 retries, 10s initial, exponential)
  });
  
  assertEquals(callCount, 2); // Initial + 1 retry (would retry more if needed)
  assertEquals(result.default, true);

  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: retries on transient 400 error (unsupported unicode)", async () => {
  resetFetchCallCount();

  globalThis.fetch = async () => {
    incrementFetchCallCount();
    const callCount = getFetchCallCount();

    if (callCount < 2) {
      return new Response(
        JSON.stringify({ error: { message: "Unsupported Unicode character" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: '{"retried": true}' }],
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  Deno.env.get = () => "test-api-key";

  const result = await callOpenAIStructured({
    promptId: "test-prompt",
    variables: {},
    input: [],
    structuredOutput: {
      name: "test",
      strict: true,
      schema: {
        type: "object",
        properties: { retried: { type: "boolean" } },
        required: ["retried"],
        additionalProperties: false,
      },
    },
    retryOptions: {
      maxRetries: 2,
      initialDelayMs: 50,
      exponentialBackoff: false,
    },
  });

  assertEquals(getFetchCallCount(), 2); // Initial + 1 retry
  assertEquals(result.retried, true);

  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: throws on non-transient 400 error without retry", async () => {
  resetFetchCallCount();

  globalThis.fetch = async () => {
    incrementFetchCallCount();
    return new Response(
      JSON.stringify({ error: { message: "Invalid request: missing required field" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  };

  Deno.env.get = () => "test-api-key";

  await assertRejects(
    async () => {
      await callOpenAIStructured({
        promptId: "test-prompt",
        variables: {},
        input: [],
        structuredOutput: {
          name: "test",
          strict: true,
          schema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 50,
        },
      });
    },
    OpenAIError,
  );

  assertEquals(getFetchCallCount(), 1); // No retries for non-transient 400

  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});

Deno.test("openai-client: exhausts retries on persistent transient 400 error", async () => {
  resetFetchCallCount();

  globalThis.fetch = async () => {
    incrementFetchCallCount();
    return new Response(
      JSON.stringify({ error: { message: "unsupported unicode character in file" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  };

  Deno.env.get = () => "test-api-key";

  await assertRejects(
    async () => {
      await callOpenAIStructured({
        promptId: "test-prompt",
        variables: {},
        input: [],
        structuredOutput: {
          name: "test",
          strict: true,
          schema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 50,
        },
      });
    },
    OpenAIServerError,
  );

  assertEquals(getFetchCallCount(), 3); // Initial + 2 retries

  // Cleanup
  globalThis.fetch = originalFetch;
  Deno.env.get = originalEnv;
});
