/**
 * Moderation middleware for LLM wrapper functions
 * Provides automatic moderation of user inputs and LLM outputs
 */

import { moderateContent as moderateContentStandard } from "./moderation.ts";
import { OpenAIError } from "./openai-client.ts";
import { log, logWarn } from "./context-logger.ts";

/**
 * Moderation result compatible with the middleware
 * Adapts standard Moderation API result to work with existing code
 */
export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  flaggedCategories: string[];
  // Compatibility fields for existing code
  decision: "allow" | "block";
  reasons: string[];
  redactions: string[];
  redacted_text: string;
}

export interface ModerationMiddlewareOptions {
  /** Language code for language-aware moderation (e.g., 'en', 'el') */
  language?: string;
  /** Callback when input is blocked */
  onInputBlocked?: (result: ModerationResult, input: string) => void | Promise<void>;
  /** Callback when output is blocked */
  onOutputBlocked?: (result: ModerationResult, output: string) => void | Promise<void>;
  /** Whether to throw errors on blocked content (default: true) */
  throwOnBlocked?: boolean;
  /** Logger for moderation events */
  logger?: {
    info?: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
    error?: (msg: string, data?: Record<string, unknown>) => void;
    startTimer?: (operation: string) => () => void;
  };
}

export interface ModerationMiddlewareResult<T> {
  /** The result from the LLM call */
  result: T;
  /** Moderation result for the input (if moderated) */
  inputModeration?: ModerationResult;
  /** Moderation result for the output (if moderated) */
  outputModeration?: ModerationResult;
}

/**
 * Middleware function that wraps an LLM call with automatic moderation
 * 
 * @param llmCall - The LLM function to wrap
 * @param userInput - The user's input message to moderate
 * @param options - Moderation options
 * @returns The LLM result with moderation metadata
 */
export async function withModeration<T>(
  llmCall: () => Promise<T>,
  userInput: string,
  options: ModerationMiddlewareOptions = {}
): Promise<ModerationMiddlewareResult<T>> {
  const {
    language,
    onInputBlocked,
    onOutputBlocked,
    throwOnBlocked = true,
    logger,
  } = options;

  let inputModeration: ModerationResult | undefined;
  let outputModeration: ModerationResult | undefined;

  // ============ MODERATE USER INPUT ============
  if (userInput && userInput.trim().length > 0) {
    try {
      logger?.info?.("Moderating user input", {
        inputLength: userInput.length,
        language: language || "not specified",
      });

      // Use standard Moderation API
      const standardResult = await moderateContentStandard({ content: userInput });
      
      // Adapt to middleware format
      inputModeration = adaptModerationResult(standardResult);

      // Always log the full moderation result regardless of flagged status
      log("[MODERATION] User input moderation result:", {
        moderation: {
          input: userInput,
          inputLength: userInput.length,
          flagged: inputModeration.flagged,
          decision: inputModeration.decision,
          categories: inputModeration.categories,
          categoryScores: inputModeration.categoryScores,
          flaggedCategories: inputModeration.flaggedCategories,
          reasons: inputModeration.reasons,
          language: language || "not specified",
        },
      });

      logger?.info?.("Input moderation result", {
        moderation: {
          flagged: inputModeration.flagged,
          categories: inputModeration.categories,
          categoryScores: inputModeration.categoryScores,
          flaggedCategories: inputModeration.flaggedCategories,
          decision: inputModeration.decision,
          reasons: inputModeration.reasons,
          language: language || "not specified",
          input: userInput,
          inputLength: userInput.length,
        },
      });

      // Log warning for any flagged content
      if (inputModeration.flagged) {
        logWarn("[MODERATION] User input flagged", {
          input: userInput,
          flagged: inputModeration.flagged,
          categories: inputModeration.categories,
          flaggedCategories: inputModeration.flaggedCategories,
          categoryScores: inputModeration.categoryScores,
          inputLength: userInput.length,
        });
        logger?.warn?.("User input flagged by moderation", {
          moderation: {
            flagged: inputModeration.flagged,
            categories: inputModeration.categories,
            categoryScores: inputModeration.categoryScores,
            flaggedCategories: inputModeration.flaggedCategories,
            decision: inputModeration.decision,
            reasons: inputModeration.reasons,
            language: language || "not specified",
            input: userInput,
            inputLength: userInput.length,
          },
        });
      }

      // If flagged, treat as blocked
      if (inputModeration.flagged) {
        if (onInputBlocked) {
          await onInputBlocked(inputModeration, userInput);
        }

        if (throwOnBlocked) {
          throw new OpenAIError(
            `User input blocked by content moderation. Categories: ${inputModeration.flaggedCategories.join(", ") || "unknown"}`,
            403
          );
        }
      }
    } catch (error) {
      if (error instanceof OpenAIError && error.statusCode === 403) {
        throw error; // Re-throw moderation blocks
      }
      // Log but continue if moderation check fails (fail-open)
      logger?.error?.("Input moderation check failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  // ============ END INPUT MODERATION ============

  // ============ CALL LLM ============
  const endLlmTimer = logger?.startTimer?.("main-llm-call");
  const llmResult = await llmCall();
  endLlmTimer?.();
  // ============ END LLM CALL ============

  // ============ MODERATE LLM OUTPUT ============
  // Extract text content from the result
  const outputText = extractTextFromResult(llmResult);
  const endOutputModerationTimer = logger?.startTimer?.("output-moderation");

  if (outputText && outputText.trim().length > 0) {
    try {
      logger?.info?.("Moderating LLM output", {
        moderation: {
          outputLength: outputText.length,
          language: language || "not specified",
        },
      });

      // Use standard Moderation API
      const standardResult = await moderateContentStandard({ content: outputText });
      
      // Adapt to middleware format
      outputModeration = adaptModerationResult(standardResult);

      // Always log the full moderation result regardless of flagged status
      log("[MODERATION] LLM output moderation result:", {
        moderation: {
          output: outputText,
          outputLength: outputText.length,
          flagged: outputModeration.flagged,
          decision: outputModeration.decision,
          categories: outputModeration.categories,
          categoryScores: outputModeration.categoryScores,
          flaggedCategories: outputModeration.flaggedCategories,
          reasons: outputModeration.reasons,
          language: language || "not specified",
        },
      });

      logger?.info?.("Output moderation result", {
        moderation: {
          flagged: outputModeration.flagged,
          categories: outputModeration.categories,
          categoryScores: outputModeration.categoryScores,
          flaggedCategories: outputModeration.flaggedCategories,
          decision: outputModeration.decision,
          reasons: outputModeration.reasons,
          language: language || "not specified",
          output: outputText,
          outputLength: outputText.length,
        },
      });

      // Log warning for any flagged content
      if (outputModeration.flagged) {
        logWarn("[MODERATION] LLM output flagged", {
          output: outputText,
          flagged: outputModeration.flagged,
          categories: outputModeration.categories,
          flaggedCategories: outputModeration.flaggedCategories,
          categoryScores: outputModeration.categoryScores,
          outputLength: outputText.length,
        });
        logger?.warn?.("LLM output flagged by moderation", {
          moderation: {
            flagged: outputModeration.flagged,
            categories: outputModeration.categories,
            categoryScores: outputModeration.categoryScores,
            flaggedCategories: outputModeration.flaggedCategories,
            decision: outputModeration.decision,
            reasons: outputModeration.reasons,
            language: language || "not specified",
            output: outputText,
            outputLength: outputText.length,
          },
        });
      }

      // If flagged, treat as blocked
      if (outputModeration.flagged) {
        if (onOutputBlocked) {
          await onOutputBlocked(outputModeration, outputText);
        }

        if (throwOnBlocked) {
          throw new OpenAIError(
            `LLM output blocked by content moderation. Categories: ${outputModeration.flaggedCategories.join(", ") || "unknown"}`,
            403
          );
        }
      }
      endOutputModerationTimer?.();
    } catch (error) {
      endOutputModerationTimer?.();
      if (error instanceof OpenAIError && error.statusCode === 403) {
        throw error; // Re-throw moderation blocks
      }
      // Log but continue if moderation check fails (fail-open)
      logger?.error?.("Output moderation check failed", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  } else {
    endOutputModerationTimer?.();
  }
  // ============ END OUTPUT MODERATION ============

  return {
    result: llmResult,
    inputModeration,
    outputModeration,
  };
}

/**
 * Extract text content from various LLM result types
 */
function extractTextFromResult<T>(result: T): string {
  // Handle structured responses with assistant_text field
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    
    // Check for assistant_text field (common in tutor responses)
    if (typeof obj.assistant_text === "string") {
      return obj.assistant_text;
    }
    
    // Check for content field
    if (typeof obj.content === "string") {
      return obj.content;
    }
    
    // Check for message field
    if (typeof obj.message === "string") {
      return obj.message;
    }
    
    // If it's an array, try to extract text from items
    if (Array.isArray(result)) {
      return result
        .map((item) => extractTextFromResult(item))
        .filter(Boolean)
        .join("\n");
    }
    
    // Try to stringify and extract text (for complex objects)
    try {
      const jsonString = JSON.stringify(result);
      // Return a reasonable substring for moderation
      return jsonString.length > 5000 ? jsonString.substring(0, 5000) : jsonString;
    } catch {
      // If stringification fails, return empty
      return "";
    }
  }
  
  // If it's already a string, return it
  if (typeof result === "string") {
    return result;
  }
  
  return "";
}

/**
 * Adapt standard Moderation API result to middleware format
 */
function adaptModerationResult(
  standardResult: {
    flagged: boolean;
    categories: Record<string, boolean>;
    categoryScores: Record<string, number>;
    flaggedCategories: string[];
  }
): ModerationResult {
  return {
    ...standardResult,
    // Compatibility fields
    decision: standardResult.flagged ? "block" : "allow",
    reasons: standardResult.flaggedCategories.map(
      (cat) => `Flagged for ${cat} (score: ${standardResult.categoryScores[cat]?.toFixed(3) || "N/A"})`
    ),
    redactions: [],
    redacted_text: "",
  };
}

