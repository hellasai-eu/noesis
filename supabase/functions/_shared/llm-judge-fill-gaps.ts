/**
 * LLM second-pass matcher for fill-the-gaps (#784).
 *
 * Used AFTER the exact/normalized matcher in `grade-fill-gaps.ts`. Only the
 * gaps the exact pass rejected (and which the student actually answered)
 * are sent to a small/fast model in one batched call to judge equivalence —
 * synonyms, misspellings, accents, casing, or minor word-order.
 *
 * Empty submissions never reach the LLM. If every gap matched exactly, no
 * call is made at all (the common case).
 *
 * The LLM only ever upgrades a `false` to a `true`. On network failure,
 * timeout, malformed output, or any other error, the original exact-match
 * result is returned unchanged with `llmFailed: true` so the caller can
 * fall back gracefully — submission MUST never be blocked by this layer.
 */
import {
  callOpenAIStructured,
  OpenAIError,
  StructuredOutputSchema,
  UsageTrackingContext,
} from "./openai-client.ts";
import { modelFor } from "./model-policy.ts";
import { logger } from "./logger.ts";

export interface FillGapsJudgeGap {
  ordinal: number;
  acceptable: string[];
}

export interface JudgeFillGapsInput {
  stem: string;
  gaps: FillGapsJudgeGap[];
  submitted: string[];
  exactPerGap: boolean[];
  language?: string;
  usageContext?: UsageTrackingContext;
}

export interface JudgeFillGapsResult {
  perGap: boolean[];
  llmCallMade: boolean;
  llmFailed: boolean;
}

interface JudgeResponse {
  verdicts: Array<{
    ordinal: number;
    equivalent: boolean;
    reason?: string;
  }>;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict but fair grader for fill-the-gap (cloze) answers.

For each candidate, you are given:
- the cloze stem (with {{N}} markers),
- the acceptable answers the instructor wrote for that gap,
- the student's literal submission.

Your job: decide whether the student's submission is EQUIVALENT to any one of the acceptable answers for the same gap.

Count as EQUIVALENT:
- a clear synonym ("car" vs "automobile", "USA" vs "United States"),
- a minor misspelling or typo that obviously points at an acceptable answer,
- different accents or diacritics ("kato" vs "κάτω", "cafe" vs "café") — accept,
- different casing or extra/missing whitespace — accept,
- minor word-order variation in multi-word names ("Britain Great" → "Great Britain") — accept,
- standard inflection (singular/plural, masculine/feminine, verb form) when it preserves meaning.

Do NOT count as equivalent:
- a different concept, even if related (e.g. "Germany" vs "France"),
- a guess that is too vague to identify the acceptable answer,
- empty or whitespace-only submissions.

When unsure, default to equivalent=false.

Return one verdict per submitted candidate, keyed by ordinal.`;

const JUDGE_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: "fill_gaps_equivalence_verdicts",
  strict: true,
  schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        description: "One verdict per submitted candidate, in the same order as the input.",
        items: {
          type: "object",
          properties: {
            ordinal: {
              type: "integer",
              description: "The {{N}} ordinal of the gap being judged.",
            },
            equivalent: {
              type: "boolean",
              description: "True iff the student's submission is equivalent to any acceptable answer.",
            },
            reason: {
              type: "string",
              description: "Optional short justification (kept for debugging).",
            },
          },
          required: ["ordinal", "equivalent", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["verdicts"],
    additionalProperties: false,
  },
};

export async function judgeFillGapsWithLLM(
  input: JudgeFillGapsInput,
): Promise<JudgeFillGapsResult> {
  const { stem, gaps, submitted, exactPerGap, language, usageContext } = input;

  // `gaps` and `exactPerGap` must be in the same positional order (both
  // sorted by ordinal, as `fillGapsAcceptableAnswersFromAnswerKey` guarantees).
  // The sort below is a no-op in normal usage; it does NOT fix a mismatch
  // between an unsorted `gaps` array and a positionally-matched `exactPerGap`.
  const gapsSortedByOrdinal = gaps.slice().sort((a, b) => a.ordinal - b.ordinal);

  // Collect the candidates: gap index in the perGap array → its data.
  const candidates: Array<{
    index: number;
    ordinal: number;
    acceptable: string[];
    student: string;
  }> = [];

  for (let i = 0; i < exactPerGap.length; i++) {
    if (exactPerGap[i]) continue;
    const raw = submitted[i];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const gap = gapsSortedByOrdinal[i];
    if (!gap || !Array.isArray(gap.acceptable) || gap.acceptable.length === 0) continue;
    candidates.push({
      index: i,
      ordinal: gap.ordinal,
      acceptable: gap.acceptable,
      student: trimmed,
    });
  }

  if (candidates.length === 0) {
    return { perGap: exactPerGap.slice(), llmCallMade: false, llmFailed: false };
  }

  const userMessage = [
    ...(language ? [`Language of the material: ${language}.`] : []),
    `Stem: ${stem}`,
    "",
    "Candidates to judge:",
    ...candidates.map((c, idx) =>
      `(${idx + 1}) ordinal=${c.ordinal}\n` +
      `    acceptable: ${JSON.stringify(c.acceptable)}\n` +
      `    student: ${JSON.stringify(c.student)}`
    ),
    "",
    `Return exactly ${candidates.length} verdict object(s), one per candidate above, in order.`,
  ].join("\n");

  let response: JudgeResponse;
  try {
    response = await callOpenAIStructured<JudgeResponse>({
      ...modelFor("grading.fill-gaps-judge"),
      promptText: JUDGE_SYSTEM_PROMPT,
      variables: {},
      input: [{ role: "user", content: userMessage }],
      structuredOutput: JUDGE_OUTPUT_SCHEMA,
      usageContext,
      retryOptions: { maxRetries: 0 },
    });
  } catch (error) {
    const status = error instanceof OpenAIError ? error.statusCode : undefined;
    logger.warn("fill-gaps LLM judge failed; falling back to exact match", {
      error: error instanceof Error ? error.message : String(error),
      status,
      candidates: candidates.length,
    });
    return { perGap: exactPerGap.slice(), llmCallMade: true, llmFailed: true };
  }

  const perGap = exactPerGap.slice();
  const verdictsByOrdinal = new Map<number, boolean>();
  if (Array.isArray(response?.verdicts)) {
    for (const v of response.verdicts) {
      if (
        v &&
        typeof v === "object" &&
        typeof v.ordinal === "number" &&
        typeof v.equivalent === "boolean"
      ) {
        verdictsByOrdinal.set(v.ordinal, v.equivalent);
      }
    }
  }

  for (const c of candidates) {
    const v = verdictsByOrdinal.get(c.ordinal);
    if (v === true) {
      perGap[c.index] = true;
    }
  }

  return { perGap, llmCallMade: true, llmFailed: false };
}
