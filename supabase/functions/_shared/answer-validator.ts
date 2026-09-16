/**
 * Answer validation utility for AI-generated MCQ questions
 * Uses an inline prompt to verify that marked answers are correct
 */

import {
  callOpenAIStructured,
  StructuredOutputSchema,
  UsageTrackingContext,
} from "./openai-client.ts";
import { modelFor } from "./model-policy.ts";
import { logger } from "./logger.ts";
import { ANSWER_VALIDATION_SYSTEM_PROMPT } from "./prompts/answer-validation.ts";
import {
  mcqCorrectIndicesFromAnswerKey,
  mcqOptionsFromPayload,
} from "./question-payload.ts";

// Confidence threshold for accepting an answer as correct
const CONFIDENCE_THRESHOLD = 0.7;

// Validation result schema
const VALIDATION_OUTPUT_SCHEMA: StructuredOutputSchema = {
  name: "answer_verdict_array",
  strict: true,
  schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        description: "List of answer verdicts with confidence and explanatory message.",
        items: {
          type: "object",
          properties: {
            verdict: {
              type: "string",
              enum: ["CORRECT", "PARTIALLY_CORRECT", "INCORRECT", "INSUFFICIENT_INFORMATION"],
              description: "The assessment of the answer's correctness.",
            },
            confidence: {
              type: "number",
              description: "Machine confidence (0 to 1, inclusive) in the verdict.",
            },
            message: {
              type: "string",
              description: "A brief explanation for the verdict.",
            },
          },
          required: ["verdict", "confidence", "message"],
          additionalProperties: false,
        },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
};

export interface ValidationVerdict {
  verdict: "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "INSUFFICIENT_INFORMATION";
  confidence: number;
  message: string;
}

export interface ValidationResult {
  answers: ValidationVerdict[];
}

/**
 * Input shape accepted by `validateGeneratedAnswers`. MCQ data lives in the
 * unified `payload` / `answer_key` jsonb fields (`payload.options`,
 * `answer_key.correct_indices`). Callers that still hold the raw LLM output
 * may pass `options` / `correct_answers` (multi-correct, #592) or
 * `correct_answer` (single-correct, legacy) as a convenience fallback — they
 * are preferred only when the unified fields are absent.
 *
 * Open-type entries (`type === "open"`) are passed through as CORRECT with
 * full confidence — there is no marked index to compare, and the issue
 * (#581) deliberately does not introduce new grading rubric semantics here.
 */
/**
 * What each non-MCQ type reports instead of a fabricated verdict. Worded so an
 * instructor can tell "we checked and it is fine" from "we did not check".
 */
const NOT_VALIDATED_MESSAGE: Record<string, string> = {
  open: "Open question — no marked-index validation",
  fill_gaps: "Fill the gaps — not validated for this type",
  ordering: "Ordering — not validated for this type",
  classification: "Classification — not validated for this type",
};

export interface GeneratedQuestionForValidation {
  question: string;
  options?: string[];
  correct_answer?: number;
  correct_answers?: number[];
  /**
   * The five question types the platform actually stores. This was `"mcq" |
   * "open"` — written before the other three existed — so ordering, fill_gaps
   * and classification had no way to be represented, and fell into the MCQ
   * branch by default (#1060).
   */
  type?: "mcq" | "open" | "fill_gaps" | "ordering" | "classification";
  payload?: Record<string, unknown> | null;
  answer_key?: Record<string, unknown> | null;
  explanation?: string;
  [key: string]: any; // Allow other fields to pass through
}

export interface ValidateAnswersResult<T extends GeneratedQuestionForValidation> {
  valid: T[];
  filtered: T[];
  validationResults: Array<{ question: T; verdict: ValidationVerdict; passed: boolean }>;
}

/**
 * Resolve the MCQ options + correct index set for a question, preferring the
 * unified `payload` / `answer_key` jsonb fields when populated and falling
 * back to the raw LLM-output keys otherwise.
 */
function resolveMcqFields(
  q: GeneratedQuestionForValidation,
): { options: string[]; correctIndices: number[] } {
  const unifiedOptions = mcqOptionsFromPayload(q.payload);
  const unifiedIndices = mcqCorrectIndicesFromAnswerKey(q.answer_key);

  const options = unifiedOptions.length > 0
    ? unifiedOptions
    : Array.isArray(q.options) ? q.options : [];

  let correctIndices: number[] = unifiedIndices;
  if (correctIndices.length === 0) {
    if (Array.isArray(q.correct_answers)) {
      correctIndices = q.correct_answers.filter(
        (v): v is number => typeof v === "number",
      );
    } else if (typeof q.correct_answer === "number") {
      correctIndices = [q.correct_answer];
    }
  }

  return { options, correctIndices };
}

/**
 * Validate generated answers using an inline validator prompt. Dispatches on
 * `type`: MCQ rows go through the LLM verdict path (filtered when the marked
 * index isn't CORRECT with confidence > 0.7); open rows pass through as
 * valid. Accepts the unified `payload` / `answer_key` shape and the legacy
 * MCQ-only shape interchangeably.
 */
export async function validateGeneratedAnswers<T extends GeneratedQuestionForValidation>(
  questions: T[],
  usageContext?: UsageTrackingContext,
): Promise<ValidateAnswersResult<T>> {
  if (questions.length === 0) {
    return { valid: [], filtered: [], validationResults: [] };
  }

  logger.info("Starting answer validation", { questionCount: questions.length });

  // Partition by type. ONLY mcq is LLM-validated: the answer_validation prompt
  // reasons about which marked option index is correct, a concept the other
  // types do not have.
  //
  // Previously anything that was not `open` fell into the MCQ branch (#1060),
  // so an ordering or fill-gaps question was judged by the MCQ rubric and the
  // resulting verdict — confident, scored, persisted to the row — described a
  // question shape it had never seen. A wrong "CORRECT" is worse than no
  // verdict, because an instructor may act on it.
  //
  // Passing them through says plainly that they were not checked, which is
  // true. Judging them properly needs a per-type rubric — see #1055.
  const mcqQuestions: T[] = [];
  const mcqOriginalIndices: number[] = [];
  const openPassthrough: Array<{ question: T; verdict: ValidationVerdict; passed: boolean }> = [];
  const openOriginalIndices: number[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.type === "mcq" || q.type === undefined) {
      // `undefined` keeps the historical default: callers that predate the
      // type field were all sending MCQ.
      mcqQuestions.push(q);
      mcqOriginalIndices.push(i);
    } else {
      openPassthrough.push({
        question: q,
        verdict: {
          verdict: "CORRECT",
          confidence: 1,
          message: NOT_VALIDATED_MESSAGE[q.type] ?? `${q.type} — not validated for this type`,
        },
        passed: true,
      });
      openOriginalIndices.push(i);
    }
  }

  if (mcqQuestions.length === 0) {
    const valid = openPassthrough.map((p) => p.question);
    return { valid, filtered: [], validationResults: openPassthrough };
  }

  // Pre-resolve MCQ fields once so logging / prompt construction / final
  // verdict assembly all share the same view of payload vs. legacy columns.
  const mcqResolved = mcqQuestions.map((q) => ({ q, ...resolveMcqFields(q) }));

  // Build the validation prompt - one question per entry
  // Format: question text, options, and which answers are marked as correct
  const validationInputs = mcqResolved.map(({ q, options, correctIndices }, index) => {
    const optionsText = options.map((opt, i) => `${i}. ${opt}`).join("\n");
    const markedSummary = correctIndices.length > 0
      ? correctIndices
          .map((i) => `${i} (${options[i] ?? `Option ${i}`})`)
          .join(", ")
      : "(none)";

    return `Question ${index + 1}:
${q.question}

Options:
${optionsText}

Marked correct answer(s): ${markedSummary}
${q.explanation ? `\nExplanation provided: ${q.explanation}` : ""}`;
  });

  const fullPrompt = `Please validate the following ${mcqResolved.length} multiple choice questions. For each question, verify if the marked correct answer is actually correct.

${validationInputs.join("\n\n---\n\n")}

Provide a verdict for each question's marked answer in order.`;

  try {
    const validationTimer = logger.startTimer("answer_validation");
    
    const result = await callOpenAIStructured<ValidationResult>({
      ...modelFor("grading.deterministic-validator"),
      promptText: ANSWER_VALIDATION_SYSTEM_PROMPT,
      variables: {},
      input: [{ role: "user", content: fullPrompt }],
      structuredOutput: VALIDATION_OUTPUT_SCHEMA,
      usageContext: usageContext ? {
        ...usageContext,
        promptKey: "answer_validation",
      } : undefined,
    });

    const validationDuration = validationTimer();
    logger.info("Validation API call complete", { durationMs: validationDuration });

    // Process MCQ results (open-type entries already collected in openPassthrough).
    // Pre-allocate by input length so we can slot each result at its original index.
    const resultByIndex = new Array<{ question: T; verdict: ValidationVerdict; passed: boolean }>(questions.length);
    const filtered: T[] = [];

    for (let i = 0; i < mcqResolved.length; i++) {
      const { q: question, options, correctIndices } = mcqResolved[i];
      const origIdx = mcqOriginalIndices[i];
      const verdict = result.answers[i];

      if (!verdict) {
        // No verdict for this question - treat as failed
        logger.warn("No validation verdict for question", {
          questionIndex: i,
          question: question.question.substring(0, 100),
        });
        filtered.push(question);
        resultByIndex[origIdx] = {
          question,
          verdict: { verdict: "INSUFFICIENT_INFORMATION", confidence: 0, message: "No verdict received" },
          passed: false,
        };
        continue;
      }

      const passed = verdict.verdict === "CORRECT" && verdict.confidence > CONFIDENCE_THRESHOLD;

      resultByIndex[origIdx] = { question, verdict, passed };

      if (passed) {
        // Log passed questions briefly
        logger.info("Question passed validation", {
          questionIndex: i,
          question: question.question.substring(0, 100),
          verdict: verdict.verdict,
          confidence: verdict.confidence,
        });
      } else {
        // Log filtered questions with full details
        logger.warn("Question FILTERED - incorrect answer detected", {
          questionIndex: i,
          question: question.question,
          options,
          markedCorrectIndices: correctIndices,
          markedCorrectAnswers: correctIndices.map((idx) => options[idx]),
          validatorVerdict: verdict.verdict,
          validatorConfidence: verdict.confidence,
          validatorMessage: verdict.message,
          reason: verdict.verdict !== "CORRECT"
            ? `Answer marked as ${verdict.verdict}`
            : `Confidence ${verdict.confidence} below threshold ${CONFIDENCE_THRESHOLD}`,
        });
        filtered.push(question);
      }
    }

    // Slot open passthrough entries at their original positions.
    for (let i = 0; i < openPassthrough.length; i++) {
      resultByIndex[openOriginalIndices[i]] = openPassthrough[i];
    }

    // Build ordered outputs — resultByIndex preserves input order for both types.
    const validationResults = [...resultByIndex];
    const valid = validationResults.filter((r) => r.passed).map((r) => r.question);

    logger.info("Answer validation complete", {
      total: questions.length,
      valid: valid.length,
      filtered: filtered.length,
      verdictBreakdown: {
        correct: validationResults.filter(r => r.verdict.verdict === "CORRECT").length,
        partiallyCorrect: validationResults.filter(r => r.verdict.verdict === "PARTIALLY_CORRECT").length,
        incorrect: validationResults.filter(r => r.verdict.verdict === "INCORRECT").length,
        insufficientInfo: validationResults.filter(r => r.verdict.verdict === "INSUFFICIENT_INFORMATION").length,
      },
    });

    return { valid, filtered, validationResults };
  } catch (error) {
    // Log the error but don't block the entire generation
    logger.error("Answer validation failed", {
      error: error instanceof Error ? error.message : String(error),
      questionCount: questions.length,
    });

    // On validation failure, return all questions as valid with a warning
    logger.warn("Returning all questions without validation due to error");
    return {
      valid: questions,
      filtered: [],
      validationResults: questions.map(q => ({
        question: q,
        verdict: { verdict: "CORRECT" as const, confidence: 1, message: "Validation skipped due to error" },
        passed: true,
      })),
    };
  }
}
