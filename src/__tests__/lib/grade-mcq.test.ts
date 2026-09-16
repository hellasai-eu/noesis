import { describe, it, expect } from "vitest";
import { gradeMcq } from "@/lib/grade-mcq";

describe("gradeMcq — exact set match grading", () => {
  it("single-correct match → true", () => {
    expect(gradeMcq([2], [2])).toBe(true);
  });

  it("single-correct mismatch → false", () => {
    expect(gradeMcq([1], [2])).toBe(false);
  });

  it("multi-correct exact match (order independent) → true", () => {
    expect(gradeMcq([0, 2, 3], [3, 0, 2])).toBe(true);
  });

  it("multi-correct missing one selection → false", () => {
    expect(gradeMcq([0, 2], [0, 2, 3])).toBe(false);
  });

  it("multi-correct extra selection → false", () => {
    expect(gradeMcq([0, 2, 3], [0, 2])).toBe(false);
  });

  it("empty submission → false (multi-correct)", () => {
    expect(gradeMcq([], [0, 2])).toBe(false);
  });

  it("empty submission → false (single-correct)", () => {
    expect(gradeMcq([], [0])).toBe(false);
  });

  it("over-picking everything → false", () => {
    expect(gradeMcq([0, 1, 2, 3], [0])).toBe(false);
  });

  it("empty correct set → false (defensive)", () => {
    expect(gradeMcq([0], [])).toBe(false);
  });

  it("duplicate entries on either side are normalized to sets", () => {
    expect(gradeMcq([0, 0, 2], [2, 0])).toBe(true);
    expect(gradeMcq([0, 2], [2, 0, 0])).toBe(true);
  });

  it("non-array inputs → false (defensive)", () => {
    // Real callers shouldn't hit this, but the helper guards against junk so
    // a malformed db row doesn't blow up a grading sweep.
    expect(gradeMcq(undefined as unknown as number[], [0])).toBe(false);
    expect(gradeMcq([0], null as unknown as number[])).toBe(false);
  });
});
