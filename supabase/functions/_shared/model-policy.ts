/**
 * Model policy registry — the single place that decides which model answers
 * which task, and the only place that records why.
 *
 * Before this file, model ids were string literals at ~29 call sites (`"gpt-5.4"`
 * alone appeared eight times) and the reasoning behind them lived in prose
 * comments, unreadable to SQL. So `ai_usage_logs` could say *which* model
 * answered but never *why it was asked*, and "does the flagship tier earn its
 * keep?" was a code-archaeology question rather than a query.
 *
 * A handler now names a task, not a model:
 *
 *     const policy = modelFor("study-guide.outline");
 *     await callOpenAIStructured({ ...policy, promptText, ... });
 *
 * `modelFor` returns `model` and `reasoningEffort` ready to spread, plus a
 * `policy` block that `callOpenAIStructured` folds into the usage row. The
 * logged justification and the model actually called therefore come from one
 * object and cannot drift apart — which is the failure mode of annotating call
 * sites by hand.
 *
 * ## Changing a policy
 *
 * Edit the entry and bump its `version`. The version is what makes a usage
 * regression legible after the fact:
 *
 *     SELECT policy_version, model, avg(total_tokens), count(*)
 *       FROM ai_usage_logs
 *      WHERE policy_key = 'study-guide.outline'
 *      GROUP BY 1, 2;
 *
 * Without a bump, a downgrade from Sol to Terra looks identical to a quiet
 * month. `rationale` is documentation, not a logged column — it is fixed per
 * (policy_key, version), so storing it on every row would be pure repetition.
 *
 * Note there is no rate anywhere in this file, by design: token counts stay
 * true forever, prices do not. Convert to money outside the app against
 * whatever OpenAI charges that day.
 */

export type ReasoningEffort = "low" | "medium" | "high";

/**
 * OpenAI's processing tier. Omitted means the account default.
 *
 * This is a latency knob, not a capability one — the same model on `priority`
 * answers the same way, sooner and dearer. So it belongs only on the calls a
 * person is sitting and waiting for, and is deliberately absent from every
 * batch policy: nothing is served by a flashcard generator jumping the queue.
 */
export type ServiceTier = "auto" | "default" | "flex" | "priority";

/**
 * Capability/cost class, derived from the model rather than declared per policy
 * — a tier is a fact about the model, and hand-declaring it invites
 * `model: "gpt-5.4"` sitting next to `tier: "flagship"` forever.
 *
 * Deliberately a RELATIVE ordering with no rates attached. Which models are
 * peers of each other is stable; what they charge is not, and a dollar figure
 * written here would be wrong within a release or two. The tier is what makes
 * "we moved this task down a tier and usage fell by half" answerable, and that
 * question never needed the absolute number.
 */
export type ModelTier = "flagship" | "balanced" | "standard" | "mini" | "image";

export const MODEL_TIERS: Record<string, ModelTier> = {
  // Most capable and most expensive of their generation.
  "gpt-5.6-sol": "flagship",
  "gpt-5.5": "flagship",
  // Roughly half the flagship rate; the default for bulk work.
  "gpt-5.6-terra": "balanced",
  "gpt-5.4": "balanced",
  // Older or narrower flagships, cheaper than the current balanced tier.
  "gpt-5.2": "standard",
  "gpt-5.1": "standard",
  "gpt-5-2025-08-07": "standard",
  "gpt-4.1": "standard",
  "o3-2025-04-16": "standard",
  "o4-mini-2025-04-16": "standard",
  // An order of magnitude below the balanced tier.
  "gpt-5.6-luna": "mini",
  "gpt-5.4-mini": "mini",
  "gpt-4.1-mini-2025-04-14": "mini",
  "gpt-5-nano-2025-08-07": "mini",
  // Billed per image rather than per token, so its rows carry no token counts.
  "gpt-image-2": "image",
};

/**
 * Coarse product area. This is the grain at which the cost question is
 * actually asked — "why are tutoring costs up 30%" is one `WHERE feature =`,
 * where `function_name` alone would need the asker to already know that
 * tutoring means study-tutor *and* socratic-chat.
 */
export type Feature =
  | "tutoring"
  | "study-guide"
  | "question-bank"
  | "grading"
  | "materials"
  | "analytics"
  | "moderation"
  | "media";

interface PolicyEntry {
  model: string;
  /**
   * The effort this task is *meant* to run at. A handler may override it per
   * call (study-tutor scales effort to the session); the usage row records the
   * effort actually sent, since that is what was billed.
   */
  reasoningEffort: ReasoningEffort;
  /**
   * Processing tier. Omit for the account default; set `priority` only where a
   * pupil or teacher is watching a cursor blink.
   */
  serviceTier?: ServiceTier;
  feature: Feature;
  /** Bump on any change to `model`, `reasoningEffort` or `serviceTier`. */
  version: number;
  /** Why this model, for the next person who wonders. Not logged. */
  rationale: string;
}

export const MODEL_POLICY = {
  // ---------------------------------------------------------------- tutoring
  "tutoring.study-tutor": {
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    serviceTier: "priority",
    feature: "tutoring",
    version: 4,
    rationale:
      "Short, high-frequency conversational replies where latency is what the " +
      "student feels — not a hard reasoning task. v1 was gpt-5.5 on an " +
      "adaptive ladder reaching high; v2 is the balanced tier at low. Name " +
      "the tier: bare \"gpt-5.6\" aliases to Sol. v3 added priority " +
      "processing, this being the one policy where a pupil watches the reply " +
      "arrive. v4 rewires adaptiveReasoningEffort(): the medium override used " +
      "to fire on frustration > 0.7, the model's read of a mood, and now fires " +
      "on evidence from the lesson — deep hinting, a hint that did not land, " +
      "or a wrong answer against a named misconception. Expect the effort mix " +
      "on this key to shift; that is what the bump is for.",
  },
  "tutoring.socratic-chat": {
    model: "gpt-5.6-terra",
    reasoningEffort: "low",
    serviceTier: "priority",
    feature: "tutoring",
    version: 3,
    rationale:
      "Same student-facing bar as study-tutor, and the two get compared " +
      "against each other — a tier split between them would confound that. " +
      "v1 was gpt-5.5 at medium; v2 matches the tutor's move to Terra at low; " +
      "v3 matches its move to priority, for the same reason the split would " +
      "otherwise confound the comparison.",
  },
  "tutoring.suggest-sessions": {
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    feature: "tutoring",
    version: 1,
    rationale:
      "Reads one chapter and proposes at most three session briefings for an " +
      "instructor to review before any student sees them — a human gate the " +
      "two conversational tutoring policies above do not have, which is what " +
      "keeps this off the flagship tier. Effort is medium rather than low " +
      "because splitting a chapter into non-overlapping slices in a sensible " +
      "teaching order is a planning task, not a phrasing one; it runs once " +
      "per chapter, so the extra effort is cheap here in a way it is not for " +
      "a per-turn reply.",
  },

  // ------------------------------------------------------------- study guide
  "study-guide.outline": {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    feature: "study-guide",
    version: 1,
    rationale:
      "Decides the structure once per guide; every theory and questions call " +
      "afterwards inherits its decisions and cannot repair a bad one. Runs " +
      "once against the 2N piece calls that follow, so a 5-piece guide pays " +
      "the flagship rate once rather than eleven times — which is what makes " +
      "the top tier affordable exactly here and nowhere else in the guide.",
  },
  "study-guide.theory": {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    feature: "study-guide",
    version: 1,
    rationale:
      "Works inside a scope the outline already fixed, and runs 2N times per " +
      "guide. Depth comes from effort:high, not from the tier.",
  },
  "study-guide.questions": {
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    feature: "study-guide",
    version: 1,
    rationale:
      "Same bounded scope and same 2N multiplier as the theory call. Answers " +
      "are immutable once a student submits, so effort stays high even though " +
      "the tier does not.",
  },
  "study-guide.analyze": {
    model: "gpt-5.2",
    reasoningEffort: "medium",
    feature: "study-guide",
    version: 1,
    rationale:
      "Instructor-facing summarisation over material the guide already " +
      "contains — comprehension, not generation, so the standard tier holds.",
  },

  // ----------------------------------------------------------- question bank
  "question-bank.mcq": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "question-bank",
    version: 1,
    rationale:
      "Bulk generation an instructor reviews and can delete before students " +
      "ever see it, so a weak item costs a click rather than a grade. Volume " +
      "makes the balanced tier the whole question-bank default.",
  },
  "question-bank.open": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "question-bank",
    version: 1,
    rationale: "Instructor-reviewed bulk generation — see question-bank.mcq.",
  },
  "question-bank.fill-gaps": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "question-bank",
    version: 1,
    rationale:
      "Instructor-reviewed bulk generation, with the extra constraint of the " +
      "{{N}} placeholder contract — enforced by the prompt and a validator, " +
      "not by buying a bigger model.",
  },
  "question-bank.ordering": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "question-bank",
    version: 1,
    rationale: "Instructor-reviewed bulk generation — see question-bank.mcq.",
  },
  "question-bank.classification": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "question-bank",
    version: 1,
    rationale: "Instructor-reviewed bulk generation — see question-bank.mcq.",
  },
  "question-bank.student-questions": {
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    feature: "question-bank",
    version: 1,
    rationale:
      "Practice items generated on demand for one student, from material " +
      "already narrowed by their progress. Per-student volume with no " +
      "instructor review pass makes cost the binding constraint.",
  },
  "question-bank.similarity": {
    model: "gpt-5.4",
    reasoningEffort: "low",
    feature: "question-bank",
    version: 1,
    rationale:
      "Pairwise near-duplicate judgement over short texts. Low effort " +
      "deliberately: the task is comparison, and reasoning tokens on it buy " +
      "nothing measurable.",
  },

  // ----------------------------------------------------------------- grading
  "grading.open-answer-draft": {
    model: "gpt-5.4",
    reasoningEffort: "low",
    feature: "grading",
    version: 1,
    rationale:
      "Drafts qualitative review notes (never a number) on an open answer " +
      "for the instructor who will grade it. Instructor-only until released, " +
      "but it still shapes a human judgement about a pupil, which keeps it a " +
      "tier above the mini validators. Stays in the grading namespace so the " +
      "school-facing grading toggle governs it.",
  },
  "grading.deterministic-validator": {
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    feature: "grading",
    version: 1,
    rationale:
      "Second opinion on an answer a deterministic comparison already " +
      "decided. It only has to catch equivalent-but-differently-spelled " +
      "answers, and runs on every submitted answer.",
  },
  "grading.fill-gaps-judge": {
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    feature: "grading",
    version: 1,
    rationale:
      "Same narrow equivalence question as the deterministic validator, per " +
      "gap. Fires once per submitted fill-gaps answer, so per-call cost " +
      "dominates per-call quality.",
  },

  // --------------------------------------------------------------- materials
  "materials.detect-chapters": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "materials",
    version: 1,
    rationale:
      "Runs once per uploaded PDF and everything downstream is scoped by its " +
      "output, but a wrong boundary is visible and fixable by the instructor " +
      "on the spot — so it takes effort rather than tier.",
  },
  "materials.chapter-summary": {
    model: "gpt-5.4",
    reasoningEffort: "low",
    feature: "materials",
    version: 1,
    rationale:
      "Summarisation of a bounded chapter with the source in context. " +
      "Once per chapter, instructor-reviewed.",
  },
  "materials.extract-competencies": {
    model: "gpt-5.4",
    reasoningEffort: "low",
    feature: "materials",
    version: 1,
    rationale:
      "Extraction from supplied text, run once per material. Its output " +
      "seeds evaluation, so it is not on the mini tier.",
  },
  "materials.flashcards": {
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    feature: "materials",
    version: 1,
    rationale:
      "Short recall pairs from a chapter already in context — the least " +
      "demanding generation in the product. Note the inline fallback when no " +
      "openai_file_id exists: it ships up to 500k characters as input, so " +
      "watch file_count = 0 rows before blaming the model for the cost.",
  },
  "materials.cheatsheet": {
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    feature: "materials",
    version: 1,
    rationale:
      "Condensation of material already in context, instructor-reviewed. " +
      "Carries the same inline-content fallback as flashcards.",
  },

  // --------------------------------------------------------------- analytics
  "analytics.quiz": {
    model: "gpt-5.2",
    reasoningEffort: "medium",
    feature: "analytics",
    version: 1,
    rationale:
      "Reads aggregate quiz results and writes prose for an instructor. " +
      "Statistics, not pedagogy — and nothing downstream consumes it.",
  },
  "analytics.student-evaluation": {
    model: "gpt-5.4",
    reasoningEffort: "low",
    feature: "analytics",
    version: 1,
    rationale:
      "Narrative about one named student that an instructor may pass on to " +
      "a parent. Consequence, not difficulty, is what keeps it off the mini " +
      "tier.",
  },
  "analytics.evaluation-timeline": {
    model: "gpt-5.4",
    reasoningEffort: "medium",
    feature: "analytics",
    version: 1,
    rationale:
      "Reads a student's evaluation history and writes the trend across it. " +
      "Matched to analytics.student-evaluation, which produced the rows it " +
      "reads — a weaker model here would draw conclusions the source material " +
      "does not support. Auto-fires whenever an instructor opens Student 360 " +
      "for a student with 2+ evaluations and no cached analysis.",
  },
  "analytics.cluster-students": {
    model: "gpt-5.4-mini",
    reasoningEffort: "low",
    feature: "analytics",
    version: 1,
    rationale:
      "Groups students by performance vectors that are already computed. The " +
      "model labels and explains the grouping; it does not derive it.",
  },

  // -------------------------------------------------------------- moderation
  "moderation.study-image": {
    model: "gpt-4.1",
    reasoningEffort: "low",
    feature: "moderation",
    version: 1,
    rationale:
      "Vision safety gate on a generated study image before a student sees " +
      "it. Needs image input and a fast, unambiguous verdict, not reasoning " +
      "depth.",
  },
} as const satisfies Record<string, PolicyEntry>;

export type PolicyKey = keyof typeof MODEL_POLICY;

/** The decision, as it lands in `ai_usage_logs`. */
export interface UsagePolicy {
  feature: Feature;
  policyKey: string;
  policyVersion: number;
  modelTier: ModelTier | "unknown";
}

export interface ResolvedPolicy {
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Present only for the policies that opt into a non-default tier. */
  serviceTier?: ServiceTier;
  policy: UsagePolicy;
}

/**
 * Resolve a task key to the model that serves it, together with the decision
 * metadata to log. Spread the result into a `callOpenAIStructured` call:
 *
 *     const policy = modelFor("materials.flashcards");
 *     await callOpenAIStructured({ ...policy, promptText, variables, input, ... });
 *
 * To deviate for one call, override after the spread — `{ ...policy,
 * reasoningEffort: "high" }`. The row then records the effort actually sent
 * alongside the policy it deviated from, which is the shape that makes the
 * deviation findable.
 */
export function modelFor(key: PolicyKey): ResolvedPolicy {
  // Widened to `PolicyEntry` deliberately. `MODEL_POLICY` is `as const`, so the
  // indexed type is a union of entry literals and the ones that never set an
  // optional field do not carry it — reading `entry.serviceTier` off that union
  // is an error even though the field is optional on the interface.
  const entry: PolicyEntry = MODEL_POLICY[key];
  return {
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    // Spread-friendly: absent rather than undefined, so `{ ...policy }` does
    // not plant a `serviceTier: undefined` key in a request body.
    ...(entry.serviceTier ? { serviceTier: entry.serviceTier } : {}),
    policy: {
      feature: entry.feature,
      policyKey: key,
      policyVersion: entry.version,
      modelTier: MODEL_TIERS[entry.model] ?? "unknown",
    },
  };
}

/**
 * Policy block for a call that does not run through `openai-client` — the
 * image generator, which posts to /v1/images/generations and is priced per
 * image rather than per token. It still belongs in the same ledger, so it gets
 * a policy without a `MODEL_POLICY` entry to resolve a text model from.
 */
export function externalPolicy(
  feature: Feature,
  policyKey: string,
  model: string,
  version = 1,
): UsagePolicy {
  return {
    feature,
    policyKey,
    policyVersion: version,
    modelTier: MODEL_TIERS[model] ?? "unknown",
  };
}
