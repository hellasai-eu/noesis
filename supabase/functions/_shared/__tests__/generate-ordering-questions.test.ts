import { assertEquals, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { validateGenerated } from "../../generate-ordering-questions/handler.ts";
import { toOrderingUnified } from "../question-payload.ts";

const wellFormed = {
  prompt: "Sort the following elements by atomic number, ascending.",
  items: ["Hydrogen", "Helium", "Lithium", "Beryllium"],
  difficulty: "easy",
  explanation: "These are the first four elements in periodic table order.",
  chapter_ids: ["chapter-1"],
  competency_ids: ["comp-1"],
  generation_rationale: "Test on periodic-table chapter.",
};

Deno.test("generate-ordering: well-formed question passes runtime validation", () => {
  assertEquals(validateGenerated(wellFormed), null);
});

Deno.test("generate-ordering: rejects empty prompt", () => {
  const bad = { ...wellFormed, prompt: "" };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects whitespace-only prompt", () => {
  const bad = { ...wellFormed, prompt: "   " };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects fewer than 3 items", () => {
  const bad = { ...wellFormed, items: ["A", "B"] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects more than 8 items", () => {
  const bad = {
    ...wellFormed,
    items: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects duplicate items (case-insensitive, NFC-normalized)", () => {
  const bad = { ...wellFormed, items: ["alpha", "beta", "ALPHA"] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects duplicate items differing only in whitespace", () => {
  const bad = { ...wellFormed, items: ["alpha", " alpha ", "beta"] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects empty item", () => {
  const bad = { ...wellFormed, items: ["A", "", "C"] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: rejects whitespace-only item", () => {
  const bad = { ...wellFormed, items: ["A", "   ", "C"] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-ordering: toOrderingUnified produces the unified shape", () => {
  const unified = toOrderingUnified({
    prompt: wellFormed.prompt,
    items: wellFormed.items,
  });
  assertEquals(unified.type, "ordering");
  assertEquals((unified.payload as { prompt: string }).prompt, wellFormed.prompt);
  assertEquals(
    (unified.payload as { items: string[] }).items,
    wellFormed.items,
  );
  assertEquals(unified.answer_key, {});
});
