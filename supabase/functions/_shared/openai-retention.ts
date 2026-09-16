/**
 * Per-institution control over OpenAI request retention.
 *
 * Every Responses API call carries an explicit `store` flag. The default is
 * `false` — prompts and completions (pupil free-text, tutor transcripts,
 * course material) are not retained in the OpenAI dashboard — because the
 * OpenAI DPA and zero-data-retention status were unconfirmed when this was
 * written, an open item in the operator's private compliance records (not in
 * this repository — see docs/compliance/README.md). A super-admin can turn
 * retention on for one institution (`institutions.openai_store_enabled`, e.g.
 * to debug generation quality); nothing else may.
 *
 * Background-mode responses are the exception OpenAI forces: a background
 * response must be stored to be pollable, so those are created with
 * `store: true` and deleted from OpenAI once the result is in hand — see
 * `deleteStoredResponse`.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

/** Where the store decision is resolved from. `UsageTrackingContext` satisfies
 *  this shape, so call sites can pass their existing context straight through. */
export interface StoreResolutionContext {
  institutionId?: string | null;
  courseId?: string | null;
}

/** How long a resolved flag is trusted before the row is re-read. Short enough
 *  that flipping the super-admin toggle takes effect without a redeploy. */
const FLAG_TTL_MS = 60_000;

const flagCache = new Map<string, { value: boolean; expiresAt: number }>();
// A course's institution never changes, so this one has no TTL.
const courseInstitutionCache = new Map<string, string | null>();

/** Testing helper — clear both caches. */
export function _clearOpenAIStoreCache(): void {
  flagCache.clear();
  courseInstitutionCache.clear();
}

function serviceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

async function institutionIdForCourse(courseId: string): Promise<string | null> {
  if (courseInstitutionCache.has(courseId)) {
    return courseInstitutionCache.get(courseId) ?? null;
  }
  const supabase = serviceClient();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("courses")
    .select("institution_id")
    .eq("id", courseId)
    .single();
  if (error) {
    // Not cached: a transient failure should not pin "unknown" for the
    // lifetime of the isolate.
    logger.warn("Could not resolve course institution for store flag", {
      courseId,
      error: error.message,
    });
    return null;
  }
  const institutionId = (data?.institution_id as string | undefined) ?? null;
  courseInstitutionCache.set(courseId, institutionId);
  return institutionId;
}

/**
 * Whether OpenAI may retain (`store: true`) the request about to be sent.
 *
 * `false` unless the request can be attributed to an institution whose
 * super-admin-controlled `openai_store_enabled` flag is on. Every failure
 * mode — no context, unknown institution, lookup error — resolves to `false`:
 * the privacy-safe default is also the fallback.
 */
export async function resolveOpenAIStore(
  context?: StoreResolutionContext | null,
): Promise<boolean> {
  try {
    let institutionId = context?.institutionId ?? null;
    if (!institutionId && context?.courseId) {
      institutionId = await institutionIdForCourse(context.courseId);
    }
    if (!institutionId) return false;

    const cached = flagCache.get(institutionId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const supabase = serviceClient();
    if (!supabase) return false;
    const { data, error } = await supabase
      .from("institutions")
      .select("openai_store_enabled")
      .eq("id", institutionId)
      .single();
    if (error) {
      logger.warn("Could not resolve OpenAI store flag; defaulting to store:false", {
        institutionId,
        error: error.message,
      });
      return false;
    }
    const value = data?.openai_store_enabled === true;
    flagCache.set(institutionId, { value, expiresAt: Date.now() + FLAG_TTL_MS });
    return value;
  } catch (err) {
    logger.warn("Store flag resolution failed; defaulting to store:false", {
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Best-effort deletion of a stored response from OpenAI.
 *
 * Used after background-mode calls, which OpenAI only accepts with
 * `store: true`: once the terminal payload is in hand the stored copy has no
 * further purpose, so for institutions without the retention flag it is
 * removed. Fire-and-forget — a failed delete (e.g. the response is still
 * in progress after a poll timeout) costs retention, not correctness — but
 * registered with the runtime so the isolate does not shut down under it.
 */
export function deleteStoredResponse(apiKey: string, responseId: string): void {
  const work = fetch(`https://api.openai.com/v1/responses/${responseId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  }).then((res) => {
    if (!res.ok) {
      logger.warn("Could not delete stored OpenAI response", {
        responseId,
        status: res.status,
      });
    }
  });

  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (edgeRuntime) {
    edgeRuntime.waitUntil(work);
  } else {
    work.catch((error) =>
      logger.warn("Could not delete stored OpenAI response", {
        responseId,
        error: (error as Error).message,
      })
    );
  }
}
