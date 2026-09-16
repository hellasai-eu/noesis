/**
 * Type routing in validateGeneratedAnswers (#1060).
 *
 * Only `mcq` may reach the LLM: the answer_validation prompt reasons about
 * which marked option index is correct, and the other four types have no such
 * concept. Anything that is not MCQ previously fell into that branch anyway,
 * so an ordering or fill-gaps question came back with a confident, scored,
 * persisted verdict describing a question shape the rubric had never seen.
 *
 * These tests assert the partition WITHOUT reaching the network: if a non-MCQ
 * type is routed to the LLM path, the fetch stub records a call and the test
 * fails. That is the whole property — no OpenAI request should ever be made
 * for a non-MCQ question.
 */

import { assertEquals, assert } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  validateGeneratedAnswers,
  type GeneratedQuestionForValidation,
} from "../answer-validator.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

/** Counts OpenAI calls so "did this reach the LLM?" is directly observable. */
function stubFetch() {
  const original = globalThis.fetch;
  // The validator short-circuits without a key, which would make the MCQ cases
  // pass for the wrong reason. The stub intercepts before any request leaves.
  const originalKey = Deno.env.get("OPENAI_API_KEY");
  Deno.env.set("OPENAI_API_KEY", "sk-test-not-a-real-key");
  const calls: string[] = [];

  globalThis.fetch = ((input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    // Any OpenAI hit is already a failure for the non-MCQ cases; return a shape
    // the caller can parse so the failure surfaces as an assertion, not a throw.
    return Promise.resolve(
      new Response(JSON.stringify({ output: [], status: "completed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  return {
    calls,
    openAICalls: () => calls.filter((u) => u.includes("openai.com")),
    restore: () => {
      globalThis.fetch = original;
      if (originalKey === undefined) Deno.env.delete("OPENAI_API_KEY");
      else Deno.env.set("OPENAI_API_KEY", originalKey);
    },
  };
}

function question(
  type: GeneratedQuestionForValidation["type"],
): GeneratedQuestionForValidation {
  return {
    question: `A ${type} question`,
    type,
    payload: {},
    answer_key: {},
    explanation: "",
  };
}

const NON_MCQ = ["open", "fill_gaps", "ordering", "classification"] as const;

for (const type of NON_MCQ) {
  Deno.test({
    name: `answer-validator: ${type} never reaches the MCQ LLM path`,
    ...OPTS,
    async fn() {
      const f = stubFetch();
      try {
        const result = await validateGeneratedAnswers([question(type)]);

        assertEquals(
          f.openAICalls().length,
          0,
          `${type} was sent to the LLM — it would be judged by the MCQ rubric`,
        );
        assertEquals(result.valid.length, 1, `${type} should pass through as valid`);
        assertEquals(result.filtered.length, 0);
      } finally {
        f.restore();
      }
    },
  });

  Deno.test({
    name: `answer-validator: ${type} reports that it was not validated`,
    ...OPTS,
    async fn() {
      const f = stubFetch();
      try {
        const { validationResults } = await validateGeneratedAnswers([question(type)]);
        const message = validationResults[0].verdict.message;

        // An instructor must be able to tell "checked and fine" from
        // "not checked". A bare CORRECT with no qualification cannot.
        assert(
          /not validated|no marked-index/i.test(message),
          `${type} verdict should say it was not validated, got: ${message}`,
        );
      } finally {
        f.restore();
      }
    },
  });
}

Deno.test({
  name: "answer-validator: a mixed batch routes only the MCQ rows to the LLM",
  ...OPTS,
  async fn() {
    const f = stubFetch();
    try {
      const batch = [
        question("ordering"),
        question("mcq"),
        question("fill_gaps"),
      ];

      const { validationResults } = await validateGeneratedAnswers(batch);

      // Exactly one LLM round-trip, for the single MCQ row. Two would mean a
      // non-MCQ row was routed to the rubric that cannot describe it.
      assertEquals(f.openAICalls().length, 1, "expected exactly one LLM call, for the MCQ row");

      // Results must come back in INPUT order. The partition splits the batch
      // and tracks original indices; slotting them back wrongly would attach
      // one question's verdict to another, which is worse than no verdict.
      //
      // Asserted on the question identity rather than the verdict text: when
      // the MCQ call fails, every row in the batch falls back to a shared
      // "skipped due to error" message, so verdict text would not distinguish
      // the rows. Identity does, and it is the property under test.
      assertEquals(validationResults.length, 3);
      assertEquals(
        validationResults.map((r) => r.question.question),
        ["A ordering question", "A mcq question", "A fill_gaps question"],
      );
    } finally {
      f.restore();
    }
  },
});

Deno.test({
  name: "answer-validator: an absent type still routes to MCQ, as callers predating the field expect",
  ...OPTS,
  async fn() {
    const f = stubFetch();
    try {
      await validateGeneratedAnswers([
        { question: "legacy row", payload: {}, answer_key: {}, explanation: "" },
      ]);

      assertEquals(
        f.openAICalls().length,
        1,
        "an untyped row should keep the historical MCQ behaviour",
      );
    } finally {
      f.restore();
    }
  },
});
