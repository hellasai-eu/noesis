import { assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { validateGenerated } from "../../generate-fill-gaps-questions/handler.ts";
import { toFillGapsUnified } from "../question-payload.ts";
import { render, RenderError } from "../render.ts";
import { FILL_GAPS_USER_PROMPT } from "../prompts/generate-fill-gaps-questions.ts";

const wellFormed = {
  stem: "Η πρωτεύουσα της Γαλλίας είναι το {{1}} και η πρωτεύουσα της Γερμανίας είναι το {{2}}.",
  gaps: [
    { ordinal: 1, acceptable: ["Παρίσι"] },
    { ordinal: 2, acceptable: ["Βερολίνο"] },
  ],
  difficulty: "easy",
  explanation: "Δύο γνωστές ευρωπαϊκές πρωτεύουσες.",
  chapter_ids: ["chapter-1"],
  competency_ids: ["comp-1"],
  generation_rationale: "Test on European capitals.",
};

Deno.test("generate-fill-gaps: well-formed question passes runtime validation", () => {
  assertEquals(validateGenerated(wellFormed), null);
});

Deno.test("generate-fill-gaps: rejects stem with no placeholders", () => {
  const bad = { ...wellFormed, stem: "No placeholders here", gaps: [{ ordinal: 1, acceptable: ["x"] }] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: rejects mismatch between stem ordinals and gaps[]", () => {
  // Stem only has {{1}}, gaps has 1 + 2 → mismatch
  const bad = {
    ...wellFormed,
    stem: "X is {{1}}",
    gaps: [
      { ordinal: 1, acceptable: ["a"] },
      { ordinal: 2, acceptable: ["b"] },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: rejects non-contiguous ordinals (skips 2)", () => {
  const bad = {
    ...wellFormed,
    stem: "X is {{1}} and {{3}}",
    gaps: [
      { ordinal: 1, acceptable: ["a"] },
      { ordinal: 3, acceptable: ["b"] },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: rejects gap with no acceptable answers", () => {
  const bad = {
    ...wellFormed,
    stem: "X is {{1}}",
    gaps: [{ ordinal: 1, acceptable: [] }],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: rejects empty-string acceptable answer", () => {
  const bad = {
    ...wellFormed,
    stem: "X is {{1}}",
    gaps: [{ ordinal: 1, acceptable: [""] }],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: rejects duplicate ordinal in gaps[]", () => {
  const bad = {
    ...wellFormed,
    stem: "X {{1}} {{2}}",
    gaps: [
      { ordinal: 1, acceptable: ["a"] },
      { ordinal: 1, acceptable: ["b"] },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: rejects more than 4 gaps (#784)", () => {
  // 1-4 gap cap is part of the new contract — anything larger is dropped.
  const stem = "{{1}} {{2}} {{3}} {{4}} {{5}}";
  const bad = {
    ...wellFormed,
    stem,
    gaps: [
      { ordinal: 1, acceptable: ["a"] },
      { ordinal: 2, acceptable: ["b"] },
      { ordinal: 3, acceptable: ["c"] },
      { ordinal: 4, acceptable: ["d"] },
      { ordinal: 5, acceptable: ["e"] },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-fill-gaps: accepts exactly 4 gaps", () => {
  const stem = "{{1}} {{2}} {{3}} {{4}}";
  const ok = {
    ...wellFormed,
    stem,
    gaps: [
      { ordinal: 1, acceptable: ["a"] },
      { ordinal: 2, acceptable: ["b"] },
      { ordinal: 3, acceptable: ["c"] },
      { ordinal: 4, acceptable: ["d"] },
    ],
  };
  assertEquals(validateGenerated(ok), null);
});

Deno.test("generate-fill-gaps: accepts a single gap (1-gap question)", () => {
  const ok = {
    ...wellFormed,
    stem: "Η πρωτεύουσα της Γαλλίας είναι το {{1}}.",
    gaps: [{ ordinal: 1, acceptable: ["Παρίσι"] }],
  };
  assertEquals(validateGenerated(ok), null);
});

Deno.test("generate-fill-gaps: toFillGapsUnified produces the unified shape", () => {
  const unified = toFillGapsUnified({
    stem: wellFormed.stem,
    gaps: wellFormed.gaps,
  });
  assertEquals(unified.type, "fill_gaps");
  assertEquals(
    (unified.payload as { stem: string }).stem,
    wellFormed.stem,
  );
  const gaps = (unified.answer_key as { gaps: Array<{ ordinal: number }> }).gaps;
  assertEquals(gaps.length, 2);
  assertEquals(gaps[0].ordinal, 1);
  assertEquals(gaps[1].ordinal, 2);
});

// Regression: FILL_GAPS_USER_PROMPT documents the `{{N}}` cloze marker to the
// model, so that placeholder must survive rendering. Strict `render()` treated
// it as an unsupplied variable and threw before the OpenAI call, which would
// have failed every fill-gaps generation at runtime (greptile P1 on PR #957).
Deno.test("FILL_GAPS_USER_PROMPT renders with the caller's variables and keeps {{N}} literal", () => {
  const userVariables = {
    full_competency_list: "c1, c2",
    chapter_list: "1",
    competency_list: "c1",
    diagram_instructions: "",
    group_audience_hint: "",
    special_instructions: "",
    past_questions: "",
    num: "3",
    difficulty: "medium",
    lang: "Greek",
  };

  const out = render(FILL_GAPS_USER_PROMPT, userVariables, {
    name: "FILL_GAPS_USER_PROMPT",
    optional: ["N"],
  });

  assertStringIncludes(out, "{{N}}");
  // Everything else really was substituted.
  assertEquals(out.includes("{{lang}}"), false);
  assertEquals(out.includes("{{num}}"), false);
});

// Without `optional`, the same call throws — proving the guard is what keeps
// the marker alive, not a weakening of the check.
Deno.test("FILL_GAPS_USER_PROMPT: omitting the optional declaration throws on {{N}}", () => {
  assertThrows(
    () =>
      render(FILL_GAPS_USER_PROMPT, {
        full_competency_list: "",
        chapter_list: "",
        competency_list: "",
        diagram_instructions: "",
        group_audience_hint: "",
        special_instructions: "",
        past_questions: "",
        num: "3",
        difficulty: "medium",
        lang: "Greek",
      }),
    RenderError,
  );
});
