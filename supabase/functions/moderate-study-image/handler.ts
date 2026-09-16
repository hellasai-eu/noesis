import { withLogging, logger } from "../_shared/logger.ts";
import { requireCaller } from "../_shared/require-caller.ts";
import { render } from "../_shared/render.ts";
import { MODERATE_IMAGE_SYSTEM_PROMPT, MODERATE_IMAGE_USER_PROMPT } from "../_shared/prompts/moderate-study-image.ts";
import { modelFor } from "../_shared/model-policy.ts";
import {
  createUsageContext,
  extractUsageData,
  failedAttemptUsage,
  outcomeForStatus,
  trackAIUsage,
} from "../_shared/usage-tracker.ts";

// This function posts to /v1/responses directly rather than through
// openai-client, because it sends an `input_image` part that the shared client
// does not model. That is why it was the one billable call absent from
// ai_usage_logs entirely; the tracking below is done by hand for the same
// reason, and must be kept in step with what the client does.
const MODERATION_POLICY = modelFor("moderation.study-image");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Decision = "ALLOW" | "REJECT";

type ReasonCategory =
  | "OK"
  | "NUDITY_SEXUAL"
  | "MINOR_SEXUAL"
  | "VIOLENCE_GORE"
  | "SELF_HARM"
  | "HATE_EXTREMISM"
  | "HARASSMENT"
  | "ILLEGAL_DRUGS"
  | "CRIME_INSTRUCTIONS"
  | "PII_Doxxing"
  | "OTHER_UNSAFE"
  | "AMBIGUOUS_UNSAFE";

interface ModerationResult {
  decision: Decision;
  reason_category: ReasonCategory;
  confidence: number;
  description: string;
  notes: string;
}

const MODERATION_OUTPUT_SCHEMA = {
  name: "content_decision",
  strict: true,
  schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["ALLOW", "REJECT"],
        description: "ALLOW or REJECT the content.",
      },
      reason_category: {
        type: "string",
        enum: [
          "OK",
          "NUDITY_SEXUAL",
          "MINOR_SEXUAL",
          "VIOLENCE_GORE",
          "SELF_HARM",
          "HATE_EXTREMISM",
          "HARASSMENT",
          "ILLEGAL_DRUGS",
          "CRIME_INSTRUCTIONS",
          "PII_Doxxing",
          "OTHER_UNSAFE",
          "AMBIGUOUS_UNSAFE",
        ],
        description: "A high-level category explaining the core rationale for the decision.",
      },
      confidence: {
        type: "number",
        description: "Confidence in the decision, from 0 (low) to 1 (high).",
      },
      description: {
        type: "string",
        description: "If ALLOW: 1–2 sentence neutral description. If REJECT: empty string.",
      },
      notes: {
        type: "string",
        description: "Short internal note (max ~20 words) explaining decision; no sensitive speculation.",
      },
    },
    required: ["decision", "reason_category", "confidence", "description", "notes"],
    additionalProperties: false,
  },
};

// Call OpenAI with local prompt, image URL, and structured output
async function callWithImageUrl({
  apiKey,
  imageUrl,
  lang,
}: {
  apiKey: string;
  imageUrl: string;
  lang: string;
}): Promise<ModerationResult> {
  const userMessage = render(MODERATE_IMAGE_USER_PROMPT, {
    lang,
    image_url: imageUrl,
  });

  const body = {
    model: MODERATION_POLICY.model,
    instructions: MODERATE_IMAGE_SYSTEM_PROMPT,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userMessage },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        ...MODERATION_OUTPUT_SCHEMA,
      },
    },
    // Unconditional: this request carries a pupil-supplied image and, unlike
    // the openai-client paths, has no tenant resource to resolve the
    // per-institution retention flag against (see the caller gate below) —
    // so the privacy default is the only defensible choice here.
    store: false,
  };

  const usageContext = createUsageContext("moderate-study-image", {
    promptKey: "moderate_study_image",
    policy: MODERATION_POLICY.policy,
    modelRequested: MODERATION_POLICY.model,
    // Vision moderation of one image — no attachments, no reasoning parameter,
    // no background mode. Recorded explicitly so this row is comparable with
    // the ones openai-client writes rather than silently blank.
    reasoningEffort: null,
    fileCount: 0,
    backgroundMode: false,
  });
  // Fire-and-forget: moderation must not fail because a usage row did.
  const track = (usage: Parameters<typeof trackAIUsage>[0] | null): void => {
    if (!usage) return;
    trackAIUsage(usage, usageContext).catch((err) => {
      logger.error("Failed to track moderation usage", { error: (err as Error).message });
    });
  };

  const startTime = performance.now();
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseTimeMs = Math.round(performance.now() - startTime);

  if (!resp.ok) {
    const t = await resp.text();
    track(
      failedAttemptUsage({
        model: MODERATION_POLICY.model,
        outcome: outcomeForStatus(resp.status),
        attemptNumber: 0,
        responseTimeMs,
        httpStatus: resp.status,
        errorMessage: t,
      }),
    );
    throw new Error(`OpenAI API error: ${resp.status} - ${t}`);
  }

  const data = await resp.json();
  track(
    extractUsageData(data, responseTimeMs, {
      attemptNumber: 0,
      apiLatencyMs: responseTimeMs,
    }),
  );

  // Extract structured text output
  const messageItem = (data.output || []).find((item: Record<string, unknown>) => item?.type === "message");
  const content = messageItem?.content as Array<Record<string, unknown>> | undefined;
  const outputTextItem = content?.find?.((c: Record<string, unknown>) => c?.type === "output_text");
  const outputText = outputTextItem?.text as string | undefined;

  if (typeof outputText === "string" && outputText.trim()) {
    try {
      return JSON.parse(outputText) as ModerationResult;
    } catch {
      throw new Error("Invalid JSON in moderation structured output");
    }
  }

  throw new Error("No structured output found in moderation response");
}

export const handler = withLogging("moderate-study-image", async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Caller gate (#1137) ───────────────────────────────────────────────
    // Moderates a caller-supplied image URL and bills the platform for the
    // vision call.
    //
    // Authentication only: there is no tenant resource in this request to
    // authorize anyone against. That is the whole difference between an
    // endpoint the internet can spend money through and one only signed-in
    // users can.
    const caller = await requireCaller(req);
    if (!caller.ok) {
      return new Response(JSON.stringify({ error: caller.error, code: caller.code }), {
        status: caller.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { fileUrl, lang } = await req.json();


    if (!fileUrl) {
      return new Response(JSON.stringify({ error: "fileUrl is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY is not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const effectiveLang = typeof lang === "string" && lang.trim() ? lang.trim() : "English";

    logger.info("Moderating study image", {
      fileUrl: String(fileUrl).substring(0, 200),
      lang: effectiveLang,
    });

    const llmTimer = logger.startTimer("ai_call");
    const result = await callWithImageUrl({
      apiKey,
      imageUrl: fileUrl,
      lang: effectiveLang,
    });
    const durationMs = llmTimer();

    logger.info("Moderation result", {
      decision: result?.decision,
      reason_category: result?.reason_category,
      confidence: result?.confidence,
      durationMs,
    });

    return new Response(
      JSON.stringify({
        success: true,
        decision: result.decision,
        reason_category: result.reason_category,
        confidence: result.confidence,
        description: result.description,
        notes: result.notes,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    logger.exception("Error moderating study image", error);

    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (msg.includes("402") || msg.toLowerCase().includes("credits")) {
      return new Response(JSON.stringify({ error: "API credits exhausted." }), {
        status: 402,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
