/**
 * AI Usage Tracking Utility
 *
 * One row per HTTP attempt in `ai_usage_logs` — successes, failures and
 * retries alike — carrying enough context to answer *why* a call consumed what
 * it consumed, not merely that it did.
 *
 * Two things the row records that the model id alone cannot:
 *
 *  - **The decision.** `policy` comes from `model-policy.ts`, so the row names
 *    the task that chose the model and the version of that choice. That is
 *    what turns "does Sol earn its keep on outlines?" into a GROUP BY.
 *  - **The attempt.** A call that answers `incomplete`, burns its output
 *    tokens and gets retried used to log the retry alone; OpenAI bills for
 *    both, so both are written.
 *
 * No money. Token counts are facts the API reports and stay true forever; a
 * dollar figure is a fact about a price list on a given day. Multiply by
 * current rates outside the app, where the number can be current.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";
import type { UsagePolicy } from "./model-policy.ts";

/**
 * How an attempt ended. Mirrors the `ai_usage_logs_outcome_check` constraint —
 * add to both or the insert is rejected and the row is lost silently, since
 * tracking is fire-and-forget.
 */
export type UsageOutcome =
  | "success"
  | "incomplete"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "transport_error"
  | "poll_timeout";

/**
 * Usage data for a single attempt.
 */
export interface UsageData {
  responseId: string | null;
  /** The model that actually answered, per the response. Falls back to the
   *  requested model on a failed attempt, where there is no response to ask. */
  model: string;
  /** OpenAI's own response status. Null when the attempt never got a response. */
  status: string | null;
  outcome: UsageOutcome;
  /** 0-based, matching the retry loops in openai-client.ts. */
  attemptNumber: number;
  httpStatus?: number | null;
  errorMessage?: string | null;
  inputTokens: number;
  inputTokensCached?: number;
  outputTokens: number;
  outputTokensReasoning?: number;
  totalTokens: number;
  /** Total wall clock for the attempt, including any background polling. */
  responseTimeMs: number;
  /** The HTTP round trip alone. Split out because a background call spends
   *  most of its time polling, and one number cannot distinguish a slow model
   *  from a long queue. */
  apiLatencyMs?: number | null;
  pollWaitMs?: number | null;
}

/**
 * Context for tracking AI usage — the part that is constant across the
 * attempts of one logical call.
 */
export interface UsageTrackingContext {
  functionName: string;
  promptKey?: string | null;
  traceId?: string;
  institutionId?: string | null;
  courseId?: string | null;
  userId?: string | null;
  /** Set by `modelFor()`; folded in automatically by `callOpenAIStructured`. */
  policy?: UsagePolicy;
  /** What we asked for, against `UsageData.model` which is what answered. */
  modelRequested?: string | null;
  reasoningEffort?: string | null;
  /** Saved-prompt identity, kept apart from `promptKey` — which for local
   *  prompts used to be handed the literal string "local prompt (gpt-5.4)". */
  promptId?: string | null;
  promptVersion?: string | null;
  /** Attached OpenAI file ids. 0 on a generator that supports file input is the
   *  tell for the inline-content fallback, which is far more expensive. */
  fileCount?: number | null;
  backgroundMode?: boolean | null;
}

/** Map an HTTP status to the outcome recorded for the attempt. */
export function outcomeForStatus(status: number): UsageOutcome {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

/**
 * Extract usage data from an OpenAI Responses API response.
 *
 * `outcome` follows the response's own status: a response that came back
 * `incomplete` hit the output-token ceiling, was billed in full, and will be
 * retried — so it is recorded as its own attempt rather than as a success.
 */
export function extractUsageData(
  response: any,
  responseTimeMs: number,
  attempt: {
    attemptNumber: number;
    apiLatencyMs?: number | null;
    pollWaitMs?: number | null;
  } = { attemptNumber: 0 },
): UsageData | null {
  if (!response || !response.id) {
    return null;
  }

  const usage = response.usage || {};
  const status = response.status || "unknown";

  return {
    responseId: response.id,
    model: response.model || "unknown",
    status,
    outcome: status === "incomplete" ? "incomplete" : "success",
    attemptNumber: attempt.attemptNumber,
    apiLatencyMs: attempt.apiLatencyMs ?? null,
    pollWaitMs: attempt.pollWaitMs ?? null,
    inputTokens: usage.input_tokens || 0,
    inputTokensCached: usage.input_tokens_details?.cached_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    outputTokensReasoning: usage.output_tokens_details?.reasoning_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    responseTimeMs,
  };
}

/**
 * Build the usage row for an attempt that never produced a response — a 429, a
 * 5xx, a rejected request, a transport failure.
 *
 * These bill nothing themselves, but they are the reason a call's *total* cost
 * is a multiple of its successful attempt's, and without a row the retry is
 * invisible to every cost query.
 */
export function failedAttemptUsage(input: {
  model: string;
  outcome: UsageOutcome;
  attemptNumber: number;
  responseTimeMs: number;
  httpStatus?: number | null;
  errorMessage?: string | null;
}): UsageData {
  return {
    responseId: null,
    model: input.model,
    status: null,
    outcome: input.outcome,
    attemptNumber: input.attemptNumber,
    httpStatus: input.httpStatus ?? null,
    // Truncated: this lands in a table read by a dashboard, and OpenAI error
    // bodies can carry the entire offending schema.
    errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
    inputTokens: 0,
    inputTokensCached: 0,
    outputTokens: 0,
    outputTokensReasoning: 0,
    totalTokens: 0,
    responseTimeMs: input.responseTimeMs,
    apiLatencyMs: input.responseTimeMs,
    pollWaitMs: null,
  };
}

/**
 * Track AI usage in both logs and database.
 * This function is fire-and-forget - it won't block the main request.
 */
export async function trackAIUsage(
  usage: UsageData,
  context: UsageTrackingContext
): Promise<void> {
  // 1. Log to console for real-time monitoring in the Supabase dashboard
  logger.info("AI API usage", {
    ai_usage: {
      response_id: usage.responseId,
      model: usage.model,
      model_requested: context.modelRequested ?? null,
      status: usage.status,
      outcome: usage.outcome,
      attempt: usage.attemptNumber,
      http_status: usage.httpStatus ?? null,
      input_tokens: usage.inputTokens,
      input_tokens_cached: usage.inputTokensCached || 0,
      output_tokens: usage.outputTokens,
      output_tokens_reasoning: usage.outputTokensReasoning || 0,
      total_tokens: usage.totalTokens,
      response_time_ms: usage.responseTimeMs,
      api_latency_ms: usage.apiLatencyMs ?? null,
      poll_wait_ms: usage.pollWaitMs ?? null,
    },
    function_name: context.functionName,
    prompt_key: context.promptKey,
    feature: context.policy?.feature ?? null,
    policy_key: context.policy?.policyKey ?? null,
    model_tier: context.policy?.modelTier ?? null,
    reasoning_effort: context.reasoningEffort ?? null,
    file_count: context.fileCount ?? null,
    institution_id: context.institutionId,
    course_id: context.courseId,
    user_id: context.userId,
  });

  // 2. Store in database for aggregation and reporting
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      logger.warn("Supabase credentials not configured, skipping database insert");
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { error } = await supabase.from("ai_usage_logs").insert({
      function_name: context.functionName,
      prompt_key: context.promptKey || null,
      trace_id: context.traceId || null,
      model: usage.model,
      status: usage.status,
      response_id: usage.responseId,
      input_tokens: usage.inputTokens,
      input_tokens_cached: usage.inputTokensCached || 0,
      output_tokens: usage.outputTokens,
      output_tokens_reasoning: usage.outputTokensReasoning || 0,
      total_tokens: usage.totalTokens,
      response_time_ms: usage.responseTimeMs,
      institution_id: context.institutionId || null,
      course_id: context.courseId || null,
      user_id: context.userId || null,
      // Why this model, and what it was asked to do.
      feature: context.policy?.feature || null,
      policy_key: context.policy?.policyKey || null,
      policy_version: context.policy?.policyVersion ?? null,
      model_tier: context.policy?.modelTier || null,
      model_requested: context.modelRequested || null,
      reasoning_effort: context.reasoningEffort || null,
      prompt_id: context.promptId || null,
      prompt_version: context.promptVersion || null,
      file_count: context.fileCount ?? null,
      background_mode: context.backgroundMode ?? null,
      // How this attempt went.
      outcome: usage.outcome,
      attempt_number: usage.attemptNumber,
      http_status: usage.httpStatus ?? null,
      error_message: usage.errorMessage ?? null,
      api_latency_ms: usage.apiLatencyMs ?? null,
      poll_wait_ms: usage.pollWaitMs ?? null,
    });

    if (error) {
      logger.error("Failed to insert AI usage log", { error: error.message });
    }
  } catch (error) {
    // Log error but don't fail the request
    logger.error("Error storing AI usage in database", { error: (error as Error).message });
  }
}

/**
 * Helper to create a usage context from common edge function parameters
 */
export function createUsageContext(
  functionName: string,
  options: {
    promptKey?: string;
    institutionId?: string | null;
    courseId?: string | null;
    userId?: string | null;
    traceId?: string;
    policy?: UsagePolicy;
    modelRequested?: string | null;
    reasoningEffort?: string | null;
    promptId?: string | null;
    promptVersion?: string | null;
    fileCount?: number | null;
    backgroundMode?: boolean | null;
  } = {}
): UsageTrackingContext {
  return {
    functionName,
    promptKey: options.promptKey,
    traceId: options.traceId,
    institutionId: options.institutionId,
    courseId: options.courseId,
    userId: options.userId,
    policy: options.policy,
    modelRequested: options.modelRequested,
    reasoningEffort: options.reasoningEffort,
    promptId: options.promptId,
    promptVersion: options.promptVersion,
    fileCount: options.fileCount,
    backgroundMode: options.backgroundMode,
  };
}
