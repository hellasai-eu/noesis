// Guardrail test (issue #1042, case 2): a fill-gaps gap is graded by exact
// string match against its accepted list, so whatever the generator omits from
// that list is a defensible answer marked permanently wrong. In the reported
// case the theory read "a role within a state and a constitution", the key
// listed only the constitution, and the student who wrote the state lost the
// mark on a one-shot, immutable study-guide answer.
//
// Both generation paths must therefore carry the shared contract that requires
// enumerating EVERY filler the source supports. These assertions exist so the
// rule cannot be dropped from one prompt while surviving in the other.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import { FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT } from "../prompts.ts";
import { FILL_GAPS_SYSTEM_PROMPT } from "../prompts/generate-fill-gaps-questions.ts";
import { STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT } from "../prompts/study-guide-generation.ts";
import { QUESTIONS_OUTPUT_SCHEMA } from "../study-guide-generation.ts";
import { validateGenerated } from "../../generate-fill-gaps-questions/handler.ts";

Deno.test("fill-gaps contract: states the enumeration rule and the coordinated-clause trap", () => {
  // The rule itself — an incomplete list is a wrong grade, so list them all.
  assertStringIncludes(
    FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT,
    "EVERY answer the source text supports",
  );
  // The specific shape that produced #1042: "X and Y" in the source clause.
  assertStringIncludes(FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT, '"X and Y"');
  assertStringIncludes(
    FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT,
    'accepted ["constitution", "state"]',
  );
  // And the counterweight, so the model does not pad the key with answers the
  // source never licensed, which would make the gap test nothing.
  assertStringIncludes(FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT, "Do NOT pad the list");
});

Deno.test("fill-gaps contract: both generation prompts embed it", () => {
  assertStringIncludes(FILL_GAPS_SYSTEM_PROMPT, FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT);
  assertStringIncludes(
    STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT,
    FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT,
  );
});

Deno.test("fill-gaps contract: the standalone prompt no longer asks for one primary answer", () => {
  // The old wording ("ONE primary acceptable answer plus optional close
  // synonyms") pushed the model toward synonyms OF the chosen answer rather
  // than the other fillers the source equally supports — the direct cause.
  assert(
    !FILL_GAPS_SYSTEM_PROMPT.includes("ONE primary acceptable answer"),
    "the single-primary-answer rule contradicts the accepted-answers contract",
  );
});

Deno.test("fill-gaps contract: the study-guide accepted[] schema description carries the rule", () => {
  // deno-lint-ignore no-explicit-any
  const questionItem = (QUESTIONS_OUTPUT_SCHEMA as any).schema.properties.questions.items;
  const accepted = questionItem.properties.fill_gaps_gaps.items.properties.accepted;
  assertStringIncludes(accepted.description, "Every answer the theory supports");
});

// The cap is what turns a complete key into a discarded question, so it has to
// leave room for one. Enumerating two fillers with their inflections in an
// inflected language runs past the old limit of 5 on its own.
Deno.test("fill-gaps validation: a complete 8-entry key is accepted", () => {
  const q = {
    stem: "Ο λαός αποκτά ρόλο στο πλαίσιο ενός {{1}}.",
    gaps: [{
      ordinal: 1,
      acceptable: [
        "Σύνταγμα",
        "Συντάγματος",
        "συνταγμα",
        "κράτος",
        "κράτους",
        "κρατος",
        "πολίτευμα",
        "πολιτεύματος",
      ],
    }],
    difficulty: "medium",
    explanation: "Το κείμενο αναφέρει και τα δύο.",
    chapter_ids: ["chapter-1"],
    competency_ids: [],
    generation_rationale: "Tests the coordinated-clause case from #1042.",
  };
  assertEquals(validateGenerated(q), null);
});

Deno.test("fill-gaps validation: a 9-entry key is still rejected", () => {
  const q = {
    stem: "Ο λαός αποκτά ρόλο στο πλαίσιο ενός {{1}}.",
    gaps: [{ ordinal: 1, acceptable: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }],
    difficulty: "medium",
    explanation: "Πολλές αποδεκτές απαντήσεις.",
    chapter_ids: ["chapter-1"],
    competency_ids: [],
    generation_rationale: "The cap still bites.",
  };
  assertStringIncludes(validateGenerated(q) ?? "", "too many acceptable answers");
});
