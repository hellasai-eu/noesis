import { describe, it, expect } from "vitest";
import { seededShuffle } from "@/lib/seeded-shuffle";

describe("StudentClassificationQuestions seededShuffle (#610)", () => {
  it("is deterministic for the same seed", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const a = seededShuffle(items, "seed-1");
    const b = seededShuffle(items, "seed-1");
    expect(a).toEqual(b);
  });

  it("preserves the input set (no items dropped or duplicated)", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g"];
    const out = seededShuffle(items, "anything");
    expect(out.slice().sort()).toEqual(items.slice().sort());
    expect(out.length).toBe(items.length);
  });

  it("produces different orders for different seeds (on a non-trivial input)", () => {
    // Not strictly guaranteed for any seed pair, but extremely likely for
    // these two distinct strings + this deck size — guards against the
    // seed being ignored.
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const a = seededShuffle(items, "alpha");
    const b = seededShuffle(items, "beta");
    expect(a).not.toEqual(b);
  });

  it("does not mutate the input", () => {
    const items = ["a", "b", "c"];
    const snapshot = [...items];
    seededShuffle(items, "x");
    expect(items).toEqual(snapshot);
  });
});
