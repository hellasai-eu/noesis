/**
 * #776 — pickRandomRun unit tests.
 *
 * Uses a deterministic RNG so the shuffle results are predictable.
 */
import { describe, expect, it } from "vitest";
import { pickRandomRun, shuffle } from "@/lib/practice-random-run";
import type {
  StudentPracticeQuestion,
  StudentPracticeStatus,
} from "@/hooks/useStudentPracticeQuestions";
import type { QuestionType } from "@/types/question";

// Linear-congruential pseudo-RNG seeded for stable tests.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function mkQ(
  id: string,
  status: StudentPracticeStatus = "not_started",
  type: QuestionType = "mcq",
): StudentPracticeQuestion {
  return {
    id,
    type,
    stemPreview: `q-${id}`,
    difficulty: "medium",
    status,
    offeringId: "off-1",
    chapters: [],
  };
}

describe("pickRandomRun", () => {
  it("returns an empty run when the source pool is empty", () => {
    expect(pickRandomRun([], 10, seededRng(1))).toEqual([]);
  });

  it("returns up to `max` when there are more preferred than max", () => {
    const pool = Array.from({ length: 25 }, (_, i) => mkQ(`p-${i}`, "not_started"));
    const run = pickRandomRun(pool, 10, seededRng(42));
    expect(run).toHaveLength(10);
    // All chosen items must come from preferred (= entire pool here).
    for (const q of run) expect(q.status).toBe("not_started");
    // Ids must be unique.
    expect(new Set(run.map((q) => q.id)).size).toBe(10);
  });

  it("backfills with completed questions when preferred is short of max", () => {
    const preferred = [
      mkQ("p-1", "not_started"),
      mkQ("p-2", "in_progress"),
      mkQ("p-3", "not_started"),
    ];
    const completed = Array.from({ length: 10 }, (_, i) => mkQ(`c-${i}`, "completed"));
    const run = pickRandomRun([...preferred, ...completed], 10, seededRng(7));

    expect(run).toHaveLength(10);
    // The preferred three are all in the run (since we exhaust them first).
    const ids = new Set(run.map((q) => q.id));
    for (const p of preferred) expect(ids.has(p.id)).toBe(true);
    // The remaining seven are sourced from completed.
    const completedInRun = run.filter((q) => q.status === "completed");
    expect(completedInRun).toHaveLength(7);
  });

  it("yields fewer than max when the entire pool is smaller", () => {
    const pool = [
      mkQ("only-1", "not_started"),
      mkQ("only-2", "completed"),
    ];
    const run = pickRandomRun(pool, 10, seededRng(11));
    expect(run).toHaveLength(2);
  });

  it("returns exactly max when preferred matches max with no backfill", () => {
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => mkQ(`p-${i}`, "not_started")),
      ...Array.from({ length: 5 }, (_, i) => mkQ(`c-${i}`, "completed")),
    ];
    const run = pickRandomRun(pool, 10, seededRng(99));
    expect(run).toHaveLength(10);
    // All ten should be preferred — none completed.
    expect(run.every((q) => q.status !== "completed")).toBe(true);
  });

  it("caps the run at max even when the pool is much bigger", () => {
    const pool = Array.from({ length: 200 }, (_, i) => mkQ(`x-${i}`, "not_started"));
    const run = pickRandomRun(pool, 10, seededRng(3));
    expect(run).toHaveLength(10);
  });

  it("returns an empty run when max <= 0", () => {
    const pool = [mkQ("a", "not_started")];
    expect(pickRandomRun(pool, 0, seededRng(1))).toEqual([]);
    expect(pickRandomRun(pool, -3, seededRng(1))).toEqual([]);
  });

  it("treats in_progress as preferred (not backfill)", () => {
    const pool = [
      mkQ("ip-1", "in_progress"),
      mkQ("ip-2", "in_progress"),
      ...Array.from({ length: 8 }, (_, i) => mkQ(`c-${i}`, "completed")),
    ];
    const run = pickRandomRun(pool, 2, seededRng(5));
    expect(run).toHaveLength(2);
    expect(run.every((q) => q.status === "in_progress")).toBe(true);
  });

  // #821 — the picker is type-agnostic: it never drops questions by type, so a
  // mixed-type pool yields a mixed-type run (the caller passes a pool that
  // ignores the type filter).
  it("spans all question types present in the pool", () => {
    const types: QuestionType[] = [
      "mcq",
      "open",
      "fill_gaps",
      "ordering",
      "classification",
    ];
    const pool = types.flatMap((type) =>
      Array.from({ length: 4 }, (_, i) => mkQ(`${type}-${i}`, "not_started", type)),
    );
    const run = pickRandomRun(pool, 20, seededRng(2026));
    // The whole 20-question pool fits in a 20-item run, so every type appears.
    expect(run).toHaveLength(20);
    expect(new Set(run.map((q) => q.type))).toEqual(new Set(types));
  });

  it("is deterministic given the same seed", () => {
    const pool = Array.from({ length: 50 }, (_, i) => mkQ(`q-${i}`, "not_started"));
    const a = pickRandomRun(pool, 10, seededRng(2026));
    const b = pickRandomRun(pool, 10, seededRng(2026));
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
  });
});

describe("shuffle", () => {
  it("does not mutate the input array", () => {
    const input = [1, 2, 3, 4, 5];
    const snapshot = input.slice();
    shuffle(input, seededRng(1));
    expect(input).toEqual(snapshot);
  });

  it("returns a permutation of the input", () => {
    const input = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffle(input, seededRng(123));
    expect(out.slice().sort((a, b) => a - b)).toEqual(input);
  });
});
