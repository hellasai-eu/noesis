import { describe, it, expect } from "vitest";
import { gradeFillGaps } from "@/lib/grade-fill-gaps";

describe("gradeFillGaps", () => {
  it("returns allCorrect=true when every gap matches", () => {
    const result = gradeFillGaps(["paris", "berlin"], [["paris"], ["berlin"]]);
    expect(result.perGap).toEqual([true, true]);
    expect(result.allCorrect).toBe(true);
  });

  it("returns allCorrect=false when any gap is wrong", () => {
    const result = gradeFillGaps(["paris", "munich"], [["paris"], ["berlin"]]);
    expect(result.perGap).toEqual([true, false]);
    expect(result.allCorrect).toBe(false);
  });

  it("is case-insensitive", () => {
    const result = gradeFillGaps(["PARIS"], [["paris"]]);
    expect(result.perGap).toEqual([true]);
  });

  it("trims leading/trailing whitespace", () => {
    const result = gradeFillGaps(["  paris  "], [["paris"]]);
    expect(result.perGap).toEqual([true]);
  });

  it("collapses internal whitespace", () => {
    const result = gradeFillGaps(["new   york"], [["new york"]]);
    expect(result.perGap).toEqual([true]);
  });

  it("accepts any of the acceptable answers", () => {
    const result = gradeFillGaps(["paris"], [["london", "paris", "berlin"]]);
    expect(result.perGap).toEqual([true]);
  });

  it("preserves Greek diacritics (κάτω vs κατω → false)", () => {
    const result = gradeFillGaps(["κατω"], [["κάτω"]]);
    expect(result.perGap).toEqual([false]);
  });

  it("matches Greek with NFC equivalence (decomposed vs composed)", () => {
    // Same character expressed as combining marks vs precomposed.
    const decomposed = "κάτω".normalize("NFD"); // κάτω in NFD
    const result = gradeFillGaps([decomposed], [["κάτω"]]);
    expect(result.perGap).toEqual([true]);
  });

  it("is case-insensitive for Greek", () => {
    const result = gradeFillGaps(["ΚΆΤΩ"], [["κάτω"]]);
    expect(result.perGap).toEqual([true]);
  });

  it("returns false for empty submitted strings", () => {
    const result = gradeFillGaps(["", "berlin"], [["paris"], ["berlin"]]);
    expect(result.perGap).toEqual([false, true]);
    expect(result.allCorrect).toBe(false);
  });

  it("returns false for whitespace-only submissions", () => {
    const result = gradeFillGaps(["   "], [["paris"]]);
    expect(result.perGap).toEqual([false]);
  });

  it("treats missing submissions (undefined) as false", () => {
    const result = gradeFillGaps(["paris"], [["paris"], ["berlin"]]);
    expect(result.perGap).toEqual([true, false]);
    expect(result.allCorrect).toBe(false);
  });

  it("returns allCorrect=false when there are no gaps (vacuous truth guarded)", () => {
    const result = gradeFillGaps([], []);
    expect(result.perGap).toEqual([]);
    expect(result.allCorrect).toBe(false);
  });
});
