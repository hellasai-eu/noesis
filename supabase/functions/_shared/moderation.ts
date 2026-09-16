import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "./context-logger.ts";

export interface ModerationResult {
  /**
   * The decision this call site should act on: OpenAI's own verdict, minus any
   * category `thresholds` tolerated. With no `thresholds` it is OpenAI's
   * verdict verbatim.
   */
  flagged: boolean;
  /** OpenAI's raw category booleans, untouched by `thresholds`. */
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  /** Categories that flagged *and* survived `thresholds`. Drives `flagged`. */
  flaggedCategories: string[];
  /**
   * Categories OpenAI flagged that a threshold tolerated. Empty unless
   * `thresholds` was passed. Kept out of `flaggedCategories` so the decision
   * stays clean, and kept in the result so callers can log what was let
   * through rather than silently losing it.
   *
   * Note what this deliberately is *not*. A tolerated flag does not block, so
   * nothing durable is written for it: no `role='moderation'` row, no
   * `flagged_content` row. Both of those records mean "this was withheld" —
   * the first is what the client renders as the session-paused notice, the
   * second is the super-admin review queue, and both keep the offending text
   * verbatim. Writing suppressions into either would corrupt that meaning and
   * durably retain, for platform staff to read, pupil messages the system had
   * just judged acceptable.
   *
   * So the calibration trail is the function logs, and is only as durable as
   * log retention. If these thresholds ever need tuning over months rather
   * than weeks, the right shape is a separate content-free counter — category
   * and score, no text — not a widened `flagged_content`.
   */
  suppressedCategories: string[];
}

/** Per-category ceiling: below it, a flag from that category is tolerated. */
export type CategoryThresholds = Record<string, number>;

/**
 * `omni-moderation-latest` supersedes the `text-moderation-*` line the API
 * defaults to when `model` is omitted. Better calibrated, and materially
 * better outside English — which matters here, where lessons run in Greek.
 */
export const MODERATION_MODEL = "omni-moderation-latest";

/**
 * Sensitivity for the tutor chat gates (pupil input in `chat-turn.ts`,
 * assistant replies in `assistant-moderation.ts`).
 *
 * OpenAI's built-in thresholds are set for a general consumer product. A
 * classroom is not one: a history lesson on a war, or a literature seminar on a
 * violent text, scores on these categories without being the thing the gate
 * exists to catch. And the consequence here is severe — either gate pauses the
 * session and puts it in front of an instructor — so a false positive costs a
 * pupil their lesson, not a retry.
 *
 * Only these two are loosened, and only these two should be. The safeguarding
 * categories (`sexual/minors`, the `self-harm/*` family) and every other
 * category keep OpenAI's own thresholds, because there is no curriculum reading
 * of those that a tutor should be handling on its own.
 *
 * `hate` sits tighter than `violence`: a lesson has legitimate cause to
 * describe violence, far less to contain hate speech itself.
 *
 * `harassment` was loosened here too, at 0.85, and is not any more. It had
 * inherited an argument made for the other two without meeting it. OpenAI
 * defines the category as language harassing *a target*, and curriculum
 * material is rarely that: it describes violence (→ `violence`) or quotes a
 * slur (→ `hate`, already the tightest ceiling). What the category does catch
 * is second-person abuse aimed at the tutor, which is the case a school most
 * wants surfaced rather than tolerated. A pupil sending "fuck you" scored
 * `harassment` at 0.842 — flagged by OpenAI, suppressed by the 0.85 ceiling,
 * lesson continued, nobody told. That is the miss this removes; the ceiling
 * had been sitting directly on top of the real-abuse band.
 */
export const CHAT_MODERATION_THRESHOLDS: CategoryThresholds = {
  violence: 0.9,
  hate: 0.7,
};

export interface ModerationOptions {
  /** The content to moderate - can be a string or array of strings */
  content: string | string[];
  /** OpenAI API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Moderation model. Defaults to `MODERATION_MODEL`. */
  model?: string;
  /**
   * Per-category score ceilings applied over OpenAI's verdict. A flagged
   * category whose score falls below its ceiling is tolerated; a category with
   * no entry here is never tolerated, so this can only ever *loosen* the
   * categories it names and never weakens the ones it omits.
   *
   * Omitted by the batch callers, which are not on a pupil's critical path and
   * can afford OpenAI's defaults. Set by the chat gates, where a false positive
   * pauses a lesson — see `CHAT_MODERATION_THRESHOLDS`.
   */
  thresholds?: CategoryThresholds;
  /**
   * Abort the call after this many milliseconds. Omitted by every batch
   * caller — they are not on an interactive path and a slow answer is
   * cheaper than a lost one. Set by the tutors, where the pupil is waiting.
   */
  timeoutMs?: number;
}

export interface FlaggedContentData {
  type: string;
  [key: string]: unknown;
}

export interface SaveFlaggedContentOptions {
  supabase: SupabaseClient;
  data: FlaggedContentData;
  description: string;
  logger?: { error: (msg: string, data?: Record<string, unknown>) => void };
}

/**
 * Moderates content using OpenAI's Moderation API
 * @returns ModerationResult with flagged status and categories
 */
export async function moderateContent(options: ModerationOptions): Promise<ModerationResult> {
  const apiKey = options.apiKey || Deno.env.get("OPENAI_API_KEY");
  
  if (!apiKey) {
    throw new Error("OpenAI API key not configured for moderation");
  }

  const contentToModerate = Array.isArray(options.content) 
    ? options.content.join("\n") 
    : options.content;

  const response = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model ?? MODERATION_MODEL,
      input: contentToModerate,
    }),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    log("[MODERATION API] Error response:", {
      status: response.status,
      statusText: response.statusText,
      body: errorBody,
    });
    throw new Error(`Moderation API error: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  const moderationData = result.results?.[0];

  if (!moderationData) {
    throw new Error("No moderation result received");
  }

  const categories = moderationData.categories || {};
  const categoryScores = moderationData.category_scores || {};
  
  // Get list of flagged category names
  const rawFlaggedCategories = Object.entries(categories)
    .filter(([_, flagged]) => flagged)
    .map(([category]) => category);

  const { flagged, flaggedCategories, suppressedCategories } = applyThresholds(
    moderationData.flagged === true,
    rawFlaggedCategories,
    categoryScores,
    options.thresholds,
  );

  // Always log the full moderation API response including the text
  log("[MODERATION API] Full response:", {
    moderation: {
      id: result.id,
      model: result.model,
      input: contentToModerate,
      inputLength: contentToModerate.length,
      flagged,
      flaggedByApi: moderationData.flagged,
      categories: categories,
      categoryScores: categoryScores,
      flaggedCategories: flaggedCategories,
      suppressedCategories: suppressedCategories,
    },
  });

  return {
    flagged,
    categories,
    categoryScores,
    flaggedCategories,
    suppressedCategories,
  };
}

/**
 * Re-decides OpenAI's verdict against per-category ceilings.
 *
 * Subtractive by construction: it starts from the categories OpenAI flagged and
 * can only drop one, never add. A category with no threshold, or one scoring at
 * or above its threshold, is kept — so a message that trips both `violence` at
 * 0.4 and `sexual/minors` at 0.4 still blocks on the latter.
 */
function applyThresholds(
  apiFlagged: boolean,
  rawFlaggedCategories: string[],
  categoryScores: Record<string, number>,
  thresholds?: CategoryThresholds,
): { flagged: boolean; flaggedCategories: string[]; suppressedCategories: string[] } {
  if (!apiFlagged || !thresholds) {
    return {
      flagged: apiFlagged,
      flaggedCategories: rawFlaggedCategories,
      suppressedCategories: [],
    };
  }

  const kept: string[] = [];
  const suppressed: string[] = [];

  for (const category of rawFlaggedCategories) {
    const threshold = thresholds[category];
    const score = categoryScores[category];
    // A missing score means the API named a category without saying how
    // strongly it scored. Keep it: an unmeasurable flag is not a tolerable one.
    if (threshold !== undefined && typeof score === "number" && score < threshold) {
      suppressed.push(category);
    } else {
      kept.push(category);
    }
  }

  return {
    flagged: kept.length > 0,
    flaggedCategories: kept,
    suppressedCategories: suppressed,
  };
}

/**
 * Saves flagged content to the flagged_content table for admin review
 */
export async function saveFlaggedContent(options: SaveFlaggedContentOptions): Promise<boolean> {
  const { supabase, data, description, logger } = options;

  const { error } = await supabase
    .from("flagged_content")
    .insert({
      data,
      description,
    });

  if (error) {
    if (logger) {
      logger.error("Failed to save flagged content", { error });
    }
    return false;
  }

  return true;
}

/**
 * Moderates content and saves to flagged_content table if flagged
 * @returns Object with moderation result and whether content passed
 */
export async function moderateAndSave(options: {
  content: string | string[];
  supabase: SupabaseClient;
  flaggedData: FlaggedContentData;
  descriptionPrefix: string;
  apiKey?: string;
  logger?: { 
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}): Promise<{ passed: boolean; result: ModerationResult }> {
  const { content, supabase, flaggedData, descriptionPrefix, apiKey, logger } = options;

  const result = await moderateContent({ content, apiKey });

  if (result.flagged) {
    if (logger) {
      logger.warn("Content flagged by moderation", { 
        categories: result.flaggedCategories 
      });
    }

    const description = `${descriptionPrefix}: ${result.flaggedCategories.join(", ") || "unknown categories"}`;
    
    await saveFlaggedContent({
      supabase,
      data: flaggedData,
      description,
      logger,
    });

    return { passed: false, result };
  }

  return { passed: true, result };
}

/**
 * Batch moderate multiple items and filter out flagged ones
 * Saves all flagged items to the database
 */
export async function moderateItems<T>(options: {
  items: T[];
  getContent: (item: T) => string | string[];
  getFlaggedData: (item: T) => FlaggedContentData;
  descriptionPrefix: string;
  supabase: SupabaseClient;
  apiKey?: string;
  logger?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
}): Promise<{ passed: T[]; flagged: T[]; }> {
  const { items, getContent, getFlaggedData, descriptionPrefix, supabase, apiKey, logger } = options;

  const passed: T[] = [];
  const flagged: T[] = [];

  for (const item of items) {
    try {
      const content = getContent(item);
      const { passed: itemPassed } = await moderateAndSave({
        content,
        supabase,
        flaggedData: getFlaggedData(item),
        descriptionPrefix,
        apiKey,
        logger,
      });

      if (itemPassed) {
        passed.push(item);
      } else {
        flagged.push(item);
      }
    } catch (error) {
      // If moderation fails, skip the item for safety
      if (logger) {
        logger.error("Moderation failed for item, skipping", { error: error instanceof Error ? error.message : String(error) });
      }
      flagged.push(item);
    }
  }

  if (logger) {
    logger.info("Moderation complete", { 
      total: items.length, 
      passed: passed.length, 
      flagged: flagged.length 
    });
  }

  return { passed, flagged };
}
