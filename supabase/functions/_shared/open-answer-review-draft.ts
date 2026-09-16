// Qualitative AI review draft for an open answer awaiting instructor review.
//
// The AI no longer grades anything: open answers are recorded ungraded and
// held for the instructor. This module produces the draft review notes
// (feedback, strengths, areas for improvement — deliberately no number) that
// speed the instructor's review up, and stores them in
// `open_answer_ai_drafts`, which students cannot read.
//
// Shared by `submit-open-answer` (practice written mode) and
// `submit-study-guide-piece` (open questions inside a study-guide piece).
// Callers must treat the draft as best-effort: the submission is already
// recorded by the time a draft is attempted, and a draft failure — including
// the school's grading toggle being off — must never fail the request.
import { callOpenAIStructured } from "./openai-client.ts";
import { modelFor } from "./model-policy.ts";
import { render } from "./render.ts";
import {
  OPEN_ANSWER_REVIEW_DRAFT_SYSTEM_PROMPT,
  OPEN_ANSWER_REVIEW_DRAFT_USER_PROMPT,
} from "./prompts/open-answer-review-draft.ts";
import type { UsageTrackingContext } from "./usage-tracker.ts";

export interface OpenAnswerReviewDraft {
  feedback: string;
  strengths: string[];
  areas_for_improvement: string[];
}

// Deliberately no `grade` property anywhere in this schema: the AI drafts
// words, the instructor decides the number.
export const REVIEW_DRAFT_OUTPUT_SCHEMA = {
  name: "draft_open_answer_review",
  strict: true,
  schema: {
    type: "object",
    properties: {
      feedback: {
        type: "string",
        description: "Draft feedback for the teacher to review (2-3 sentences)",
        minLength: 10,
        maxLength: 500,
      },
      strengths: {
        type: "array",
        description: "List of 2-3 strengths demonstrated by the student",
        items: {
          type: "string",
          description: "Strength demonstrated by the student",
          minLength: 2,
          maxLength: 200,
        },
        minItems: 2,
        maxItems: 3,
      },
      areas_for_improvement: {
        type: "array",
        description: "List of 2-3 areas where the student can improve",
        items: {
          type: "string",
          description: "Area where the student can improve",
          minLength: 2,
          maxLength: 200,
        },
        minItems: 2,
        maxItems: 3,
      },
    },
    required: ["feedback", "strengths", "areas_for_improvement"],
    additionalProperties: false,
  },
} as const;

export interface DraftOpenAnswerReviewInput {
  languageName: string;
  question: string;
  modelAnswer: string;
  rubric: string | null;
  explanation: string | null;
  studentAnswer: string;
  usageContext: UsageTrackingContext;
}

/** One model call, one draft. Throws on any model/policy failure — the
 *  caller decides how quietly to swallow it. */
export async function draftOpenAnswerReview(
  input: DraftOpenAnswerReviewInput,
): Promise<OpenAnswerReviewDraft> {
  const userMessage = render(OPEN_ANSWER_REVIEW_DRAFT_USER_PROMPT, {
    lang: input.languageName,
    question: input.question,
    model_answer: input.modelAnswer,
    rubric: input.rubric ?? "No rubric provided. Use the model answer as the reference.",
    explanation: input.explanation ?? "No additional explanation provided.",
    student_answer: input.studentAnswer,
  });

  return await callOpenAIStructured<OpenAnswerReviewDraft>({
    ...modelFor("grading.open-answer-draft"),
    promptText: OPEN_ANSWER_REVIEW_DRAFT_SYSTEM_PROMPT,
    variables: {},
    input: [{ role: "user", content: userMessage }],
    structuredOutput: REVIEW_DRAFT_OUTPUT_SCHEMA,
    usageContext: input.usageContext,
  });
}
