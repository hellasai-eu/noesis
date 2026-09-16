import { describe, it, expect } from "vitest";
import { gradeOrdering } from "@/lib/grade-ordering";

describe("gradeOrdering", () => {
  const canonical = ["Mg", "Ne", "Na"];

  it("returns allCorrect=true when every position matches", () => {
    const result = gradeOrdering(["Mg", "Ne", "Na"], canonical);
    expect(result.perPosition).toEqual([true, true, true]);
    expect(result.allCorrect).toBe(true);
  });

  it("returns allCorrect=false when the order is fully reversed", () => {
    const result = gradeOrdering(["Na", "Ne", "Mg"], canonical);
    // Index 1 happens to coincide, but 0 and 2 don't.
    expect(result.perPosition).toEqual([false, true, false]);
    expect(result.allCorrect).toBe(false);
  });

  it("marks only the swapped positions wrong when adjacent items are swapped", () => {
    const result = gradeOrdering(["Ne", "Mg", "Na"], canonical);
    expect(result.perPosition).toEqual([false, false, true]);
    expect(result.allCorrect).toBe(false);
  });

  it("returns all-false when lengths differ (renderer-guarantee violated)", () => {
    const result = gradeOrdering(["Mg", "Ne"], canonical);
    expect(result.perPosition).toEqual([false, false, false]);
    expect(result.allCorrect).toBe(false);
  });

  it("returns empty perPosition + allCorrect=false for an empty canonical", () => {
    const result = gradeOrdering([], []);
    expect(result.perPosition).toEqual([]);
    expect(result.allCorrect).toBe(false);
  });

  it("returns all-false for a totally empty submission against a non-empty canonical", () => {
    const result = gradeOrdering([], canonical);
    expect(result.perPosition).toEqual([false, false, false]);
    expect(result.allCorrect).toBe(false);
  });

  it("is reference-equality (not substring) — case difference fails", () => {
    const result = gradeOrdering(["mg", "ne", "na"], canonical);
    expect(result.perPosition).toEqual([false, false, false]);
  });
});
