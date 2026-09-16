import { logger } from "../_shared/logger.ts";
import { render } from "../_shared/render.ts";
import { GENERATE_STUDY_IMAGE_PROMPT } from "../_shared/prompts/generate-study-image-prompt.ts";
import { externalPolicy } from "../_shared/model-policy.ts";
import {
  createUsageContext,
  failedAttemptUsage,
  outcomeForStatus,
  trackAIUsage,
  type UsageData,
} from "../_shared/usage-tracker.ts";
import { requireCaller } from "../_shared/require-caller.ts";
import { isRateLimited } from "../_shared/rate-limit.ts";

const IMAGE_MODEL = "gpt-image-2";

// /v1/images/generations, not /v1/responses — so this call has no MODEL_POLICY
// entry to resolve a text model from, and it is billed per image rather than
// per token. Its rows therefore carry little or no token count, which is
// correct rather than missing: what they buy is call volume, latency and
// per-course attribution for a call that appeared in no ledger at all before.
const IMAGE_POLICY = externalPolicy("media", "media.study-image", IMAGE_MODEL);

const MAX_IMAGES_PER_HOUR = 20;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ── Caller gate (#1137) ───────────────────────────────────────────────
    // Generates an image — the most expensive call in the platform, per call.
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

    const { prompt, context } = await req.json();

    // Authentication stops the internet spending the platform's money. It does
    // not stop one signed-in student, and image generation is the most
    // expensive call here — so it gets a ceiling as well as a gate.
    if (isRateLimited(caller.userId, { max: MAX_IMAGES_PER_HOUR, windowMs: 60 * 60 * 1000 })) {
      logger.warn("Study image generation rate limit reached", { userId: caller.userId });
      return new Response(
        JSON.stringify({ error: "Too many images generated. Please try again later." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }


    if (!prompt) {
      return new Response(
        JSON.stringify({ error: "prompt is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    logger.info("Generating study image", { promptLength: prompt.length, hasContext: !!context });

    // Build an enhanced prompt for educational diagrams
    const enhancedPrompt = render(GENERATE_STUDY_IMAGE_PROMPT, {
      prompt,
      context: context ? `Context: ${context}` : "",
    });

    const usageContext = createUsageContext("generate-study-image", {
      promptKey: "generate_study_image",
      policy: IMAGE_POLICY,
      modelRequested: IMAGE_MODEL,
      reasoningEffort: null,
      fileCount: 0,
      backgroundMode: false,
    });
    // Fire-and-forget: an image must not fail to render because a usage row did.
    const track = (usage: UsageData): void => {
      trackAIUsage(usage, usageContext).catch((err) => {
        logger.error("Failed to track image usage", { error: (err as Error).message });
      });
    };

    const endTimer = logger.startTimer("ai-image-generation");
    const startTime = performance.now();
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      // No `response_format`: the gpt-image models always answer with
      // `b64_json` and reject the parameter outright ("Unknown parameter:
      // 'response_format'", HTTP 400) — it belongs to the older DALL·E
      // endpoints, which could also return a URL.
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: enhancedPrompt,
        size: "1024x1024",
        quality: "medium",
      }),
    });
    const responseTimeMs = Math.round(performance.now() - startTime);
    endTimer();

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("Image generation error", { status: response.status, error: errorText });
      track(
        failedAttemptUsage({
          model: IMAGE_MODEL,
          outcome: outcomeForStatus(response.status),
          attemptNumber: 0,
          responseTimeMs,
          httpStatus: response.status,
          errorMessage: errorText,
        }),
      );

      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Image generation failed: ${response.status}`);
    }

    const data = await response.json();

    // The images endpoint returns a usage block on newer models and omits it on
    // older ones, so read it defensively rather than assuming either shape.
    track({
      responseId: null,
      model: data.model || IMAGE_MODEL,
      status: null,
      outcome: "success",
      attemptNumber: 0,
      inputTokens: data.usage?.input_tokens ?? 0,
      inputTokensCached: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      outputTokensReasoning: 0,
      totalTokens: data.usage?.total_tokens ?? 0,
      responseTimeMs,
      apiLatencyMs: responseTimeMs,
    });

    // Extract base64 image from response and convert to data URI
    const b64Json = data.data?.[0]?.b64_json;

    if (!b64Json) {
      logger.error("No image in response", { responseKeys: Object.keys(data) });
      return new Response(
        JSON.stringify({ error: "Failed to generate image" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const imageUrl = `data:image/png;base64,${b64Json}`;

    logger.info("Image generated successfully");

    return new Response(
      JSON.stringify({
        imageUrl,
        description: prompt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    logger.exception(error as Error, "Generate study image error");
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
