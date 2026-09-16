// Log LEVELS for OpenAI call failures.
//
// Every retry loop in openai-client.ts used to emit logError("OpenAI API
// error") on EVERY attempt — including attempts that then succeeded on retry.
// A 429 the next attempt recovers from is invisible to the caller and to the
// student, so recording it at `error` inflated the error rate and would make
// any error-rate alert or SLO fire on healthy traffic.
//
// Separately, retry EXHAUSTION emitted no log at all: it just threw. "Failed
// on the first try" and "gave up after 3 attempts and 70s of backoff" were
// indistinguishable in the logs.
//
// These tests pin both. They assert on the console level actually used, since
// that is the thing an alert would key on.

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { callOpenAIStructured, OpenAIError, OpenAIRateLimitError } from "../openai-client.ts";
import { resetFetchCallCount, getFetchCallCount, incrementFetchCallCount } from "./test-utils.ts";

const originalFetch = globalThis.fetch;
const originalEnv = Deno.env.get;

interface Captured {
  errors: string[];
  warns: string[];
  logs: string[];
}

/** Capture console output by level for the duration of `fn`. */
async function capture(fn: () => Promise<void>): Promise<Captured> {
  const out: Captured = { errors: [], warns: [], logs: [] };
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    debug: console.debug,
  };
  const render = (args: unknown[]) =>
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  console.error = (...a: unknown[]) => out.errors.push(render(a));
  console.warn = (...a: unknown[]) => out.warns.push(render(a));
  console.log = (...a: unknown[]) => out.logs.push(render(a));
  console.debug = () => {};
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return out;
}

/**
 * Install the global mocks, run `fn`, and ALWAYS put the globals back.
 *
 * The restoration has to be in a `finally`. With a bare restore-after-await,
 * an assertion or an unexpected rejection escaping `fn` skips it, and every
 * later test in this file silently inherits the leaked `fetch` / `env` —
 * turning one real failure into a cascade of misleading ones.
 */
async function withMockedOpenAI(
  fetchImpl: typeof globalThis.fetch,
  fn: () => Promise<void>,
): Promise<Captured> {
  resetFetchCallCount();
  globalThis.fetch = fetchImpl;
  Deno.env.get = () => "test-api-key";
  try {
    return await capture(fn);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.get = originalEnv;
  }
}

/** Run the call and hand back whatever it threw, if anything. */
async function callCapturingThrow(
  retryOptions: { maxRetries: number; initialDelayMs: number },
): Promise<unknown> {
  try {
    await call(retryOptions);
    return undefined;
  } catch (e) {
    return e;
  }
}

const SCHEMA = {
  name: "test",
  strict: true,
  schema: {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  },
};

function successBody() {
  return new Response(
    JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: '{"result":"ok"}' }] }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function call(retryOptions: { maxRetries: number; initialDelayMs: number }) {
  return callOpenAIStructured({
    promptId: "test-prompt",
    variables: {},
    input: [],
    structuredOutput: SCHEMA,
    retryOptions,
  });
}

// ── The core fix ───────────────────────────────────────────────────────

Deno.test("log levels: a 429 that succeeds on retry logs NO error", async () => {
  const out = await withMockedOpenAI(
    async () => {
      incrementFetchCallCount();
      return getFetchCallCount() < 3
        ? new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 })
        : successBody();
    },
    async () => {
      await call({ maxRetries: 3, initialDelayMs: 20 });
    },
  );

  // The whole point: the caller got a successful result, so nothing in this
  // request is an error. Two transient 429s must not show up as two errors.
  assertEquals(
    out.errors.filter((l) => l.includes("OpenAI API error")),
    [],
    "a recovered retry still logged at error level",
  );
  // They are still visible — at warn, where a human can see the retry pressure
  // without an alert firing.
  const retryWarns = out.warns.filter((l) => l.includes("OpenAI API error — retrying"));
  assertEquals(retryWarns.length, 2);
  assert(retryWarns[0].includes("rate_limited"), "missing failure_class");
  assert(retryWarns[0].includes("retry_in_ms"), "missing retry delay in metadata");
});

Deno.test("log levels: exhausted retries log exactly one error, with the attempt count", async () => {
  let threw: unknown;
  const out = await withMockedOpenAI(
    async () => {
      incrementFetchCallCount();
      return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 });
    },
    async () => {
      threw = await callCapturingThrow({ maxRetries: 2, initialDelayMs: 20 });
    },
  );

  assert(threw instanceof OpenAIRateLimitError, "expected the rate-limit error to propagate");

  // Exactly one error for the whole failed call — not one per attempt.
  const errors = out.errors.filter((l) => l.includes("OpenAI API error"));
  assertEquals(errors.length, 1);
  assert(errors[0].includes("retries exhausted"), "giving up should say so");
  // 3 attempts = initial + 2 retries. This is the signal that used to be
  // missing entirely: you can now tell a first-try failure from a long,
  // expensive one.
  assert(errors[0].includes('"attempts_made":3'), `attempts_made missing: ${errors[0]}`);
  // The two attempts that were followed by a retry stay at warn.
  assertEquals(out.warns.filter((l) => l.includes("OpenAI API error — retrying")).length, 2);
});

Deno.test("log levels: a non-retryable failure errors immediately and is not called exhausted", async () => {
  let threw: unknown;
  const out = await withMockedOpenAI(
    async () => {
      incrementFetchCallCount();
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    },
    async () => {
      threw = await callCapturingThrow({ maxRetries: 3, initialDelayMs: 20 });
    },
  );

  assert(threw instanceof OpenAIError, "expected the error to propagate");
  assertEquals(getFetchCallCount(), 1, "a plain 400 must not be retried");

  const errors = out.errors.filter((l) => l.includes("OpenAI API error"));
  assertEquals(errors.length, 1);
  assert(errors[0].includes('"failure_class":"fatal"'), `wrong class: ${errors[0]}`);
  // Nothing was exhausted — no retry was ever on offer for this class.
  assert(!errors[0].includes("retries exhausted"), "a fatal 400 is not an exhaustion");
  assertEquals(out.warns.filter((l) => l.includes("OpenAI API error")).length, 0);
});

Deno.test("log levels: a transient 400 that recovers logs no error", async () => {
  const out = await withMockedOpenAI(
    async () => {
      incrementFetchCallCount();
      return getFetchCallCount() < 2
        ? new Response(JSON.stringify({ error: "unsupported unicode in input" }), { status: 400 })
        : successBody();
    },
    async () => {
      await call({ maxRetries: 2, initialDelayMs: 20 });
    },
  );

  assertEquals(out.errors.filter((l) => l.includes("OpenAI API error")), []);
  const warns = out.warns.filter((l) => l.includes("OpenAI API error — retrying"));
  assertEquals(warns.length, 1);
  assert(warns[0].includes("transient_400"), `wrong class: ${warns[0]}`);
});

Deno.test("log levels: a multi-kilobyte provider error is truncated in the log line", async () => {
  const huge = "x".repeat(20000);
  const out = await withMockedOpenAI(
    async () => {
      incrementFetchCallCount();
      return new Response(huge, { status: 400 });
    },
    async () => {
      await callCapturingThrow({ maxRetries: 0, initialDelayMs: 20 });
    },
  );

  const line = out.errors.find((l) => l.includes("OpenAI API error"));
  assert(line, "expected an error line");
  assert(line!.includes("chars total"), "expected a truncation marker");
  // Well under the raw 20k; the log line carries surrounding metadata too.
  assert(line!.length < 2000, `log line was ${line!.length} chars — not truncated`);
});

// The leak Greptile flagged, pinned: if a test body throws, the globals must
// still be restored, or every later test in the file inherits the mock.
Deno.test("log levels: mocks are restored even when the test body throws", async () => {
  const sentinel = new Error("boom");
  let caught: unknown;
  try {
    await withMockedOpenAI(
      async () => new Response("{}", { status: 200 }),
      async () => {
        throw sentinel;
      },
    );
  } catch (e) {
    caught = e;
  }

  assertEquals(caught, sentinel);
  assertEquals(globalThis.fetch, originalFetch, "fetch leaked out of a failing test");
  assertEquals(Deno.env.get, originalEnv, "Deno.env.get leaked out of a failing test");
});
