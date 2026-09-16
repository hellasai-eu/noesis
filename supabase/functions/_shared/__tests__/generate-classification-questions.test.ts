import { assertEquals, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { validateGenerated } from "../../generate-classification-questions/handler.ts";
import { toClassificationUnified } from "../question-payload.ts";

const wellFormed = {
  prompt: "Classify these properties of sodium as physical or chemical.",
  categories: [
    { id: "physical", label: "Physical" },
    { id: "chemical", label: "Chemical" },
  ],
  items: [
    { id: "i1", text: "Melting point", category_id: "physical" },
    { id: "i2", text: "Reacts with water", category_id: "chemical" },
    { id: "i3", text: "Density", category_id: "physical" },
    { id: "i4", text: "Forms an oxide in air", category_id: "chemical" },
  ],
  difficulty: "easy",
  explanation: "Physical properties are observable without a chemical reaction.",
  chapter_ids: ["chapter-1"],
  competency_ids: ["comp-1"],
  generation_rationale: "Test on the periodic-table chapter.",
};

Deno.test("generate-classification: well-formed question passes runtime validation", () => {
  assertEquals(validateGenerated(wellFormed), null);
});

Deno.test("generate-classification: rejects empty prompt", () => {
  const bad = { ...wellFormed, prompt: "" };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects whitespace-only prompt", () => {
  const bad = { ...wellFormed, prompt: "   " };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects fewer than 2 categories", () => {
  const bad = { ...wellFormed, categories: [{ id: "a", label: "Only" }] };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects more than 5 categories", () => {
  const bad = {
    ...wellFormed,
    categories: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
      { id: "e", label: "E" },
      { id: "f", label: "F" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects duplicate category id", () => {
  const bad = {
    ...wellFormed,
    categories: [
      { id: "physical", label: "Physical" },
      { id: "physical", label: "Other" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects duplicate category label (case-insensitive NFC)", () => {
  const bad = {
    ...wellFormed,
    categories: [
      { id: "physical", label: "Physical" },
      { id: "phys2", label: "  PHYSICAL " },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects fewer than 4 items", () => {
  const bad = {
    ...wellFormed,
    items: [
      { id: "i1", text: "A", category_id: "physical" },
      { id: "i2", text: "B", category_id: "chemical" },
      { id: "i3", text: "C", category_id: "physical" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects more than 12 items", () => {
  const items = Array.from({ length: 13 }, (_, i) => ({
    id: `i${i + 1}`,
    text: `item ${i + 1}`,
    category_id: i % 2 === 0 ? "physical" : "chemical",
  }));
  const bad = { ...wellFormed, items };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects duplicate item ids", () => {
  const bad = {
    ...wellFormed,
    items: [
      { id: "i1", text: "A", category_id: "physical" },
      { id: "i1", text: "B", category_id: "chemical" },
      { id: "i3", text: "C", category_id: "physical" },
      { id: "i4", text: "D", category_id: "chemical" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects duplicate item text (NFC + trim + lowercase)", () => {
  const bad = {
    ...wellFormed,
    items: [
      { id: "i1", text: "Melting point", category_id: "physical" },
      { id: "i2", text: " MELTING POINT ", category_id: "physical" },
      { id: "i3", text: "C", category_id: "physical" },
      { id: "i4", text: "D", category_id: "chemical" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects empty item text", () => {
  const bad = {
    ...wellFormed,
    items: [
      { id: "i1", text: "", category_id: "physical" },
      { id: "i2", text: "B", category_id: "chemical" },
      { id: "i3", text: "C", category_id: "physical" },
      { id: "i4", text: "D", category_id: "chemical" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects unknown category_id (not in declared categories)", () => {
  const bad = {
    ...wellFormed,
    items: [
      { id: "i1", text: "A", category_id: "physical" },
      { id: "i2", text: "B", category_id: "made-up" }, // not in categories[]
      { id: "i3", text: "C", category_id: "physical" },
      { id: "i4", text: "D", category_id: "chemical" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: rejects missing item category_id", () => {
  const bad = {
    ...wellFormed,
    items: [
      { id: "i1", text: "A", category_id: "" },
      { id: "i2", text: "B", category_id: "chemical" },
      { id: "i3", text: "C", category_id: "physical" },
      { id: "i4", text: "D", category_id: "chemical" },
    ],
  };
  assertNotEquals(validateGenerated(bad), null);
});

Deno.test("generate-classification: toClassificationUnified emits the unified shape (no category leak in payload.items)", () => {
  const unified = toClassificationUnified({
    prompt: wellFormed.prompt,
    categories: wellFormed.categories,
    items: wellFormed.items.map((it) => ({ id: it.id, text: it.text })),
    assignments: Object.fromEntries(
      wellFormed.items.map((it) => [it.id, it.category_id]),
    ),
  });
  assertEquals(unified.type, "classification");
  const payload = unified.payload as {
    prompt: string;
    categories: { id: string; label: string }[];
    items: { id: string; text: string }[];
  };
  assertEquals(payload.prompt, wellFormed.prompt);
  assertEquals(payload.categories.length, 2);
  assertEquals(payload.items.length, 4);
  // Items in the payload MUST NOT carry a category_id field — that's the
  // whole point of splitting payload from answer_key.
  for (const it of payload.items) {
    assertEquals(
      Object.keys(it).sort().join(","),
      "id,text",
      "payload.items entries must not leak category_id",
    );
  }
  const answerKey = unified.answer_key as { assignments: Record<string, string> };
  assertEquals(answerKey.assignments.i1, "physical");
  assertEquals(answerKey.assignments.i2, "chemical");
});
