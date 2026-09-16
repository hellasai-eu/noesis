import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  extractClassification,
  extractMcqSelection,
  extractOpenText,
  extractStringArray,
  percentGrade,
} from "../study-guide-submission.ts";

Deno.test("extractMcqSelection: reads valid non-negative int indices", () => {
  assertEquals(extractMcqSelection({ selected_indices: [0, 2] }), [0, 2]);
  assertEquals(extractMcqSelection({ selected_indices: [] }), []);
});

Deno.test("extractMcqSelection: rejects malformed shapes", () => {
  assertEquals(extractMcqSelection(null), null);
  assertEquals(extractMcqSelection([0, 1]), null); // array, not object
  assertEquals(extractMcqSelection({ selected_indices: "x" }), null);
  assertEquals(extractMcqSelection({ selected_indices: [0, -1] }), null);
  assertEquals(extractMcqSelection({ selected_indices: [1.5] }), null);
  assertEquals(extractMcqSelection({}), null);
});

Deno.test("extractStringArray: reads the keyed array, coercing non-strings to ''", () => {
  assertEquals(extractStringArray({ fill_gaps: ["a", "b"] }, "fill_gaps"), ["a", "b"]);
  assertEquals(extractStringArray({ ordering: ["x", 3, "y"] }, "ordering"), ["x", "", "y"]);
  assertEquals(extractStringArray({ fill_gaps: "nope" }, "fill_gaps"), null);
  assertEquals(extractStringArray(null, "fill_gaps"), null);
});

Deno.test("extractClassification: reads the placements map, nulling non-strings", () => {
  assertEquals(
    extractClassification({ classification: { i1: "c1", i2: "c2" } }),
    { i1: "c1", i2: "c2" },
  );
  assertEquals(extractClassification({ classification: { i1: 3 } }), { i1: null });
  assertEquals(extractClassification({ classification: [] }), null);
  assertEquals(extractClassification({}), null);
});

Deno.test("extractOpenText: reads the text, or null when absent", () => {
  assertEquals(extractOpenText({ open_text: "hello" }), "hello");
  assertEquals(extractOpenText({ open_text: "" }), "");
  assertEquals(extractOpenText({ open_text: 5 }), null);
  assertEquals(extractOpenText({}), null);
});

Deno.test("percentGrade: rounds correct/total to 0-100, guarding total 0", () => {
  assertEquals(percentGrade(1, 2), 50);
  assertEquals(percentGrade(2, 3), 67);
  assertEquals(percentGrade(0, 4), 0);
  assertEquals(percentGrade(0, 0), 0);
});
