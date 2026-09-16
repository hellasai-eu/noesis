/**
 * Per-school AI feature toggles (compliance redline G8).
 *
 * `institutions.ai_features_disabled` lists the AI feature families a school's
 * own admin has switched off. Every OpenAI entry point in `openai-client.ts`
 * and `openai-stream.ts` resolves the calling institution and refuses to send
 * the request when its family is on that list — so the toggle is enforced at
 * the same chokepoint that decides `store:` (see `openai-retention.ts`, whose
 * resolution pattern and caches this module mirrors).
 *
 * A family is derived from the model-policy key's namespace, which every call
 * already carries for the usage ledger:
 *
 *   tutoring.*                              → "tutoring"
 *   grading.*                               → "grading"
 *   analytics.*                             → "analytics"
 *   question-bank.* study-guide.* materials.* → "generation"
 *   moderation.*                            → exempt — safety screening is not
 *                                             a feature a school opts out of
 *
 * Failure direction: this is a policy control, not a safety boundary. A call
 * that cannot be attributed to an institution, or whose flag read fails, runs
 * — the same availability-over-enforcement trade the moderation gate makes,
 * stated here so it is a decision rather than an accident. The flag itself is
 * re-read on a short TTL so an admin's toggle takes effect without a redeploy.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

/** The school-facing toggle families, in display order. */
export const AI_FEATURE_FAMILIES = [
  "tutoring",
  "grading",
  "analytics",
  "generation",
] as const;
export type AiFeatureFamily = (typeof AI_FEATURE_FAMILIES)[number];

/** What the gate needs to know about the call. `UsageTrackingContext` and
 *  `UsagePolicy` satisfy these shapes, so call sites pass what they have. */
export interface GateResolutionContext {
  institutionId?: string | null;
  courseId?: string | null;
}
export interface GatePolicy {
  policyKey?: string;
}

const FAMILY_BY_NAMESPACE: Record<string, AiFeatureFamily> = {
  "tutoring": "tutoring",
  "grading": "grading",
  "analytics": "analytics",
  "question-bank": "generation",
  "study-guide": "generation",
  "materials": "generation",
};

/** The toggle family for a model-policy key, or null when the call is not
 *  gated (moderation, or a key from outside the known namespaces). */
export function familyForPolicyKey(policyKey?: string | null): AiFeatureFamily | null {
  if (!policyKey) return null;
  const namespace = policyKey.split(".", 1)[0];
  return FAMILY_BY_NAMESPACE[namespace] ?? null;
}

/** How long a resolved list is trusted before the row is re-read. */
const FLAG_TTL_MS = 60_000;

const disabledCache = new Map<string, { value: Set<string>; expiresAt: number }>();
// A course's institution never changes, so this one has no TTL.
const courseInstitutionCache = new Map<string, string | null>();

/** Testing helper — clear both caches. */
export function _clearAiFeatureGateCache(): void {
  disabledCache.clear();
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
    logger.warn("Could not resolve course institution for AI feature gate", {
      courseId,
      error: error.message,
    });
    return null;
  }
  const institutionId = (data?.institution_id as string | undefined) ?? null;
  courseInstitutionCache.set(courseId, institutionId);
  return institutionId;
}

async function disabledFamilies(institutionId: string): Promise<Set<string>> {
  const cached = disabledCache.get(institutionId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const supabase = serviceClient();
  if (!supabase) return new Set();
  const { data, error } = await supabase
    .from("institutions")
    .select("ai_features_disabled")
    .eq("id", institutionId)
    .single();
  if (error) {
    logger.warn("Could not resolve AI feature toggles; treating all as enabled", {
      institutionId,
      error: error.message,
    });
    return new Set();
  }
  const raw = data?.ai_features_disabled;
  const value = new Set(Array.isArray(raw) ? raw.filter((f) => typeof f === "string") : []);
  disabledCache.set(institutionId, { value, expiresAt: Date.now() + FLAG_TTL_MS });
  return value;
}

/**
 * The family this call belongs to, when the calling school has switched that
 * family off — null when the call may proceed (not gated, unattributable, or
 * the family is enabled).
 */
export async function disabledFamilyFor(
  policy?: GatePolicy | null,
  context?: GateResolutionContext | null,
): Promise<AiFeatureFamily | null> {
  try {
    const family = familyForPolicyKey(policy?.policyKey);
    if (!family) return null;

    let institutionId = context?.institutionId ?? null;
    if (!institutionId && context?.courseId) {
      institutionId = await institutionIdForCourse(context.courseId);
    }
    if (!institutionId) return null;

    const disabled = await disabledFamilies(institutionId);
    return disabled.has(family) ? family : null;
  } catch (err) {
    logger.warn("AI feature gate resolution failed; allowing the call", {
      error: (err as Error).message,
    });
    return null;
  }
}
