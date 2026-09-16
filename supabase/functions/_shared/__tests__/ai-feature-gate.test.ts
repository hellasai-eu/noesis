/**
 * Per-school AI feature toggles (`institutions.ai_features_disabled`, G8).
 *
 * The gate lives at the OpenAI chokepoint: a call whose model-policy family
 * the calling school has switched off must throw AiFeatureDisabledError
 * before anything is sent. Failure direction is availability: unattributable
 * calls and failed flag reads run.
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  _clearQualityInstructionCache,
  AiFeatureDisabledError,
  callOpenAIStructured,
} from "../openai-client.ts";
import {
  _clearAiFeatureGateCache,
  disabledFamilyFor,
  familyForPolicyKey,
} from "../ai-feature-gate.ts";
import { _clearOpenAIStoreCache } from "../openai-retention.ts";
import { modelFor } from "../model-policy.ts";

const originalFetch = globalThis.fetch;
const originalEnvGet = Deno.env.get;
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
  _clearAiFeatureGateCache();
}

interface RecordedCall {
  method: string;
  url: string;
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

function makeMockFetch(opts: {
  disabled?: string[];
  flagLookupFails?: boolean;
  courseInstitutionId?: string | null;
  calls: RecordedCall[];
}) {
  return (url: string | Request | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === "string" ? url : url.toString();
    const json = (payload: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );

    if (urlStr.includes("/rest/v1/institutions") && urlStr.includes("ai_features_disabled")) {
      if (opts.flagLookupFails) return json({ message: "boom" }, 500);
      return json({ ai_features_disabled: opts.disabled ?? [] });
    }
    if (urlStr.includes("/rest/v1/institutions") && urlStr.includes("openai_store_enabled")) {
      return json({ openai_store_enabled: false });
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
      opts.calls.push({ method: init?.method ?? "GET", url: urlStr });
      return json(OPENAI_MESSAGE_RESPONSE);
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };
}

Deno.test("familyForPolicyKey: namespaces map to school-facing families", () => {
  assertEquals(familyForPolicyKey("tutoring.study-tutor"), "tutoring");
  assertEquals(familyForPolicyKey("grading.open-answer-draft"), "grading");
  assertEquals(familyForPolicyKey("analytics.cluster-students"), "analytics");
  assertEquals(familyForPolicyKey("question-bank.mcq"), "generation");
  assertEquals(familyForPolicyKey("study-guide.theory"), "generation");
  assertEquals(familyForPolicyKey("materials.flashcards"), "generation");
  // Safety screening is never a toggle, and unknown namespaces are ungated.
  assertEquals(familyForPolicyKey("moderation.study-image"), null);
  assertEquals(familyForPolicyKey("something.new"), null);
  assertEquals(familyForPolicyKey(undefined), null);
});

Deno.test(
  "callOpenAIStructured: a disabled family throws before anything reaches OpenAI",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ disabled: ["generation"], calls }) as typeof fetch;
    try {
      await assertRejects(
        () =>
          callOpenAIStructured({
            ...modelFor("question-bank.mcq"),
            promptText: "generate",
            variables: {},
            input: [{ role: "user", content: "hello" }],
            structuredOutput: { name: "out", strict: true, schema: { type: "object" } },
            usageContext: { functionName: "test", institutionId: "inst-1" },
          }),
        AiFeatureDisabledError,
      );
      assertEquals(calls.length, 0, "nothing may be sent to OpenAI for a disabled family");
    } finally {
      restore();
    }
  },
);

Deno.test(
  "callOpenAIStructured: an enabled family proceeds, and other families' toggles do not interfere",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ disabled: ["tutoring"], calls }) as typeof fetch;
    try {
      await callOpenAIStructured({
        ...modelFor("question-bank.mcq"),
        promptText: "generate",
        variables: {},
        input: [{ role: "user", content: "hello" }],
        structuredOutput: { name: "out", strict: true, schema: { type: "object" } },
        usageContext: { functionName: "test", institutionId: "inst-1" },
      });
      assertEquals(calls.length, 1);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "disabledFamilyFor: resolves the institution through courseId",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({
      disabled: ["analytics"],
      courseInstitutionId: "inst-1",
      calls,
    }) as typeof fetch;
    try {
      assertEquals(
        await disabledFamilyFor(modelFor("analytics.quiz").policy, { courseId: "course-1" }),
        "analytics",
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "disabledFamilyFor: a failed flag read allows the call (availability over enforcement)",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({ flagLookupFails: true, calls }) as typeof fetch;
    try {
      assertEquals(
        await disabledFamilyFor(modelFor("grading.open-answer-draft").policy, {
          institutionId: "inst-1",
        }),
        null,
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "disabledFamilyFor: unattributable calls and moderation are never gated",
  OPTS,
  async () => {
    setupEnv();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeMockFetch({
      disabled: ["tutoring", "grading", "analytics", "generation"],
      calls,
    }) as typeof fetch;
    try {
      // No institution and no course: nothing to attribute the call to.
      assertEquals(
        await disabledFamilyFor(modelFor("grading.open-answer-draft").policy, undefined),
        null,
      );
      // Safety screening stays on even when the school disabled everything.
      assertEquals(
        await disabledFamilyFor(modelFor("moderation.study-image").policy, {
          institutionId: "inst-1",
        }),
        null,
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "AiFeatureDisabledError: names the family and is not retryable",
  () => {
    const err = new AiFeatureDisabledError("tutoring");
    assert(err.message.includes("tutoring"));
    assertEquals(err.statusCode, 403);
    assertEquals(err.isRetryable, false);
  },
);
