/**
 * What `callOpenAIStructured` records about a call, and why.
 *
 * The behaviour under test is the one the old tracker did not have: a usage row
 * per HTTP *attempt*, carrying the policy that chose the model. Before, only a
 * successful response was ever written, so a call that 429'd twice and then
 * succeeded logged one row — and the retries, the most common reason a bill
 * moves, were invisible to every cost query.
 *
 * `trackAIUsage` inserts through supabase-js, which goes out over `fetch` — the
 * same `fetch` these tests already mock — so the rows are captured by watching
 * for POSTs to /rest/v1/ai_usage_logs. Tracking is deliberately fire-and-forget
 * (a usage row must never fail a generation), hence `settle()` rather than an
 * await on the call itself.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { callOpenAIStructured, OpenAIRateLimitError } from "../openai-client.ts";
import { modelFor } from "../model-policy.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

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

const originalFetch = globalThis.fetch;
const originalEnvGet = Deno.env.get;

const ENV: Record<string, string> = {
  OPENAI_API_KEY: "test-api-key",
  SUPABASE_URL: "http://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
};

interface Harness {
  rows: Record<string, unknown>[];
  restore: () => void;
}

/**
 * @param respond called per OpenAI request with the 0-based attempt index.
 */
function harness(respond: (attempt: number) => Response): Harness {
  const rows: Record<string, unknown>[] = [];
  let attempt = 0;

  Deno.env.get = ((key: string) => ENV[key]) as typeof Deno.env.get;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("/rest/v1/ai_usage_logs")) {
      const body = JSON.parse(String(init?.body ?? "[]"));
      rows.push(...(Array.isArray(body) ? body : [body]));
      return new Response("[]", { status: 201, headers: { "Content-Type": "application/json" } });
    }

    if (url.includes("api.openai.com")) {
      return respond(attempt++);
    }

    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  return {
    rows,
    restore: () => {
      globalThis.fetch = originalFetch;
      Deno.env.get = originalEnvGet;
    },
  };
}

function ok(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      model: "gpt-5.4",
      status: "completed",
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 400 },
        output_tokens: 200,
        output_tokens_details: { reasoning_tokens: 50 },
        total_tokens: 1200,
      },
      output: [
        { type: "message", content: [{ type: "output_text", text: '{"result":"success"}' }] },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function rateLimited(): Response {
  return new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 });
}

/** Let the fire-and-forget inserts drain before asserting on them. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
}

Deno.test({
  name: "usage row carries the policy that chose the model, not just the model",
  ...OPTS,
  async fn() {
    const h = harness(ok);
    try {
      await callOpenAIStructured({
        ...modelFor("question-bank.mcq"),
        promptText: "system",
        variables: {},
        input: [{ role: "user", content: "hi" }],
        structuredOutput: SCHEMA,
        usageContext: { functionName: "generate-questions", promptKey: "mcq_generation" },
      });
      await settle();

      assertEquals(h.rows.length, 1);
      const row = h.rows[0];

      // The decision.
      assertEquals(row.feature, "question-bank");
      assertEquals(row.policy_key, "question-bank.mcq");
      assertEquals(row.model_tier, "balanced");
      assertEquals(row.policy_version, 1);
      assertEquals(row.reasoning_effort, "medium");
      assertEquals(row.model_requested, "gpt-5.4");

      // The outcome.
      assertEquals(row.outcome, "success");
      assertEquals(row.attempt_number, 0);
      assertEquals(row.input_tokens, 1000);
      assertEquals(row.input_tokens_cached, 400);
      assertEquals(row.output_tokens, 200);

      // No money anywhere on the row, by design — token counts stay true,
      // prices do not.
      assertEquals(row.estimated_cost_usd, undefined);
      assertEquals(row.pricing_as_of, undefined);
    } finally {
      h.restore();
    }
  },
});

Deno.test({
  name: "every retried attempt gets its own row, not just the one that succeeded",
  ...OPTS,
  async fn() {
    // Two 429s then a success. Before this change the two failures wrote
    // nothing at all, so a rate-limit storm looked like ordinary traffic.
    const h = harness((attempt) => (attempt < 2 ? rateLimited() : ok()));
    try {
      await callOpenAIStructured({
        ...modelFor("tutoring.study-tutor"),
        promptText: "system",
        variables: {},
        input: [{ role: "user", content: "hi" }],
        structuredOutput: SCHEMA,
        usageContext: { functionName: "study-tutor" },
        retryOptions: { maxRetries: 2, initialDelayMs: 1, exponentialBackoff: false },
      });
      await settle();

      assertEquals(h.rows.length, 3);
      assertEquals(
        h.rows.map((r) => r.outcome),
        ["rate_limited", "rate_limited", "success"],
      );
      assertEquals(
        h.rows.map((r) => r.attempt_number),
        [0, 1, 2],
      );
      // Every attempt is attributed to the same decision, so summing by policy
      // captures the retries rather than only the attempt that worked.
      for (const row of h.rows) {
        assertEquals(row.policy_key, "tutoring.study-tutor");
        assertEquals(row.feature, "tutoring");
      }
      // A failed attempt records the status that caused it.
      assertEquals(h.rows[0].http_status, 429);
    } finally {
      h.restore();
    }
  },
});

Deno.test({
  name: "a call that exhausts its retries still leaves a trail",
  ...OPTS,
  async fn() {
    const h = harness(rateLimited);
    try {
      await assertRejects(
        () =>
          callOpenAIStructured({
            ...modelFor("grading.open-answer-draft"),
            promptText: "system",
            variables: {},
            input: [{ role: "user", content: "hi" }],
            structuredOutput: SCHEMA,
            usageContext: { functionName: "submit-open-answer" },
            retryOptions: { maxRetries: 1, initialDelayMs: 1, exponentialBackoff: false },
          }),
        OpenAIRateLimitError,
      );
      await settle();

      // The whole call failed and returned nothing, which is exactly when the
      // old tracker recorded nothing — leaving the wasted spend unexplainable.
      assertEquals(h.rows.length, 2);
      assertEquals(new Set(h.rows.map((r) => r.outcome)), new Set(["rate_limited"]));
    } finally {
      h.restore();
    }
  },
});

Deno.test({
  name: "an overridden reasoning effort is recorded as sent, beside its policy",
  ...OPTS,
  async fn() {
    // study-tutor scales effort per turn. The billed figure is the effort
    // actually sent, so that is what the row carries — while policy_key still
    // names the policy it departed from.
    const h = harness(ok);
    try {
      await callOpenAIStructured({
        ...modelFor("tutoring.study-tutor"),
        reasoningEffort: "high",
        promptText: "system",
        variables: {},
        input: [{ role: "user", content: "hi" }],
        structuredOutput: SCHEMA,
        usageContext: { functionName: "study-tutor" },
      });
      await settle();

      assertEquals(h.rows[0].reasoning_effort, "high");
      assertEquals(h.rows[0].policy_key, "tutoring.study-tutor");
    } finally {
      h.restore();
    }
  },
});

Deno.test({
  name: "file attachments are counted, so the inline fallback is identifiable",
  ...OPTS,
  async fn() {
    // The flashcard and cheatsheet generators fall back to inlining up to 500k
    // characters when a chapter has no openai_file_id. Both branches use the
    // same model, so file_count = 0 is the only thing that distinguishes the
    // expensive path from the cheap one.
    const h = harness(ok);
    try {
      await callOpenAIStructured({
        ...modelFor("materials.flashcards"),
        promptText: "system",
        variables: {},
        input: [{ role: "user", content: "hi" }],
        fileIds: ["file-a", "file-b"],
        structuredOutput: SCHEMA,
        usageContext: { functionName: "generate-flashcards" },
      });
      await settle();

      assertEquals(h.rows[0].file_count, 2);
      assertEquals(h.rows[0].background_mode, false);
    } finally {
      h.restore();
    }
  },
});

Deno.test({
  name: "no usage context means no rows — tracking stays opt-in",
  ...OPTS,
  async fn() {
    const h = harness(ok);
    try {
      await callOpenAIStructured({
        ...modelFor("question-bank.mcq"),
        promptText: "system",
        variables: {},
        input: [{ role: "user", content: "hi" }],
        structuredOutput: SCHEMA,
      });
      await settle();

      assertEquals(h.rows.length, 0);
    } finally {
      h.restore();
    }
  },
});

Deno.test({
  name: "an incomplete response is its own attempt, then retried",
  ...OPTS,
  async fn() {
    // An incomplete response hit the output ceiling: it burned its output
    // tokens, was billed in full, and is about to be retried. Folding both
    // attempts into one row would understate the call by exactly the tokens
    // that were wasted.
    const incomplete = () =>
      new Response(
        JSON.stringify({
          id: "resp_incomplete",
          model: "gpt-5.4",
          status: "incomplete",
          usage: { input_tokens: 1000, output_tokens: 8000, total_tokens: 9000 },
          output: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const h = harness((attempt) => (attempt === 0 ? incomplete() : ok()));
    try {
      await callOpenAIStructured({
        ...modelFor("question-bank.mcq"),
        promptText: "system",
        variables: {},
        input: [{ role: "user", content: "hi" }],
        structuredOutput: SCHEMA,
        usageContext: { functionName: "generate-questions" },
        retryOptions: { maxRetries: 1, initialDelayMs: 1, exponentialBackoff: false },
      });
      await settle();

      assertEquals(h.rows.length, 2);
      assertEquals(h.rows[0].outcome, "incomplete");
      assertEquals(h.rows[0].output_tokens, 8000);
      assertEquals(h.rows[1].outcome, "success");
      assert(
        (h.rows[0].output_tokens as number) > (h.rows[1].output_tokens as number),
        "the discarded attempt burned more output than the one that worked — the point of logging it",
      );
    } finally {
      h.restore();
    }
  },
});
