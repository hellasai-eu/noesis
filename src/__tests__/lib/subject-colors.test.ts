/**
 * The course→hue assignment is a promise to students, not an implementation
 * detail: a course that changes colour between sessions makes the shelves
 * harder to read than no colour at all. These tests pin the two properties
 * that promise rests on — stability and spread — so a "harmless" tweak to the
 * hash cannot silently re-paint every course in production.
 */
import { describe, it, expect } from "vitest";
import {
  SUBJECT_COLOR_COUNT,
  subjectColor,
  subjectColorByIndex,
} from "@/lib/subject-colors";

describe("subjectColor", () => {
  it("returns the same hue for the same course id, every time", () => {
    const id = "0f4c3b0e-6d19-4f52-9c53-6f0a1b2c3d4e";
    const first = subjectColor(id);
    for (let i = 0; i < 20; i += 1) {
      expect(subjectColor(id)).toEqual(first);
    }
  });

  it("pins the hue of known ids, so a hash change cannot pass unnoticed", () => {
    // Recorded, not derived. If these fail, every course in every school has
    // just changed colour — decide that deliberately.
    expect(subjectColor("course-1").index).toBe(5);
    expect(subjectColor("course-2").index).toBe(6);
    expect(subjectColor("0f4c3b0e-6d19-4f52-9c53-6f0a1b2c3d4e").index).toBe(1);
  });

  it("stays inside the palette for any input", () => {
    for (let i = 0; i < 500; i += 1) {
      const { index } = subjectColor(`course-${i}`);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(SUBJECT_COLOR_COUNT);
    }
  });

  it("spreads a realistic timetable across the palette", () => {
    // Six courses is the common case. A hash that piled them onto two hues
    // would technically pass every test above and be useless on screen.
    const used = new Set(
      Array.from({ length: 40 }, (_, i) => subjectColor(`subject-${i}`).index),
    );
    expect(used.size).toBe(SUBJECT_COLOR_COUNT);
  });

  it("resolves to CSS variables rather than literal colours", () => {
    // Literal hex would only be correct in one theme; the tokens carry both.
    const color = subjectColor("course-1");
    expect(color.solid).toBe("var(--subject-5)");
    expect(color.ink).toBe("var(--subject-5-ink)");
    expect(color.tint).toBe("var(--subject-5-tint)");
    expect(color.hero).toBe("var(--subject-5-hero)");
    expect(color.heroInk).toBe("var(--subject-hero-fg)");
  });

  it("falls back to a real slot when there is no course", () => {
    expect(subjectColor(null).index).toBe(SUBJECT_COLOR_COUNT);
    expect(subjectColor(undefined).index).toBe(SUBJECT_COLOR_COUNT);
  });
});

describe("subjectColorByIndex", () => {
  it("wraps out-of-range slots instead of producing an undefined variable", () => {
    expect(subjectColorByIndex(1).index).toBe(1);
    expect(subjectColorByIndex(SUBJECT_COLOR_COUNT).index).toBe(SUBJECT_COLOR_COUNT);
    expect(subjectColorByIndex(SUBJECT_COLOR_COUNT + 1).index).toBe(1);
    expect(subjectColorByIndex(0).index).toBe(SUBJECT_COLOR_COUNT);
  });
});
