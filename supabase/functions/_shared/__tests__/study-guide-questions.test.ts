/**
 * Validation tests for the study guide question converter (#978).
 *
 * The model answers with ONE flat object shape for all five question types
 * (OpenAI strict mode requires every property in `required`, so variants are
 * nullable fields rather than a union). This module narrows that back into a
 * real typed question, and rejects anything malformed.
 *
 * Rejection matters more here than in the other generators: a study guide
 * question is answerable by students the moment the guide is assigned, and
 * answers are immutable once submitted (#977), so a broken question cannot be
 * quietly fixed afterwards.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  toStudyGuideQuestionRow,
  type RawStudyGuideQuestion,
} from "../study-guide-questions.ts";

const COMPETENCIES = new Set(["comp-1", "comp-2"]);
const CHAPTERS = ["chap-1", "chap-2"];

/** All-null base; each test fills in only the fields its type needs. */
function raw(overrides: Partial<RawStudyGuideQuestion>): RawStudyGuideQuestion {
  return {
    type: null,
    question: "What is the capital of France?",
    difficulty: "medium",
    explanation: "Because it is.",
    competency_id: null,
    mcq_options: null,
    mcq_correct_indices: null,
    open_model_answer: null,
    fill_gaps_stem: null,
    fill_gaps_gaps: null,
    ordering_prompt: null,
    ordering_items: null,
    classification_prompt: null,
    classification_categories: null,
    classification_items: null,
    ...overrides,
  };
}

function convert(overrides: Partial<RawStudyGuideQuestion>) {
  return toStudyGuideQuestionRow(raw(overrides), COMPETENCIES, CHAPTERS);
}

function expectRejected(overrides: Partial<RawStudyGuideQuestion>, fragment: string) {
  const result = convert(overrides);
  assert(!result.ok, `expected rejection containing "${fragment}", got a valid row`);
  assertStringIncludes(result.error, fragment);
}

// ── mcq ────────────────────────────────────────────────────────────────

Deno.test("mcq: converts a single-correct question", () => {
  const result = convert({
    type: "mcq",
    mcq_options: ["Paris", "Lyon", "Nice"],
    mcq_correct_indices: [0],
  });
  assert(result.ok);
  assertEquals(result.row.type, "mcq");
  assertEquals(result.row.payload.options, ["Paris", "Lyon", "Nice"]);
  assertEquals(result.row.answer_key.correct_indices, [0]);
  // Legacy scalar is dual-written by toMcqUnified.
  assertEquals(result.row.answer_key.correct_index, 0);
});

Deno.test("mcq: converts a multi-correct question and sorts the indices", () => {
  const result = convert({
    type: "mcq",
    mcq_options: ["A", "B", "C", "D"],
    mcq_correct_indices: [2, 0],
  });
  assert(result.ok);
  assertEquals(result.row.answer_key.correct_indices, [0, 2]);
});

Deno.test("mcq: rejects an out-of-range correct index", () => {
  expectRejected(
    { type: "mcq", mcq_options: ["A", "B", "C"], mcq_correct_indices: [7] },
    "out of range",
  );
});

Deno.test("mcq: rejects duplicate correct indices", () => {
  expectRejected(
    { type: "mcq", mcq_options: ["A", "B", "C"], mcq_correct_indices: [1, 1] },
    "duplicates",
  );
});

Deno.test("mcq: rejects when every option is correct", () => {
  expectRejected(
    { type: "mcq", mcq_options: ["A", "B", "C"], mcq_correct_indices: [0, 1, 2] },
    "every mcq option marked correct",
  );
});

Deno.test("mcq: rejects too few and too many options", () => {
  expectRejected({ type: "mcq", mcq_options: ["A", "B"], mcq_correct_indices: [0] }, "options");
  expectRejected(
    {
      type: "mcq",
      mcq_options: ["A", "B", "C", "D", "E", "F"],
      mcq_correct_indices: [0],
    },
    "options",
  );
});

Deno.test("mcq: rejects a blank option", () => {
  expectRejected(
    { type: "mcq", mcq_options: ["A", "   ", "C"], mcq_correct_indices: [0] },
    "blanks",
  );
});

Deno.test("mcq: rejects missing correct indices", () => {
  expectRejected(
    { type: "mcq", mcq_options: ["A", "B", "C"], mcq_correct_indices: [] },
    "missing or empty",
  );
});

// ── open ───────────────────────────────────────────────────────────────

Deno.test("open: converts and always pins answering_mode to single", () => {
  const result = convert({ type: "open", open_model_answer: "Paris is the capital." });
  assert(result.ok);
  assertEquals(result.row.type, "open");
  // Study guides never use the Socratic interactive surface (#977).
  assertEquals(result.row.payload.answering_mode, "single");
  assertEquals(result.row.answer_key.model_answer, "Paris is the capital.");
});

Deno.test("open: rejects an empty model answer", () => {
  expectRejected({ type: "open", open_model_answer: "   " }, "open_model_answer is empty");
});

// ── fill_gaps ──────────────────────────────────────────────────────────

Deno.test("fill_gaps: converts and assigns 1-based ordinals in order", () => {
  const result = convert({
    type: "fill_gaps",
    fill_gaps_stem: "The capital of {{1}} is {{2}}.",
    fill_gaps_gaps: [{ accepted: ["France"] }, { accepted: ["Paris", "paris"] }],
  });
  assert(result.ok);
  assertEquals(result.row.payload.stem, "The capital of {{1}} is {{2}}.");
  assertEquals(result.row.answer_key.gaps, [
    { ordinal: 1, acceptable: ["France"] },
    { ordinal: 2, acceptable: ["Paris", "paris"] },
  ]);
});

Deno.test("fill_gaps: rejects a gap with no accepted answers", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "The capital of {{1}} is {{2}}.",
      fill_gaps_gaps: [{ accepted: ["France"] }, { accepted: [] }],
    },
    "gap 2 has no accepted answers",
  );
});

// #1042: this path had no cap on accepted answers at all. A key longer than
// the frontend schema allows reaches the questions table fine and then fails
// the editor the first time an instructor saves — on gaps they never touched.
Deno.test("fill_gaps: accepts a full eight-answer key", () => {
  const accepted = [
    "constitution",
    "constitutions",
    "the constitution",
    "state",
    "states",
    "the state",
    "polity",
    "polities",
  ];
  const result = convert({
    type: "fill_gaps",
    fill_gaps_stem: "A citizen has a role within a {{1}}.",
    fill_gaps_gaps: [{ accepted }],
  });
  assert(result.ok);
  assertEquals(result.row.answer_key.gaps, [{ ordinal: 1, acceptable: accepted }]);
});

Deno.test("fill_gaps: rejects a ninth accepted answer", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "A citizen has a role within a {{1}}.",
      fill_gaps_gaps: [{
        accepted: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      }],
    },
    "gap 1 has 9 accepted answers (max 8)",
  );
});

Deno.test("fill_gaps: rejects more gaps than the cap allows", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: Array.from({ length: 9 }, (_, i) => `{{${i + 1}}}`).join(" "),
      fill_gaps_gaps: Array.from({ length: 9 }, () => ({ accepted: ["x"] })),
    },
    "at most 8 gaps",
  );
});

// The bug in #1035: the schema told the model to write each gap as `___`, so a
// stem with no `{{N}}` placeholders was stored and rendered as prose with no
// inputs — unanswerable, which locks every later piece of the guide behind it.
Deno.test("fill_gaps: rejects a stem that marks its gaps as ___ instead of {{N}}", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "Η ___ ήταν η επαναφορά του ___.",
      fill_gaps_gaps: [{ accepted: ["Παλινόρθωση"] }, { accepted: ["Ancien Régime"] }],
    },
    "marks no gaps",
  );
});

Deno.test("fill_gaps: rejects a stem with fewer placeholders than gaps", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "The capital of {{1}} is a city.",
      fill_gaps_gaps: [{ accepted: ["France"] }, { accepted: ["Paris"] }],
    },
    "1 placeholder(s) but 2 gap(s)",
  );
});

Deno.test("fill_gaps: rejects a stem with more placeholders than gaps", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "The capital of {{1}} is {{2}}, on the {{3}}.",
      fill_gaps_gaps: [{ accepted: ["France"] }, { accepted: ["Paris"] }],
    },
    "3 placeholder(s) but 2 gap(s)",
  );
});

Deno.test("fill_gaps: rejects a repeated placeholder", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "{{1}} is the capital of {{1}}.",
      fill_gaps_gaps: [{ accepted: ["Paris"] }, { accepted: ["France"] }],
    },
    "repeats a {{N}} placeholder",
  );
});

// Gaps are numbered by POSITION, so a stem numbered from 2 leaves gap 1 with no
// input and would pair every answer with the wrong blank.
Deno.test("fill_gaps: rejects placeholders that are not contiguous from 1", () => {
  expectRejected(
    {
      type: "fill_gaps",
      fill_gaps_stem: "The capital of {{2}} is {{3}}.",
      fill_gaps_gaps: [{ accepted: ["France"] }, { accepted: ["Paris"] }],
    },
    "missing placeholder {{1}}",
  );
});

// ── ordering ───────────────────────────────────────────────────────────

Deno.test("ordering: converts, keeping the canonical order as the payload", () => {
  const result = convert({
    type: "ordering",
    ordering_prompt: "Order these events.",
    ordering_items: ["First", "Second", "Third"],
  });
  assert(result.ok);
  assertEquals(result.row.payload.items, ["First", "Second", "Third"]);
  // The canonical order IS the answer; answer_key is intentionally empty.
  assertEquals(result.row.answer_key, {});
});

Deno.test("ordering: rejects fewer than the minimum items", () => {
  expectRejected(
    { type: "ordering", ordering_prompt: "Order.", ordering_items: ["A", "B"] },
    "3-8 items",
  );
});

Deno.test("ordering: rejects duplicate items", () => {
  expectRejected(
    { type: "ordering", ordering_prompt: "Order.", ordering_items: ["A", "B", "A"] },
    "duplicates",
  );
});

// ── classification ─────────────────────────────────────────────────────

Deno.test("classification: converts, mapping item labels onto generated ids", () => {
  const result = convert({
    type: "classification",
    classification_prompt: "Sort these.",
    classification_categories: ["Mammal", "Bird"],
    classification_items: [
      { text: "Dog", category: "Mammal" },
      { text: "Cat", category: "Mammal" },
      { text: "Eagle", category: "Bird" },
      { text: "Owl", category: "Bird" },
    ],
  });
  assert(result.ok);
  assertEquals(result.row.payload.categories, [
    { id: "c1", label: "Mammal" },
    { id: "c2", label: "Bird" },
  ]);
  // Student-facing items carry no category — the answer lives in answer_key.
  assertEquals(result.row.payload.items, [
    { id: "i1", text: "Dog" },
    { id: "i2", text: "Cat" },
    { id: "i3", text: "Eagle" },
    { id: "i4", text: "Owl" },
  ]);
  assertEquals(result.row.answer_key.assignments, {
    i1: "c1",
    i2: "c1",
    i3: "c2",
    i4: "c2",
  });
});

Deno.test("classification: rejects an item naming an unknown category", () => {
  expectRejected(
    {
      type: "classification",
      classification_prompt: "Sort these.",
      classification_categories: ["Mammal", "Bird"],
      classification_items: [
        { text: "Dog", category: "Mammal" },
        { text: "Cat", category: "Mammal" },
        { text: "Eagle", category: "Bird" },
        { text: "Trout", category: "Fish" },
      ],
    },
    'unknown category "Fish"',
  );
});

Deno.test("classification: rejects a category with no items", () => {
  expectRejected(
    {
      type: "classification",
      classification_prompt: "Sort these.",
      classification_categories: ["Mammal", "Bird", "Fish"],
      classification_items: [
        { text: "Dog", category: "Mammal" },
        { text: "Cat", category: "Mammal" },
        { text: "Eagle", category: "Bird" },
        { text: "Owl", category: "Bird" },
      ],
    },
    "no items",
  );
});

Deno.test("classification: rejects too few categories", () => {
  expectRejected(
    {
      type: "classification",
      classification_prompt: "Sort these.",
      classification_categories: ["Mammal"],
      classification_items: [
        { text: "Dog", category: "Mammal" },
        { text: "Cat", category: "Mammal" },
        { text: "Fox", category: "Mammal" },
        { text: "Bat", category: "Mammal" },
      ],
    },
    "2-5 categories",
  );
});

// ── cross-cutting ──────────────────────────────────────────────────────

Deno.test("rejects an unsupported type", () => {
  expectRejected({ type: "essay", open_model_answer: "x" }, "unsupported question type");
});

Deno.test("rejects an empty question stem", () => {
  expectRejected(
    { type: "open", question: "  ", open_model_answer: "answer" },
    "question text is empty",
  );
});

Deno.test("keeps a competency id that belongs to the course", () => {
  const result = convert({
    type: "open",
    open_model_answer: "answer",
    competency_id: "comp-2",
  });
  assert(result.ok);
  assertEquals(result.row.competency_id, "comp-2");
  assertEquals(result.row.competency_ids, ["comp-2"]);
});

Deno.test("drops a hallucinated competency id rather than trusting it", () => {
  // A wrong mapping is worse than none: the id would either break the FK or
  // silently attach the question to another course's competency.
  const result = convert({
    type: "open",
    open_model_answer: "answer",
    competency_id: "comp-from-another-course",
  });
  assert(result.ok);
  assertEquals(result.row.competency_id, null);
  assertEquals(result.row.competency_ids, []);
});

Deno.test("falls back to medium for an unrecognised difficulty", () => {
  const result = convert({
    type: "open",
    open_model_answer: "answer",
    difficulty: "impossible",
  });
  assert(result.ok);
  assertEquals(result.row.difficulty, "medium");
});

Deno.test("links every source chapter and never starts hidden", () => {
  const result = convert({ type: "open", open_model_answer: "answer" });
  assert(result.ok);
  assertEquals(result.row.chapter_ids, CHAPTERS);
  assertEquals(result.row.hidden, false);
  assertEquals(result.row.is_user_generated, false);
});

// ── break-tag stripping ────────────────────────────────────────────────

Deno.test("strips <br/> tags the model leaves in text fields, including inside math", () => {
  // Observed in the wild: the model writes questions next to HTML theory and
  // emits "$<br/> u(3) = -2$", which KaTeX typesets as a literal "< br/ >".
  const result = convert({
    type: "mcq",
    question: "Για τη συνάρτηση $S(t) = -t^2 + 4t$ ισχύει $<br/> u(3) = -2$.",
    mcq_options: ["σωστό<br>λάθος", "Lyon", "Nice"],
    mcq_correct_indices: [0],
  });
  assert(result.ok);
  assertEquals(
    result.row.question,
    "Για τη συνάρτηση $S(t) = -t^2 + 4t$ ισχύει $ u(3) = -2$.",
  );
  assertEquals(result.row.payload.options, ["σωστό λάθος", "Lyon", "Nice"]);
});

Deno.test("leaves tag-free text byte-identical — no whitespace collapsing", () => {
  const question = "Line one\n\nLine  two with  spacing $a\tb$.";
  const result = convert({
    type: "open",
    question,
    open_model_answer: "answer",
  });
  assert(result.ok);
  assertEquals(result.row.question, question);
});

Deno.test("strips break tags from nested fill_gaps fields", () => {
  const result = convert({
    type: "fill_gaps",
    fill_gaps_stem: "The capital<br /> of {{1}} is Paris.",
    fill_gaps_gaps: [{ accepted: ["France</br>"] }],
  });
  assert(result.ok);
  assertEquals(result.row.payload.stem, "The capital of {{1}} is Paris.");
  assertEquals(result.row.answer_key.gaps, [{ ordinal: 1, acceptable: ["France"] }]);
});
