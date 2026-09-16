// The answer key leaves the server only with an answer already on record, and
// only when the quiz has released its answers (#1011).
//
// Before this, every answering surface fetched `questions.answer_key` with the
// question itself: the key sat in the browser, unrendered, for as long as the
// student took to answer, and "don't show answers" was a rendering choice
// layered on top of data the page already held. The surfaces now fetch the
// question without the key and get the review material back from
// `submit-quiz-answers` — which makes these two functions the rule, rather
// than a restatement of one enforced elsewhere.

import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import { revealAllowedFrom } from "../../submit-quiz-answers/handler.ts";
import { buildReveal } from "../question-reveal.ts";

// deno-lint-ignore no-explicit-any
const row = (over: Record<string, unknown>): any => ({
  id: "q1",
  type: "mcq",
  payload: {},
  answer_key: {},
  explanation: null,
  course_id: "c1",
  updated_at: "2026-08-26T00:00:00Z",
  ...over,
});

Deno.test("reveal gate: practice always reveals", () => {
  // No quiz means no attempt to protect and nothing to release. Practice has
  // always shown the answer on submit; that is what practice is for.
  assert(revealAllowedFrom(null, null, []));
  assert(revealAllowedFrom(null, false, [{ answers_released: false }]));
});

Deno.test("reveal gate: a quiz withholds until answers are released", () => {
  assertFalse(revealAllowedFrom("quiz-1", false, []));
  assertFalse(revealAllowedFrom("quiz-1", null, [{ answers_released: false }]));
  assertFalse(revealAllowedFrom("quiz-1", null, null));
});

Deno.test("reveal gate: either release path opens it", () => {
  // The quiz's own flag...
  assert(revealAllowedFrom("quiz-1", true, []));
  // ...or the per-assignment release, which is how an instructor opens up one
  // section's answers without touching the quiz.
  assert(revealAllowedFrom("quiz-1", false, [{ answers_released: true }]));
});

Deno.test("reveal gate: sibling assignments that disagree withhold from both", () => {
  // The same quiz can be assigned to one offering more than once and each
  // assignment releases separately — but an attempt does not record which
  // assignment it belongs to (`quiz_sessions` carries `offering_id`, never the
  // `offering_quizzes` row), and the caller cannot supply it either, since a
  // student naming the released sibling would look exactly like one naming
  // their own. So a released assignment must not open an unreleased one.
  assertFalse(
    revealAllowedFrom("quiz-1", false, [
      { answers_released: false },
      { answers_released: true },
    ]),
  );
  // Agreement is unambiguous in both directions.
  assert(
    revealAllowedFrom("quiz-1", false, [
      { answers_released: true },
      { answers_released: true },
    ]),
  );
});

Deno.test("reveal gate: a failed read is not a read that said yes", () => {
  // The handler passes null / [] when it could not read the flags. Withholding
  // is the direction to fail in: the student sees no marks, rather than the
  // key escaping because a lookup errored.
  //
  // This is also why the check is `length > 0 && every(...)` rather than a
  // bare `every`: `[].every(...)` is vacuously TRUE, so an empty list would
  // otherwise be the most permissive input there is.
  assertFalse(revealAllowedFrom("quiz-1", null, []));
  assertFalse(revealAllowedFrom("quiz-1", null, null));
  assertFalse(revealAllowedFrom("quiz-1", null, undefined));
});

Deno.test("buildReveal: MCQ carries the correct indices and the explanation", () => {
  const reveal = buildReveal(
    row({
      type: "mcq",
      answer_key: { correct_indices: [0, 2] },
      explanation: "Because.",
    }),
  );
  assertEquals(reveal.correctIndices, [0, 2]);
  assertEquals(reveal.explanation, "Because.");
  // Only the fields for this question's own type.
  assertEquals(reveal.fillGapsGaps, undefined);
  assertEquals(reveal.classificationAssignments, undefined);
  assertEquals(reveal.orderingCanonical, undefined);
});

Deno.test("buildReveal: fill_gaps carries every acceptable answer", () => {
  const reveal = buildReveal(
    row({
      type: "fill_gaps",
      answer_key: {
        gaps: [
          { ordinal: 1, acceptable: ["constitution", "state"] },
          { ordinal: 2, acceptable: ["people"] },
        ],
      },
    }),
  );
  assertEquals(reveal.fillGapsGaps, [
    { ordinal: 1, acceptable: ["constitution", "state"] },
    { ordinal: 2, acceptable: ["people"] },
  ]);
  assertEquals(reveal.correctIndices, undefined);
});

Deno.test("buildReveal: classification carries the assignments", () => {
  const reveal = buildReveal(
    row({ type: "classification", answer_key: { assignments: { i1: "c1" } } }),
  );
  assertEquals(reveal.classificationAssignments, { i1: "c1" });
});

Deno.test("buildReveal: ordering reads its canonical order from the payload", () => {
  // Ordering keeps its answer in `payload.items` (#1117), which is why it is
  // the one type the question fetch cannot withhold. It is returned here
  // anyway, so callers have a single place to read review data from and need
  // no change when #1117 moves it into `answer_key`.
  const reveal = buildReveal(
    row({ type: "ordering", payload: { items: ["a", "b", "c"] }, answer_key: {} }),
  );
  assertEquals(reveal.orderingCanonical, ["a", "b", "c"]);
});

Deno.test("buildReveal: an open answer has no key, only the explanation", () => {
  const reveal = buildReveal(row({ type: "open", explanation: "Model answer." }));
  assertEquals(reveal.explanation, "Model answer.");
  assertEquals(reveal.correctIndices, undefined);
  assertEquals(reveal.fillGapsGaps, undefined);
  assertEquals(reveal.classificationAssignments, undefined);
  assertEquals(reveal.orderingCanonical, undefined);
});

Deno.test("buildReveal: a missing explanation is null, not undefined", () => {
  // The field is always present so a caller can blank a stale explanation on
  // reveal rather than leaving whatever it had.
  assertEquals(buildReveal(row({ explanation: null })).explanation, null);
});
