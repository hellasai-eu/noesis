// The key material a surface needs to paint the review of an answer it has
// just recorded (#1011).
//
// The answering surfaces used to fetch `questions.answer_key` with the question
// and hold it, unrendered, for as long as the student took to answer. They now
// fetch the question without it and get this back at the moment they earn it —
// so both graders that record a student answer (`submit-quiz-answers` and
// `grade-deterministic-answer`) return the same shape, and the renderers read
// review data from one place regardless of which surface they sit on.
//
// Only the key material for the question's own type is filled in.
//
// `ordering` carries its canonical order in `payload` rather than `answer_key`
// (#1117), which is why it is not withheld from the question fetch in the first
// place. It is returned here anyway, so a caller needs no change when #1117
// moves it.

import {
  classificationAssignmentsFromAnswerKey,
  fillGapsAcceptableAnswersFromAnswerKey,
  mcqCorrectIndicesFromAnswerKey,
  orderingItemsFromPayload,
} from "./question-payload.ts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface QuestionReveal {
  explanation: string | null;
  correctIndices?: number[];
  fillGapsGaps?: { ordinal: number; acceptable: string[] }[];
  classificationAssignments?: Record<string, string>;
  orderingCanonical?: string[];
}

export interface RevealableQuestion {
  type: string;
  payload: Json;
  answer_key: Json;
  explanation?: string | null;
}

export function buildReveal(q: RevealableQuestion): QuestionReveal {
  const reveal: QuestionReveal = { explanation: q.explanation ?? null };
  switch (q.type) {
    case "mcq":
      reveal.correctIndices = mcqCorrectIndicesFromAnswerKey(q.answer_key);
      break;
    case "fill_gaps":
      reveal.fillGapsGaps = fillGapsAcceptableAnswersFromAnswerKey(q.answer_key);
      break;
    case "classification":
      reveal.classificationAssignments = classificationAssignmentsFromAnswerKey(q.answer_key);
      break;
    case "ordering":
      reveal.orderingCanonical = orderingItemsFromPayload(q.payload);
      break;
  }
  return reveal;
}
