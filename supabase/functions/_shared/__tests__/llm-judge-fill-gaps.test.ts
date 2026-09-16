import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { judgeFillGapsWithLLM } from "../llm-judge-fill-gaps.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

interface FetchCall {
  url: string;
  body: string | undefined;
}

function installMockFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
): { log: FetchCall[]; restore: () => void } {
  const log: FetchCall[] = [];
  const savedFetch = globalThis.fetch;
  const savedEnvGet = Deno.env.get;
  Deno.env.get = (key: string) =>
    key === "OPENAI_API_KEY" ? "test-key" : savedEnvGet(key);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const call = { url, body };
    log.push(call);
    return await responder(call);
  };
  return {
    log,
    restore() {
      globalThis.fetch = savedFetch;
      Deno.env.get = savedEnvGet;
    },
  };
}

function llmResponse(verdicts: Array<{ ordinal: number; equivalent: boolean }>): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            verdicts: verdicts.map((v) => ({
              ordinal: v.ordinal,
              equivalent: v.equivalent,
              reason: "",
            })),
          }),
        }],
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

Deno.test({
  name: "judgeFillGapsWithLLM: no LLM call when every gap exact-matches",
  ...OPTS,
  async fn() {
    const mock = installMockFetch(() => {
      throw new Error("LLM must not be called when nothing needs judging");
    });
    try {
      const result = await judgeFillGapsWithLLM({
        stem: "{{1}} and {{2}}",
        gaps: [
          { ordinal: 1, acceptable: ["alpha"] },
          { ordinal: 2, acceptable: ["beta"] },
        ],
        submitted: ["alpha", "beta"],
        exactPerGap: [true, true],
      });
      assertEquals(result.perGap, [true, true]);
      assertEquals(result.llmCallMade, false);
      assertEquals(result.llmFailed, false);
      assertEquals(mock.log.length, 0);
    } finally {
      mock.restore();
    }
  },
});

Deno.test({
  name: "judgeFillGapsWithLLM: upgrades a synonym to correct via one batched call",
  ...OPTS,
  async fn() {
    const mock = installMockFetch(() =>
      llmResponse([{ ordinal: 2, equivalent: true }])
    );
    try {
      const result = await judgeFillGapsWithLLM({
        stem: "{{1}} and {{2}}",
        gaps: [
          { ordinal: 1, acceptable: ["alpha"] },
          { ordinal: 2, acceptable: ["beta"] },
        ],
        // Student typed a synonym for beta. Exact matcher rejects.
        submitted: ["alpha", "beta-synonym"],
        exactPerGap: [true, false],
      });
      assertEquals(result.perGap, [true, true]);
      assertEquals(result.llmCallMade, true);
      assertEquals(result.llmFailed, false);
      // Exactly one outbound call — the batch.
      assertEquals(mock.log.length, 1);
      // The student's input is in the prompt; ordinal 1 is NOT (it already matched).
      const body = mock.log[0].body!;
      assertEquals(body.includes("beta-synonym"), true);
      assertEquals(body.includes("ordinal=2"), true);
      assertEquals(body.includes("ordinal=1"), false);
    } finally {
      mock.restore();
    }
  },
});

Deno.test({
  name: "judgeFillGapsWithLLM: empty submission is never judged",
  ...OPTS,
  async fn() {
    const mock = installMockFetch(() => {
      throw new Error("LLM must not be called for empty submissions");
    });
    try {
      const result = await judgeFillGapsWithLLM({
        stem: "{{1}} {{2}}",
        gaps: [
          { ordinal: 1, acceptable: ["alpha"] },
          { ordinal: 2, acceptable: ["beta"] },
        ],
        submitted: ["alpha", "   "],
        exactPerGap: [true, false],
      });
      assertEquals(result.perGap, [true, false]);
      assertEquals(result.llmCallMade, false);
      assertEquals(result.llmFailed, false);
      assertEquals(mock.log.length, 0);
    } finally {
      mock.restore();
    }
  },
});

Deno.test({
  name: "judgeFillGapsWithLLM: LLM failure falls back to exact-match result",
  ...OPTS,
  async fn() {
    const mock = installMockFetch(() =>
      new Response("oops", { status: 500 })
    );
    try {
      const result = await judgeFillGapsWithLLM({
        stem: "{{1}}",
        gaps: [{ ordinal: 1, acceptable: ["alpha"] }],
        submitted: ["totally-different"],
        exactPerGap: [false],
      });
      // Original exact-match result preserved; flag set.
      assertEquals(result.perGap, [false]);
      assertEquals(result.llmCallMade, true);
      assertEquals(result.llmFailed, true);
    } finally {
      mock.restore();
    }
  },
});

Deno.test({
  name: "judgeFillGapsWithLLM: equivalent=false from the LLM leaves the gap wrong",
  ...OPTS,
  async fn() {
    const mock = installMockFetch(() =>
      llmResponse([{ ordinal: 1, equivalent: false }])
    );
    try {
      const result = await judgeFillGapsWithLLM({
        stem: "{{1}}",
        gaps: [{ ordinal: 1, acceptable: ["paris"] }],
        submitted: ["berlin"],
        exactPerGap: [false],
      });
      assertEquals(result.perGap, [false]);
      assertEquals(result.llmCallMade, true);
      assertEquals(result.llmFailed, false);
    } finally {
      mock.restore();
    }
  },
});

Deno.test({
  name: "judgeFillGapsWithLLM: verdict for an unrelated ordinal is ignored",
  ...OPTS,
  async fn() {
    const mock = installMockFetch(() =>
      // The model hallucinates ordinal 99 — must not bleed into our result.
      llmResponse([
        { ordinal: 99, equivalent: true },
        { ordinal: 1, equivalent: true },
      ])
    );
    try {
      const result = await judgeFillGapsWithLLM({
        stem: "{{1}}",
        gaps: [{ ordinal: 1, acceptable: ["paris"] }],
        submitted: ["Paris,"],
        exactPerGap: [false],
      });
      assertEquals(result.perGap, [true]);
      assertEquals(result.llmCallMade, true);
      assertEquals(result.llmFailed, false);
    } finally {
      mock.restore();
    }
  },
});
