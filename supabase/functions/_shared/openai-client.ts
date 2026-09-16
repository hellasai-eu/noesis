/**
 * Shared OpenAI Responses API client for edge functions
 * Supports multiple models and structured output via tool calling
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log, logError, logWarn, logDebug } from "./context-logger.ts";
import {
  trackAIUsage,
  extractUsageData,
  failedAttemptUsage,
  outcomeForStatus,
  UsageData,
  UsageTrackingContext,
} from "./usage-tracker.ts";
import type { UsagePolicy } from "./model-policy.ts";
import { logger } from "./logger.ts";
import { getQualityInstructionForCourse } from "./language-utils.ts";
import { render } from "./render.ts";
import { deleteStoredResponse, resolveOpenAIStore } from "./openai-retention.ts";
import { disabledFamilyFor } from "./ai-feature-gate.ts";

// Re-export for convenience
export type { UsageTrackingContext } from "./usage-tracker.ts";
export { getQualityInstructionForCourse } from "./language-utils.ts";

// Available OpenAI models.
//
// NOTE: this union is documentation, not enforcement —
// `SavedPromptStructuredOptions.model` is typed `string`, so handlers can and
// do pass ids absent from this list (`gpt-5.4`, `gpt-5.5`). Keep it current
// anyway; it is the only place the callable ids are written down.
//
// GPT-5.6 ships as three tiers: Sol (flagship), Terra (balanced), Luna
// (cost-efficient). Always name the tier — bare "gpt-5.6" is an alias for Sol,
// so omitting the suffix silently buys the most expensive tier instead of
// failing loudly.
export type OpenAIModel =
  | "gpt-5-2025-08-07"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.4-mini"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5-nano-2025-08-07"
  | "gpt-4.1"
  | "gpt-4.1-2025-04-14"
  | "gpt-4.1-mini-2025-04-14"
  | "o3-2025-04-16"
  | "o4-mini-2025-04-16";

// Tool definition for structured output
export interface OpenAITool {
  type: "function";
  name: string;
  description: string;
  strict?: boolean;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
    additionalProperties: boolean;
  };
}

// Built-in tool types
export interface FileSearchTool {
  type: "file_search";
  vector_store_ids?: string[];
}

export interface ImageGenerationTool {
  type: "image_generation";
}

// Union type for all tool types
export type OpenAIToolOrBuiltIn = OpenAITool | FileSearchTool | ImageGenerationTool;

// File attachment for Files API (Responses API format)
export interface OpenAIFileAttachment {
  type: "input_file";
  file_id: string;
}

// Message content types (Responses API uses input_text, not text)
export type OpenAIMessageContent = string | Array<{ type: "input_text"; text: string } | OpenAIFileAttachment>;

// Input message with optional file attachments
export interface OpenAIInputMessage {
  role: "user" | "assistant";
  content: OpenAIMessageContent;
}

// Request options
export interface OpenAIRequestOptions {
  model: OpenAIModel;
  instructions: string;
  input: string | OpenAIInputMessage[];
  tools?: OpenAITool[];
  toolChoice?: "auto" | "required" | "none" | { type: "function"; name: string };
  maxOutputTokens?: number;
  usageContext?: UsageTrackingContext;
}

// Response types
export interface OpenAIFunctionCallOutput {
  type: "function_call";
  name: string;
  arguments: string;
  call_id: string;
}

export interface OpenAIMessageOutput {
  type: "message";
  role: "assistant";
  content: Array<{ type: "output_text"; text: string }>;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created_at: number;
  model: string;
  status: string;
  output: Array<OpenAIFunctionCallOutput | OpenAIMessageOutput>;
  usage?: {
    input_tokens: number;
    input_tokens_details?: {
      cached_tokens?: number;
    };
    output_tokens: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    total_tokens: number;
  };
}

// Error types
export class OpenAIError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public isRetryable: boolean = false,
  ) {
    super(message);
    this.name = "OpenAIError";
  }
}

/**
 * The calling school switched this AI feature family off
 * (`institutions.ai_features_disabled` — see _shared/ai-feature-gate.ts).
 * Subclasses OpenAIError so every handler's existing error mapping already
 * turns it into a non-crash response; not retryable, because retrying cannot
 * change a policy decision.
 */
export class AiFeatureDisabledError extends OpenAIError {
  constructor(public family: string) {
    super(`This AI feature is switched off by your school (${family}).`, 403, false);
    this.name = "AiFeatureDisabledError";
  }
}

export class OpenAIRateLimitError extends OpenAIError {
  constructor(message = "Rate limit exceeded") {
    super(message, 429, true);
    this.name = "OpenAIRateLimitError";
  }
}

export class OpenAIPaymentRequiredError extends OpenAIError {
  constructor(message = "Payment required - credits exhausted") {
    super(message, 402, false);
    this.name = "OpenAIPaymentRequiredError";
  }
}

export class OpenAIServerError extends OpenAIError {
  constructor(message = "OpenAI server error", statusCode = 500) {
    super(message, statusCode, true);
    this.name = "OpenAIServerError";
  }
}

/**
 * Helper to delay execution
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Append a language-specific quality instruction to a base instructions string.
 * No-op when the suffix is missing.
 */
export function appendQualityInstruction(
  instructions: string,
  qualityInstruction?: string,
): string {
  if (!qualityInstruction) return instructions;
  return `${instructions}\n\n${qualityInstruction}`;
}

// Module-level cache: courseId -> resolved quality instruction (null = no rules for this course)
const qualityInstructionCache = new Map<string, string | null>();

/**
 * Resolve the quality instruction for a usage context (if any).
 * Returns undefined when no courseId is supplied, no quality rules exist, or the lookup fails.
 * Results are cached per courseId for the lifetime of the edge-function process.
 */
async function resolveQualityInstruction(
  usageContext?: UsageTrackingContext,
): Promise<string | undefined> {
  const courseId = usageContext?.courseId;
  if (!courseId) return undefined;

  if (qualityInstructionCache.has(courseId)) {
    return qualityInstructionCache.get(courseId) ?? undefined;
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      qualityInstructionCache.set(courseId, null);
      return undefined;
    }
    const supabase = createClient(supabaseUrl, supabaseKey);
    const quality = await getQualityInstructionForCourse(supabase, courseId);
    qualityInstructionCache.set(courseId, quality ?? null);
    return quality;
  } catch (err) {
    logger.warn("Failed to resolve quality instruction", {
      courseId,
      error: (err as Error).message,
    });
    // Do not cache on transient errors — let the next request retry.
    return undefined;
  }
}

/**
 * Testing helper — clear the quality instruction cache.
 */
export function _clearQualityInstructionCache(): void {
  qualityInstructionCache.clear();
}

const TRANSIENT_400_PATTERNS = [
  "unsupported unicode",
];

function isTransient400(status: number, errorText: string): boolean {
  if (status !== 400) return false;
  const lower = errorText.toLowerCase();
  return TRANSIENT_400_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Machine-greppable class for a failed OpenAI call. */
export type OpenAIFailureClass =
  | "rate_limited"
  | "transient_400"
  | "server_error"
  | "payment_required"
  | "fatal";

export function classifyOpenAIFailure(status: number, errorText: string): OpenAIFailureClass {
  if (status === 429) return "rate_limited";
  if (isTransient400(status, errorText)) return "transient_400";
  if (status >= 500) return "server_error";
  if (status === 402) return "payment_required";
  return "fatal";
}

/** Keep a multi-kilobyte provider error from dominating a log line. */
const MAX_LOGGED_ERROR_CHARS = 500;

function truncateError(errorText: string): string {
  return errorText.length > MAX_LOGGED_ERROR_CHARS
    ? `${errorText.slice(0, MAX_LOGGED_ERROR_CHARS)}… [${errorText.length} chars total]`
    : errorText;
}

/**
 * Log one failed HTTP attempt against OpenAI, at a level that reflects whether
 * it is actually a failure yet.
 *
 * Every retry loop here used to emit `logError("OpenAI API error")` on EVERY
 * attempt, including attempts that then succeeded on retry. A 429 that the
 * next attempt recovers from is invisible to the caller and to the student —
 * recording it at `error` inflates the error rate and makes any error-rate
 * alert or SLO fire on healthy traffic, which trains people to ignore it.
 *
 * So: `warn` while retries remain, `error` only once they are gone. The
 * exhaustion case also used to throw with NO log at all, so "failed on the
 * first try" and "gave up after 4 attempts and 70s of backoff" were
 * indistinguishable — `attempts_made` now separates them.
 */
function logOpenAIAttemptFailure(opts: {
  status: number;
  errorText: string;
  /** 0-based index of the attempt that just failed. */
  attempt: number;
  maxRetries: number;
  /** Set only when another attempt will follow. */
  retryInMs?: number;
  promptLabel?: string;
}): void {
  const failureClass = classifyOpenAIFailure(opts.status, opts.errorText);
  const base = {
    status: opts.status,
    failure_class: failureClass,
    attempts_made: opts.attempt + 1,
    max_attempts: opts.maxRetries + 1,
    prompt: opts.promptLabel,
    error: truncateError(opts.errorText),
  };

  if (opts.retryInMs !== undefined) {
    logWarn("OpenAI API error — retrying", { ...base, retry_in_ms: opts.retryInMs });
    return;
  }

  // No retry follows: either the class is not retryable, or the budget is out.
  // `maxRetries === 0` is a single-attempt caller (the streaming paths), where
  // "exhausted" would imply retries that were never on offer.
  const retryable = failureClass === "rate_limited" ||
    failureClass === "transient_400" ||
    failureClass === "server_error";
  const exhausted = retryable && opts.maxRetries > 0;
  logError(
    exhausted ? "OpenAI API error — retries exhausted" : "OpenAI API error",
    base,
  );
}

/**
 * Truncate text fields in an object to maxLength characters
 */
function truncateTextFields(obj: any, maxLength: number = 100): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === "string") {
    return obj.length > maxLength ? obj.substring(0, maxLength) + "..." : obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => truncateTextFields(item, maxLength));
  }
  
  if (typeof obj === "object") {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Truncate text fields (content, text, instructions, etc.)
      if (typeof value === "string" && (key.includes("text") || key.includes("content") || key === "instructions" || key === "message")) {
        result[key] = value.length > maxLength ? value.substring(0, maxLength) + "..." : value;
      } else {
        result[key] = truncateTextFields(value, maxLength);
      }
    }
    return result;
  }
  
  return obj;
}

/**
 * Prepare OpenAI response for logging
 * Keeps metadata intact but truncates long text content
 */
function prepareResponseForLogging(data: any, maxTextLength: number = 500): any {
  if (!data) return null;
  
  const logData: Record<string, any> = {
    id: data.id,
    object: data.object,
    model: data.model,
    status: data.status,
    created_at: data.created_at,
  };
  
  // Include usage data fully (important for tracking)
  if (data.usage) {
    logData.usage = data.usage;
  }
  
  // Process output array with truncated text
  if (data.output && Array.isArray(data.output)) {
    logData.output = data.output.map((item: any) => {
      if (item.type === "function_call") {
        // For function calls, truncate the arguments string
        const args = item.arguments;
        return {
          type: item.type,
          name: item.name,
          call_id: item.call_id,
          arguments_length: args?.length,
          arguments: args?.length > maxTextLength 
            ? `[truncated: ${args.length} chars] ${args.substring(0, maxTextLength)}...`
            : args,
        };
      } else if (item.type === "message") {
        // For messages, truncate the text content
        return {
          type: item.type,
          role: item.role,
          content: item.content?.map((c: any) => {
            if (c.type === "output_text") {
              const text = c.text;
              return {
                type: c.type,
                text_length: text?.length,
                text: text?.length > maxTextLength
                  ? `[truncated: ${text.length} chars] ${text.substring(0, maxTextLength)}...`
                  : text,
              };
            }
            return c;
          }),
        };
      }
      return item;
    });
  }
  
  // Include error if present
  if (data.error) {
    logData.error = data.error;
  }
  
  return logData;
}

/**
 * Extract rate limit headers from response
 */
function extractRateLimitHeaders(response: Response): Record<string, string | null> {
  return {
    "x-ratelimit-limit-requests": response.headers.get("x-ratelimit-limit-requests"),
    "x-ratelimit-remaining-requests": response.headers.get("x-ratelimit-remaining-requests"),
    "x-ratelimit-reset-requests": response.headers.get("x-ratelimit-reset-requests"),
    "x-ratelimit-limit-tokens": response.headers.get("x-ratelimit-limit-tokens"),
    "x-ratelimit-remaining-tokens": response.headers.get("x-ratelimit-remaining-tokens"),
    "x-ratelimit-reset-tokens": response.headers.get("x-ratelimit-reset-tokens"),
  };
}

/**
 * Log OpenAI API request
 */
function logOpenAIRequest(
  promptId: string | undefined,
  body: Record<string, any>,
  attempt: number = 0,
  maxRetries: number = 0
): void {
  const truncatedBody = truncateTextFields(body, 100);
  log("OpenAI API request", {
    promptId: promptId || undefined,
    arguments: truncatedBody,
    attempt: attempt > 0 ? attempt : undefined,
    maxRetries: maxRetries > 0 ? maxRetries : undefined,
  });
}

/**
 * Log OpenAI API response with full JSON body
 */
function logOpenAIResponse(
  response: Response,
  responseTimeMs: number,
  promptId: string | undefined,
  data?: any
): void {
  const rateLimitHeaders = extractRateLimitHeaders(response);
  
  // Prepare the response data for logging (with truncated text fields)
  const openaiResponse = data ? prepareResponseForLogging(data, 500) : null;
  
  log("OpenAI API response", {
    promptId: promptId || undefined,
    responseCode: response.status,
    responseTimeMs,
    rateLimitHeaders,
    openai_response: openaiResponse,
  });
  
  // Also log the full response as a separate debug entry for easy parsing
  if (data) {
    logDebug("OPENAI_RESPONSE_JSON:", JSON.stringify(openaiResponse));
  }
}

/**
 * Call OpenAI Responses API with automatic retry on 429
 */
export async function callOpenAI(options: OpenAIRequestOptions): Promise<OpenAIResponse> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  {
    const disabledFamily = await disabledFamilyFor(options.usageContext?.policy, options.usageContext);
    if (disabledFamily) throw new AiFeatureDisabledError(disabledFamily);
  }

  // Format input as array if string
  const inputMessages =
    typeof options.input === "string" ? [{ role: "user" as const, content: options.input }] : options.input;

  // Inject language-specific quality rules (e.g. Greek orthography) when available.
  const qualityInstruction = await resolveQualityInstruction(options.usageContext);
  const instructionsWithQuality = appendQualityInstruction(options.instructions, qualityInstruction);

  const body: Record<string, any> = {
    model: options.model,
    instructions: instructionsWithQuality,
    input: inputMessages,
    // No retention at OpenAI unless the institution's super-admin-controlled
    // flag says otherwise — see openai-retention.ts.
    store: await resolveOpenAIStore(options.usageContext),
  };

  if (options.maxOutputTokens) {
    body.max_output_tokens = options.maxOutputTokens;
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "required";
  }

  const maxRetries = 1;
  const retryDelayMs = 30000; // 30 seconds

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    log(`Calling OpenAI ${options.model}...${attempt > 0 ? ` (retry ${attempt})` : ""}`);

    const startTime = performance.now();
    logOpenAIRequest(undefined, body, attempt, maxRetries);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseTimeMs = Math.round(performance.now() - startTime);

    if (!response.ok) {
      const errorText = await response.text();
      logOpenAIResponse(response, responseTimeMs, undefined);

      // Retry on rate limits (429), server errors (5xx), and transient 400 errors
      if (response.status === 429 || response.status >= 500 || isTransient400(response.status, errorText)) {
        if (attempt < maxRetries) {
          logOpenAIAttemptFailure({
            status: response.status,
            errorText,
            attempt,
            maxRetries,
            retryInMs: retryDelayMs,
          });
          await delay(retryDelayMs);
          continue;
        }
        logOpenAIAttemptFailure({ status: response.status, errorText, attempt, maxRetries });
        if (response.status === 429) {
          throw new OpenAIRateLimitError();
        }
        throw new OpenAIServerError(`OpenAI server error: ${response.status} - ${errorText}`, response.status);
      }

      logOpenAIAttemptFailure({ status: response.status, errorText, attempt, maxRetries });
      if (response.status === 402) {
        throw new OpenAIPaymentRequiredError();
      }

      throw new OpenAIError(`OpenAI API error: ${response.status} - ${errorText}`, response.status);
    }

    const data = await response.json();
    logOpenAIResponse(response, responseTimeMs, undefined, data);

    return data as OpenAIResponse;
  }

  throw new OpenAIRateLimitError();
}

/**
 * Extract function call result from OpenAI response
 */
export function extractFunctionCall<T = any>(response: OpenAIResponse, functionName: string): T {
  const toolCallItem = response.output?.find(
    (item): item is OpenAIFunctionCallOutput => item.type === "function_call" && item.name === functionName,
  );

  if (!toolCallItem) {
    logError("Function call not found in response", { output: JSON.stringify(response.output) });
    throw new OpenAIError(`Function '${functionName}' not found in response`, 500);
  }

  try {
    return JSON.parse(toolCallItem.arguments) as T;
  } catch (e) {
    // Log detailed info about the parse failure
    const args = toolCallItem.arguments;
    logError("Failed to parse function arguments", {
      length: args?.length,
      first_500_chars: args?.slice(0, 500),
      last_500_chars: args?.slice(-500),
      parse_error: (e as Error).message,
    });
    throw new OpenAIError(`Invalid JSON in function '${functionName}' arguments. Response may be truncated (length: ${args?.length}). Check logs for details.`, 500);
  }
}

/**
 * Extract text content from OpenAI response (for non-tool-call responses)
 */
export function extractTextContent(response: OpenAIResponse): string | null {
  const messageItem = response.output?.find((item): item is OpenAIMessageOutput => item.type === "message");

  if (!messageItem || !messageItem.content) {
    return null;
  }

  const textContent = messageItem.content.find((c) => c.type === "output_text");
  return textContent?.text ?? null;
}

/**
 * Helper to create a tool definition for structured output
 */
export function createTool(
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[],
): OpenAITool {
  return {
    type: "function",
    name,
    description,
    strict: true,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

/**
 * Convenience function for simple structured output calls
 */
export async function callOpenAIWithStructuredOutput<T = any>(
  model: OpenAIModel,
  instructions: string,
  prompt: string,
  tool: OpenAITool,
  maxOutputTokens?: number,
  usageContext?: UsageTrackingContext,
): Promise<T> {
  const response = await callOpenAI({
    model,
    instructions,
    input: prompt,
    tools: [tool],
    toolChoice: "required",
    maxOutputTokens,
    usageContext,
  });

  return extractFunctionCall<T>(response, tool.name);
}

/**
 * Convenience function for structured output calls with file attachments
 * Uses OpenAI Files API for document analysis
 */
export async function callOpenAIWithFiles<T = any>(
  model: OpenAIModel,
  instructions: string,
  prompt: string,
  fileIds: string[],
  tool: OpenAITool,
  maxOutputTokens?: number,
  usageContext?: UsageTrackingContext,
): Promise<T> {
  // Build content array with text prompt and file attachments (Responses API format)
  const content: Array<{ type: "input_text"; text: string } | OpenAIFileAttachment> = [
    { type: "input_text", text: prompt },
  ];

  // Add file attachments
  for (const fileId of fileIds) {
    content.push({
      type: "input_file",
      file_id: fileId,
    });
  }

  const response = await callOpenAI({
    model,
    instructions,
    input: [{ role: "user", content }],
    tools: [tool],
    toolChoice: "required",
    maxOutputTokens,
    usageContext,
  });

  return extractFunctionCall<T>(response, tool.name);
}

/**
 * Helper to create file attachment object
 */
export function createFileAttachment(fileId: string): OpenAIFileAttachment {
  return {
    type: "input_file",
    file_id: fileId,
  };
}

/**
 * Saved prompt configuration for OpenAI Responses API
 */
export interface SavedPromptConfig {
  id: string;
  version?: string;
  variables: Record<string, string>;
}

/**
 * Retry options for rate limit handling
 */
export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 10000 = 10 seconds) */
  initialDelayMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
}

/**
 * Background options for long-running requests
 * Uses OpenAI's background response feature to avoid HTTP/gateway timeouts
 */
export interface BackgroundOptions {
  /** Enable background mode (default: false) */
  enabled?: boolean;
  /** Polling interval in milliseconds (default: 2000 = 2 seconds) */
  pollIntervalMs?: number;
  /** Maximum polling time in milliseconds (default: 170000 = ~170 seconds to stay under 180s edge function timeout) */
  maxPollTimeMs?: number;
}

/**
 * Background response status from OpenAI
 */
type BackgroundResponseStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";

/**
 * Poll for background response completion
 * Returns the completed response or throws on failure/timeout
 */
async function pollBackgroundResponse(
  responseId: string,
  apiKey: string,
  promptId: string | undefined,
  pollIntervalMs: number = 2000,
  maxPollTimeMs: number = 170000
): Promise<any> {
  const startTime = Date.now();
  let pollCount = 0;
  
  while (true) {
    pollCount++;
    const elapsed = Date.now() - startTime;
    
    if (elapsed >= maxPollTimeMs) {
      throw new OpenAIError(
        `Background response polling timed out after ${Math.round(elapsed / 1000)} seconds (${pollCount} polls)`,
        504
      );
    }
    
    log(`Polling background response ${responseId} (poll ${pollCount}, ${Math.round(elapsed / 1000)}s elapsed)...`);
    
    const pollStartTime = performance.now();
    const response = await fetch(`https://api.openai.com/v1/responses/${responseId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    
    const pollTimeMs = Math.round(performance.now() - pollStartTime);
    
    if (!response.ok) {
      const errorText = await response.text();
      logError("OpenAI polling error", { status: response.status, error: errorText });
      
      logOpenAIResponse(response, pollTimeMs, promptId);
      
      if (response.status === 429) {
        throw new OpenAIRateLimitError();
      }
      if (response.status === 402) {
        throw new OpenAIPaymentRequiredError();
      }
      if (response.status >= 500) {
        throw new OpenAIServerError(`OpenAI server error during polling: ${response.status} - ${errorText}`, response.status);
      }
      
      throw new OpenAIError(`OpenAI polling error: ${response.status} - ${errorText}`, response.status);
    }
    
    const data = await response.json();
    const status = data.status as BackgroundResponseStatus;
    
    log(`Background response status: ${status}`);
    logOpenAIResponse(response, pollTimeMs, promptId, data);
    
    if (status === "completed") {
      log(`Background response completed after ${pollCount} polls (${Math.round(elapsed / 1000)}s)`);
      return data;
    }
    
    if (status === "failed") {
      const errorMessage = data.error?.message || "Background response failed";
      throw new OpenAIError(errorMessage, 500);
    }
    
    if (status === "cancelled") {
      throw new OpenAIError("Background response was cancelled", 500);
    }
    
    if (status === "incomplete") {
      // Return incomplete response so caller can handle it (e.g., retry logic)
      log("Background response is incomplete (likely hit token limit)");
      return data;
    }
    
    // Status is "queued" or "in_progress" - wait and poll again
    await delay(pollIntervalMs);
  }
}

/**
 * Call OpenAI Responses API with a saved prompt template
 * Uses prompt ID and variables instead of inline instructions
 * Accepts either text content or file IDs
 * Includes automatic retry on rate limits with exponential backoff
 * Supports background mode for long-running requests to avoid HTTP/gateway timeouts
 * Tracks usage if usageContext is provided
 */
export async function callOpenAIWithPrompt<T = any>(
  savedPrompt: SavedPromptConfig,
  content: string | string[],
  retryOptions?: RetryOptions,
  tools?: OpenAIToolOrBuiltIn[],
  backgroundOptions?: BackgroundOptions,
  usageContext?: UsageTrackingContext,
): Promise<T> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  {
    const disabledFamily = await disabledFamilyFor(usageContext?.policy, usageContext);
    if (disabledFamily) throw new AiFeatureDisabledError(disabledFamily);
  }

  const useBackground = backgroundOptions?.enabled ?? false;
  const pollIntervalMs = backgroundOptions?.pollIntervalMs ?? 2000;
  const maxPollTimeMs = backgroundOptions?.maxPollTimeMs ?? 170000;

  // No retention at OpenAI unless the institution opted in. Background mode is
  // the one exception OpenAI forces — a background response must be stored to
  // be pollable — so there `store: true` is sent and the stored copy is
  // deleted once the result is in hand (see below).
  const allowStore = await resolveOpenAIStore(usageContext);

  const body: Record<string, any> = {
    prompt: {
      id: savedPrompt.id,
      ...(savedPrompt.version && { version: savedPrompt.version }),
      variables: savedPrompt.variables,
    },
    store: allowStore || useBackground,
    ...(useBackground && { background: true }),
  };

  // Add content as input - either text or file attachments
  if (typeof content === "string") {
    // Text content
    body.input = [{ role: "user", content: [{ type: "input_text", text: content }] }];
  } else if (Array.isArray(content) && content.length > 0) {
    // File IDs
    const fileAttachments = content.map((fileId) => ({
      type: "input_file" as const,
      file_id: fileId,
    }));
    body.input = [{ role: "user", content: fileAttachments }];
  }

  // Inject language-specific quality rules (saved prompts have no inline instructions,
  // so prepend a user message carrying the quality directives).
  const qualityInstruction = await resolveQualityInstruction(usageContext);
  if (qualityInstruction) {
    const qualityMessage = {
      role: "user",
      content: [{ type: "input_text", text: qualityInstruction }],
    };
    body.input = Array.isArray(body.input) ? [qualityMessage, ...body.input] : [qualityMessage];
  }

  // Add tools if provided
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const maxRetries = retryOptions?.maxRetries ?? 3;
  const initialDelayMs = retryOptions?.initialDelayMs ?? 10000;
  const useExponentialBackoff = retryOptions?.exponentialBackoff ?? true;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const modeLabel = useBackground ? " (background mode)" : "";
    log(`Calling OpenAI with saved prompt ${savedPrompt.id}${modeLabel}...${attempt > 0 ? ` (retry ${attempt}/${maxRetries})` : ""}`);

    const startTime = performance.now();
    logOpenAIRequest(savedPrompt.id, body, attempt, maxRetries);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseTimeMs = Math.round(performance.now() - startTime);

    if (!response.ok) {
      const errorText = await response.text();
      logOpenAIResponse(response, responseTimeMs, savedPrompt.id);

      // Retry on rate limits (429), server errors (5xx), and transient 400 errors
      if (response.status === 429 || response.status >= 500 || isTransient400(response.status, errorText)) {
        if (attempt < maxRetries) {
          // Calculate delay with exponential backoff: initialDelay * 2^attempt
          const delayMs = useExponentialBackoff
            ? initialDelayMs * Math.pow(2, attempt)
            : initialDelayMs;
          logOpenAIAttemptFailure({
            status: response.status,
            errorText,
            attempt,
            maxRetries,
            retryInMs: delayMs,
            promptLabel: savedPrompt.id,
          });
          await delay(delayMs);
          continue;
        }
        logOpenAIAttemptFailure({
          status: response.status,
          errorText,
          attempt,
          maxRetries,
          promptLabel: savedPrompt.id,
        });
        if (response.status === 429) {
          throw new OpenAIRateLimitError();
        }
        throw new OpenAIServerError(`OpenAI server error: ${response.status} - ${errorText}`, response.status);
      }

      logOpenAIAttemptFailure({
        status: response.status,
        errorText,
        attempt,
        maxRetries,
        promptLabel: savedPrompt.id,
      });
      if (response.status === 402) {
        throw new OpenAIPaymentRequiredError();
      }

      throw new OpenAIError(`OpenAI API error: ${response.status} - ${errorText}`, response.status);
    }

    let data = (await response.json()) as OpenAIResponse;
    logOpenAIResponse(response, responseTimeMs, savedPrompt.id, data);

    // Handle background mode - poll until completion
    if (useBackground && (data.status === "queued" || data.status === "in_progress")) {
      log(`Background response started with ID ${data.id}, polling for completion...`);
      const backgroundId = data.id;
      try {
        data = await pollBackgroundResponse(
          backgroundId,
          apiKey,
          savedPrompt.id,
          pollIntervalMs,
          maxPollTimeMs
        );
      } finally {
        // Background forced `store: true`; without institutional opt-in the
        // stored copy is removed now that (or whether) the result is in hand.
        if (!allowStore) deleteStoredResponse(apiKey, backgroundId);
      }
    } else if (useBackground && !allowStore) {
      // Background response that completed inside the POST — still stored.
      deleteStoredResponse(apiKey, data.id);
    }

    // Track usage if context is provided (fire-and-forget)
    if (usageContext) {
      const usageData = extractUsageData(data, responseTimeMs);
      if (usageData) {
        trackAIUsage(usageData, {
          ...usageContext,
          promptKey: usageContext.promptKey || savedPrompt.id,
        }).catch((err) => {
          logError("Failed to track AI usage", { error: (err as Error).message });
        });
      }
    }

    // First try to extract function call from the response
    const toolCallItem = data.output?.find((item): item is OpenAIFunctionCallOutput => item.type === "function_call");

    if (toolCallItem) {
      try {
        return JSON.parse(toolCallItem.arguments) as T;
      } catch (e) {
        logError("Failed to parse function arguments", { arguments: toolCallItem.arguments });
        throw new OpenAIError("Invalid JSON in function arguments", 500);
      }
    }

    // Fallback: try to extract JSON from text output (some saved prompts return JSON as text)
    const messageItem = data.output?.find((item): item is OpenAIMessageOutput => item.type === "message");

    if (messageItem?.content) {
      const textContent = messageItem.content.find((c) => c.type === "output_text");
      if (textContent?.text) {
        // First try to parse as JSON
        try {
          log("Parsing JSON from text output...");
          return JSON.parse(textContent.text) as T;
        } catch (e) {
          // Check if the text might be JSON wrapped in markdown code blocks
          const jsonMatch = textContent.text.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (jsonMatch) {
            try {
              log("Found JSON in markdown code block, parsing...");
              return JSON.parse(jsonMatch[1].trim()) as T;
            } catch (e2) {
              logError("Failed to parse JSON from code block", { snippet: jsonMatch[1].slice(0, 500) });
            }
          }
          
          // If not valid JSON, return the text as content (for markdown responses)
          log("Text output is not JSON, returning as content field");
          return { content: textContent.text } as T;
        }
      }
    }

    logError("No usable output found in saved prompt response", { output: JSON.stringify(data.output) });
    throw new OpenAIError("No function call or JSON text found in saved prompt response", 500);
  }

  throw new OpenAIRateLimitError();
}

// ============================================
// STREAMING SUPPORT
// ============================================

/**
 * Chat message for Chat Completions API
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Tool definition for Chat Completions API
 */
export interface ChatCompletionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/**
 * Chat Completions streaming request options
 */
export interface ChatCompletionsStreamOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ChatCompletionTool[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

/**
 * Call OpenAI Chat Completions API with streaming
 * Returns the raw Response for SSE processing
 */
export async function callChatCompletionsStreaming(options: ChatCompletionsStreamOptions): Promise<Response> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  const body: Record<string, any> = {
    model: options.model,
    messages: options.messages,
    stream: true,
    // Chat Completions already defaults to no retention; said explicitly so
    // every OpenAI call in this file states its store decision.
    store: false,
  };

  if (options.maxTokens) {
    // Use max_completion_tokens for newer models
    if (
      options.model.includes("gpt-5") ||
      options.model.includes("gpt-4.1") ||
      options.model.includes("o3") ||
      options.model.includes("o4")
    ) {
      body.max_completion_tokens = options.maxTokens;
    } else {
      body.max_tokens = options.maxTokens;
    }
  }

  // Only add temperature for models that support it (not GPT-5 or newer)
  if (
    options.temperature !== undefined &&
    !options.model.includes("gpt-5") &&
    !options.model.includes("gpt-4.1") &&
    !options.model.includes("o3") &&
    !options.model.includes("o4")
  ) {
    body.temperature = options.temperature;
  }

  // Add tools if provided
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }

  log(`Calling OpenAI Chat Completions (streaming) with ${options.model}...`);

  const startTime = performance.now();
  logOpenAIRequest(undefined, body);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseTimeMs = Math.round(performance.now() - startTime);

  if (!response.ok) {
    const errorText = await response.text();
    // Single attempt — these streaming paths have no retry loop, so any
    // failure here is terminal and `error` is the right level.
    logOpenAIAttemptFailure({ status: response.status, errorText, attempt: 0, maxRetries: 0 });
    logOpenAIResponse(response, responseTimeMs, undefined);

    if (response.status === 429) {
      throw new OpenAIRateLimitError();
    }
    if (response.status === 402) {
      throw new OpenAIPaymentRequiredError();
    }

    throw new OpenAIError(`OpenAI API error: ${response.status} - ${errorText}`, response.status);
  }

  // Log successful streaming response
  logOpenAIResponse(response, responseTimeMs, undefined);

  return response;
}

/**
 * Create a streaming response for edge functions
 * Transforms OpenAI streaming response and forwards it to the client
 */
export function createStreamingResponse(openAIResponse: Response, corsHeaders: Record<string, string>): Response {
  return new Response(openAIResponse.body, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Transform OpenAI streaming response with custom processing
 * Useful when you need to intercept/modify stream chunks
 */
export function transformStreamingResponse(
  openAIResponse: Response,
  corsHeaders: Record<string, string>,
  onChunk?: (chunk: string) => void,
): Response {
  const reader = openAIResponse.body?.getReader();
  if (!reader) {
    throw new OpenAIError("No response body for streaming", 500);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          if (onChunk) {
            onChunk(chunk);
          }
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (error) {
        logError("Stream error", { error: (error as Error).message });
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Parse SSE chunk to extract content delta
 * Returns null if chunk doesn't contain content
 */
export function parseSSEChunk(chunk: string): string | null {
  const lines = chunk.split("\n");
  let content = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
        }
      } catch {
        // Ignore parse errors for incomplete chunks
      }
    }
  }

  return content || null;
}

// ============================================
// SAVED PROMPT WITH STRUCTURED OUTPUT
// ============================================

/**
 * Structured output schema definition
 */
export interface StructuredOutputSchema {
  name: string;
  strict: boolean;
  schema: Record<string, any>;
}

/**
 * Options for calling saved prompt with structured output
 * Input can be either text messages or file IDs (strings)
 * fileIds can be provided separately to attach files to the conversation
 * Supports either a saved prompt (promptId) or a local prompt (promptText + model)
 */
export type SavedPromptStructuredOptions = (
  | { promptId: string; promptVersion?: string; promptText?: undefined; model?: undefined }
  | { promptText: string; model: string; promptId?: undefined; promptVersion?: undefined }
) & {
  variables: Record<string, string>;
  input: Array<{ role: "user" | "assistant"; content: string }> | string[];
  structuredOutput: StructuredOutputSchema;
  maxOutputTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * OpenAI processing tier. Supplied by spreading `modelFor("<task>")` for the
   * policies that opt in; omitted everywhere else, which leaves the account
   * default in force.
   */
  serviceTier?: "auto" | "default" | "flex" | "priority";
  fileIds?: string[];
  backgroundOptions?: BackgroundOptions;
  usageContext?: UsageTrackingContext;
  /**
   * Why this model. Supplied by spreading `modelFor("<task>")` — see
   * `model-policy.ts`. Folded into every usage row for the call, including the
   * failed attempts, so the recorded justification and the model actually sent
   * come from the same object and cannot drift.
   */
  policy?: UsagePolicy;
};

/**
 * Call OpenAI Responses API with a saved prompt and structured output schema
 * Returns the structured response matching the provided schema
 * Includes automatic retry on rate limits with exponential backoff
 * Supports background mode for long-running requests to avoid HTTP/gateway timeouts
 * Tracks usage if usageContext is provided
 */
export async function callOpenAIStructured<T = any>(
  options: SavedPromptStructuredOptions & { retryOptions?: RetryOptions }
): Promise<T> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  {
    const disabledFamily = await disabledFamilyFor(
      options.usageContext?.policy ?? options.policy,
      options.usageContext,
    );
    if (disabledFamily) throw new AiFeatureDisabledError(disabledFamily);
  }

  const useBackground = options.backgroundOptions?.enabled ?? false;
  const pollIntervalMs = options.backgroundOptions?.pollIntervalMs ?? 2000;
  const maxPollTimeMs = options.backgroundOptions?.maxPollTimeMs ?? 170000;

  const allowStore = await resolveOpenAIStore(options.usageContext);

  // Determine if input is file IDs (array of strings) or messages
  const isFileIds = Array.isArray(options.input) && 
    options.input.length > 0 && 
    typeof options.input[0] === "string";

  let inputPayload: any[];
  if (isFileIds) {
    // File IDs - format as input_file attachments
    const fileAttachments = (options.input as string[]).map((fileId) => ({
      type: "input_file" as const,
      file_id: fileId,
    }));
    inputPayload = [{ role: "user", content: fileAttachments }];
  } else {
    // Text messages - check if we need to attach fileIds to the first user message
    const messages = options.input as Array<{ role: string; content: string }>;
    
    if (options.fileIds && options.fileIds.length > 0) {
      // Attach file IDs to the conversation by prepending a user message with file attachments
      const fileAttachments = options.fileIds.map((fileId) => ({
        type: "input_file" as const,
        file_id: fileId,
      }));
      inputPayload = [
        { role: "user", content: fileAttachments },
        ...messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        }))
      ];
    } else {
      inputPayload = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));
    }
  }

  // Resolve language-specific quality instruction (if any) once per call.
  const qualityInstruction = await resolveQualityInstruction(options.usageContext);

  // For the promptText branch we can append the quality suffix directly to the
  // substituted instructions; for the saved-prompt branch there is no inline
  // instructions field, so we prepend a user message carrying the rules.
  let promptInput = inputPayload;
  if (qualityInstruction && !options.promptText) {
    promptInput = [
      { role: "user", content: [{ type: "input_text", text: qualityInstruction }] },
      ...inputPayload,
    ];
  }

  // Build prompt/model portion of the body depending on whether we have a local prompt or saved prompt
  const body: Record<string, any> = {
    ...(options.promptText
      ? {
          model: options.model,
          instructions: appendQualityInstruction(
            render(options.promptText, options.variables, { allowUnmatched: true }),
            qualityInstruction,
          ),
        }
      : {
          prompt: {
            id: options.promptId,
            ...(options.promptVersion && { version: options.promptVersion }),
            variables: options.variables,
          },
        }),
    input: promptInput,
    text: {
      format: {
        type: "json_schema",
        ...options.structuredOutput,
      },
    },
    ...(options.maxOutputTokens && { max_output_tokens: options.maxOutputTokens }),
    reasoning: { effort: options.reasoningEffort ?? "low" },
    ...(options.serviceTier && { service_tier: options.serviceTier }),
    // No retention at OpenAI unless the institution opted in; background mode
    // must be stored to be pollable, so there the stored copy is deleted after
    // the poll instead — see openai-retention.ts.
    store: allowStore || useBackground,
    ...(useBackground && { background: true }),
  };

  const { retryOptions, ...promptOptions } = options;
  const maxRetries = retryOptions?.maxRetries ?? 3;
  const initialDelayMs = retryOptions?.initialDelayMs ?? 10000;
  const useExponentialBackoff = retryOptions?.exponentialBackoff ?? true;
  const promptLabel = options.promptText ? `local prompt (${options.model})` : options.promptId;

  // Everything that stays constant across the attempts of this one logical
  // call, resolved once so that a failed attempt and the success that follows
  // it agree on the decision that produced them.
  //
  // `reasoningEffort` records what was actually sent, not what the policy
  // declared: study-tutor scales effort per turn, and the billed figure is the
  // one that explains the cost.
  const effectiveReasoningEffort = options.reasoningEffort ?? "low";
  // File ids arrive by two routes — `fileIds`, or an `input` that is an array
  // of bare id strings. Both are attachments, so both count.
  const fileCount =
    (options.fileIds?.length ?? 0) + (isFileIds ? (options.input as string[]).length : 0);

  const trackingContext: UsageTrackingContext | undefined = options.usageContext
    ? {
        ...options.usageContext,
        // Falls back to the saved-prompt id only. It used to fall back to
        // `promptLabel`, which for a local prompt is the literal string
        // "local prompt (gpt-5.4)" — fusing the model into the prompt column,
        // and going stale the moment the policy changed the model. The model
        // now has its own column, so the redundancy is worse than the gap:
        // a local prompt has no identity beyond its function, and NULL says
        // that honestly.
        promptKey: options.usageContext.promptKey || options.promptId || null,
        policy: options.usageContext.policy ?? options.policy,
        modelRequested: options.usageContext.modelRequested ?? options.model ?? null,
        reasoningEffort: options.usageContext.reasoningEffort ?? effectiveReasoningEffort,
        promptId: options.usageContext.promptId ?? options.promptId ?? null,
        promptVersion: options.usageContext.promptVersion ?? options.promptVersion ?? null,
        fileCount,
        backgroundMode: useBackground,
      }
    : undefined;

  // Fire-and-forget: a usage row must never be the reason a generation fails.
  const track = (usage: UsageData | null): void => {
    if (!trackingContext || !usage) return;
    trackAIUsage(usage, trackingContext).catch((err) => {
      logError("Failed to track AI usage", { error: (err as Error).message });
    });
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const modeLabel = useBackground ? " (background mode)" : "";
    log(`Calling OpenAI with ${promptLabel} and structured output${modeLabel}...${attempt > 0 ? ` (retry ${attempt}/${maxRetries})` : ""}`);

    const startTime = performance.now();
    logOpenAIRequest(promptLabel, body, attempt, maxRetries);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseTimeMs = Math.round(performance.now() - startTime);

    if (!response.ok) {
      const errorText = await response.text();
      logOpenAIResponse(response, responseTimeMs, promptLabel);

      // A failed attempt bills nothing itself, but it is the reason the call's
      // total cost is a multiple of its successful attempt's. Without a row the
      // retry is invisible to every cost query — which is exactly the gap that
      // made a cost spike unattributable.
      track(
        failedAttemptUsage({
          model: options.model ?? "unknown",
          outcome: outcomeForStatus(response.status),
          attemptNumber: attempt,
          responseTimeMs,
          httpStatus: response.status,
          errorMessage: errorText,
        }),
      );

      // Retry on rate limits (429), server errors (5xx), and transient 400 errors
      if (response.status === 429 || response.status >= 500 || isTransient400(response.status, errorText)) {
        if (attempt < maxRetries) {
          // Calculate delay with exponential backoff: initialDelay * 2^attempt
          const delayMs = useExponentialBackoff
            ? initialDelayMs * Math.pow(2, attempt)
            : initialDelayMs;
          logOpenAIAttemptFailure({
            status: response.status,
            errorText,
            attempt,
            maxRetries,
            retryInMs: delayMs,
            promptLabel: promptLabel,
          });
          await delay(delayMs);
          continue;
        }
        logOpenAIAttemptFailure({
          status: response.status,
          errorText,
          attempt,
          maxRetries,
          promptLabel: promptLabel,
        });
        if (response.status === 429) {
          throw new OpenAIRateLimitError();
        }
        throw new OpenAIServerError(`OpenAI server error: ${response.status} - ${errorText}`, response.status);
      }

      logOpenAIAttemptFailure({
        status: response.status,
        errorText,
        attempt,
        maxRetries,
        promptLabel: promptLabel,
      });
      if (response.status === 402) {
        throw new OpenAIPaymentRequiredError();
      }

      throw new OpenAIError(`OpenAI API error: ${response.status} - ${errorText}`, response.status);
    }

    let data = (await response.json()) as OpenAIResponse;
    logOpenAIResponse(response, responseTimeMs, promptLabel, data);

    // Handle background mode - poll until completion
    //
    // The poll wait is timed separately from the POST. Lumping them together
    // hid the whole cost of background mode: the POST returns in about a second
    // and the work happens during the polling, so every study-guide call used to
    // log a latency of ~1s regardless of how long it really took.
    let pollWaitMs = 0;
    if (useBackground && (data.status === "queued" || data.status === "in_progress")) {
      log(`Background response started with ID ${data.id}, polling for completion...`);
      const backgroundId = data.id;
      const pollStart = performance.now();
      try {
        data = await pollBackgroundResponse(
          backgroundId,
          apiKey,
          promptLabel,
          pollIntervalMs,
          maxPollTimeMs
        );
      } catch (err) {
        pollWaitMs = Math.round(performance.now() - pollStart);
        // A generation abandoned mid-poll was still computed, and OpenAI bills
        // for it — but the response is gone, so the tokens are unknowable.
        // Record the attempt anyway: an unexplained gap between our totals and
        // the OpenAI invoice is worth being able to see.
        const statusCode = err instanceof OpenAIError ? err.statusCode : 0;
        track(
          failedAttemptUsage({
            model: options.model ?? "unknown",
            outcome:
              statusCode === 504
                ? "poll_timeout"
                : statusCode > 0
                  ? outcomeForStatus(statusCode)
                  : "transport_error",
            attemptNumber: attempt,
            responseTimeMs: responseTimeMs + pollWaitMs,
            httpStatus: statusCode || null,
            errorMessage: (err as Error).message,
          }),
        );
        throw err;
      } finally {
        // Background forced `store: true`; without institutional opt-in the
        // stored copy is removed now that (or whether) the result is in hand.
        if (!allowStore) deleteStoredResponse(apiKey, backgroundId);
      }
      pollWaitMs = Math.round(performance.now() - pollStart);
    } else if (useBackground && !allowStore) {
      // Background response that completed inside the POST — still stored.
      deleteStoredResponse(apiKey, data.id);
    }

    // Track usage (fire-and-forget). An `incomplete` response lands here too,
    // recorded as its own attempt — it burned its output tokens in full and is
    // about to be retried, so charging both to one row would understate it.
    track(
      extractUsageData(data, responseTimeMs + pollWaitMs, {
        attemptNumber: attempt,
        apiLatencyMs: responseTimeMs,
        pollWaitMs: useBackground ? pollWaitMs : null,
      }),
    );

    // Check if the response is incomplete (hit token limit)
    if (data.status === "incomplete") {
      log(`OpenAI response was incomplete (likely hit token limit). Attempt ${attempt + 1}/${maxRetries + 1}`);
      if (attempt < maxRetries) {
        const delayMs = useExponentialBackoff
          ? initialDelayMs * Math.pow(2, attempt)
          : initialDelayMs;
        log(`Retrying after ${delayMs / 1000} seconds...`);
        await delay(delayMs);
        continue;
      }
      throw new OpenAIError("AI response was incomplete - the output may be too large. Try reducing the scope or breaking into smaller requests.", 500);
    }

    // Extract text content from message output
    const messageItem = data.output?.find(
      (item): item is OpenAIMessageOutput => item.type === "message"
    );

    if (messageItem?.content) {
      const textContent = messageItem.content.find((c) => c.type === "output_text");
      if (textContent?.text) {
        try {
          return JSON.parse(textContent.text) as T;
        } catch (e) {
          logError("Failed to parse structured output", { snippet: textContent.text.slice(0, 500) });
          throw new OpenAIError("Invalid JSON in structured output response", 500);
        }
      }
    }

    logError("No structured output found in response", { output: JSON.stringify(data.output) });
    throw new OpenAIError("No structured output found in response", 500);
  }

  throw new OpenAIRateLimitError();
}

/**
 * Call OpenAI Responses API with structured output and streaming enabled.
 * Returns the raw Response whose body is a ReadableStream of SSE events.
 *
 * The Responses API emits events like:
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","delta":"..."}
 *
 *   event: response.completed
 *   data: {"type":"response.completed", ...full response...}
 *
 * The caller is responsible for reading the stream and handling retries.
 */
export async function callOpenAIStructuredStreaming(
  options: Omit<SavedPromptStructuredOptions, "backgroundOptions">
): Promise<Response> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new OpenAIError("OPENAI_API_KEY is not configured", 500);
  }

  {
    const disabledFamily = await disabledFamilyFor(
      options.usageContext?.policy ?? options.policy,
      options.usageContext,
    );
    if (disabledFamily) throw new AiFeatureDisabledError(disabledFamily);
  }

  const isFileIds =
    Array.isArray(options.input) &&
    options.input.length > 0 &&
    typeof options.input[0] === "string";

  let inputPayload: any[];
  if (isFileIds) {
    const fileAttachments = (options.input as string[]).map((fileId) => ({
      type: "input_file" as const,
      file_id: fileId,
    }));
    inputPayload = [{ role: "user", content: fileAttachments }];
  } else {
    const messages = options.input as Array<{ role: string; content: string }>;
    if (options.fileIds && options.fileIds.length > 0) {
      const fileAttachments = options.fileIds.map((fileId) => ({
        type: "input_file" as const,
        file_id: fileId,
      }));
      inputPayload = [
        { role: "user", content: fileAttachments },
        ...messages.map((msg) => ({ role: msg.role, content: msg.content })),
      ];
    } else {
      inputPayload = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));
    }
  }

  const qualityInstruction = await resolveQualityInstruction(options.usageContext);

  let promptInput = inputPayload;
  if (qualityInstruction && !options.promptText) {
    promptInput = [
      { role: "user", content: [{ type: "input_text", text: qualityInstruction }] },
      ...inputPayload,
    ];
  }

  const body: Record<string, any> = {
    ...(options.promptText
      ? {
          model: options.model,
          instructions: appendQualityInstruction(
            render(options.promptText, options.variables, { allowUnmatched: true }),
            qualityInstruction,
          ),
        }
      : {
          prompt: {
            id: options.promptId,
            ...(options.promptVersion && { version: options.promptVersion }),
            variables: options.variables,
          },
        }),
    input: promptInput,
    text: {
      format: {
        type: "json_schema",
        ...options.structuredOutput,
      },
    },
    ...(options.maxOutputTokens && { max_output_tokens: options.maxOutputTokens }),
    reasoning: { effort: options.reasoningEffort ?? "low" },
    stream: true,
    // Non-background streaming needs no stored copy — the deltas are the
    // result — so retention follows the institution flag alone.
    store: await resolveOpenAIStore(options.usageContext),
  };

  const promptLabel = options.promptText
    ? `local prompt (${options.model})`
    : options.promptId;
  log(`Calling OpenAI with ${promptLabel} and structured output (streaming)...`);
  logOpenAIRequest(promptLabel, body);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Single attempt — these streaming paths have no retry loop, so any
    // failure here is terminal and `error` is the right level.
    logOpenAIAttemptFailure({ status: response.status, errorText, attempt: 0, maxRetries: 0 });

    if (response.status === 429) {
      throw new OpenAIRateLimitError();
    }
    if (response.status === 402) {
      throw new OpenAIPaymentRequiredError();
    }
    if (response.status >= 500) {
      throw new OpenAIServerError(
        `OpenAI server error: ${errorText}`,
        response.status,
      );
    }
    throw new OpenAIError(
      `OpenAI API error (${response.status}): ${errorText}`,
      response.status,
    );
  }

  return response;
}


