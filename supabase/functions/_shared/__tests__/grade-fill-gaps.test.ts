import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { gradeFillGaps } from "../grade-fill-gaps.ts";

Deno.test("gradeFillGaps: all match", () => {
  const result = gradeFillGaps(["paris", "berlin"], [["paris"], ["berlin"]]);
  assertEquals(result.perGap, [true, true]);
  assertEquals(result.allCorrect, true);
});

Deno.test("gradeFillGaps: case-insensitive", () => {
  const result = gradeFillGaps(["PARIS"], [["paris"]]);
  assertEquals(result.perGap, [true]);
});

Deno.test("gradeFillGaps: trims and collapses whitespace", () => {
  const result = gradeFillGaps(["  new   york  "], [["new york"]]);
  assertEquals(result.perGap, [true]);
});

Deno.test("gradeFillGaps: Greek diacritics matter", () => {
  // κάτω (with diacritic) vs κατω (without) — different words.
  assertEquals(gradeFillGaps(["κατω"], [["κάτω"]]).perGap, [false]);
});

Deno.test("gradeFillGaps: NFC normalizes Greek decomposed forms", () => {
  const decomposed = "κάτω".normalize("NFD");
  assertEquals(gradeFillGaps([decomposed], [["κάτω"]]).perGap, [true]);
});

Deno.test("gradeFillGaps: empty submission → false", () => {
  assertEquals(gradeFillGaps([""], [["paris"]]).perGap, [false]);
  assertEquals(gradeFillGaps(["   "], [["paris"]]).perGap, [false]);
});

Deno.test("gradeFillGaps: undersized submission → remaining gaps false", () => {
  const result = gradeFillGaps(["paris"], [["paris"], ["berlin"]]);
  assertEquals(result.perGap, [true, false]);
  assertEquals(result.allCorrect, false);
});

Deno.test("gradeFillGaps: zero gaps → allCorrect=false (no vacuous truth)", () => {
  assertEquals(gradeFillGaps([], []).allCorrect, false);
});

Deno.test("gradeFillGaps: synonyms list — any match counts", () => {
  const result = gradeFillGaps(["berlin"], [["london", "paris", "berlin"]]);
  assertEquals(result.perGap, [true]);
});
