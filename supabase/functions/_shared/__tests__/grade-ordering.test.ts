import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { gradeOrdering } from "../grade-ordering.ts";

Deno.test("grade-ordering: full match", () => {
  const result = gradeOrdering(["A", "B", "C"], ["A", "B", "C"]);
  assertEquals(result.perPosition, [true, true, true]);
  assertEquals(result.allCorrect, true);
});

Deno.test("grade-ordering: full reverse (3 items)", () => {
  const result = gradeOrdering(["C", "B", "A"], ["A", "B", "C"]);
  // Only the middle index can coincide.
  assertEquals(result.perPosition, [false, true, false]);
  assertEquals(result.allCorrect, false);
});

Deno.test("grade-ordering: single adjacent swap", () => {
  const result = gradeOrdering(["B", "A", "C"], ["A", "B", "C"]);
  assertEquals(result.perPosition, [false, false, true]);
  assertEquals(result.allCorrect, false);
});

Deno.test("grade-ordering: length mismatch", () => {
  const result = gradeOrdering(["A", "B"], ["A", "B", "C"]);
  assertEquals(result.perPosition, [false, false, false]);
  assertEquals(result.allCorrect, false);
});

Deno.test("grade-ordering: empty canonical", () => {
  const result = gradeOrdering([], []);
  assertEquals(result.perPosition, []);
  assertEquals(result.allCorrect, false);
});
