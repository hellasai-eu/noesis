import { describe, it, expect } from "vitest";
import { buildPreview } from "@/lib/unified-question";
import type { UnifiedQuestionRaw } from "@/lib/unified-question";

/**
 * `buildPreview` produces the one-line summary shown for every question in the
 * student practice list and the instructor question bank. It had no tests, and
 * the ordering branch was leaking the answer key (#1041): items are stored in
 * the correct sequence and shuffled at render time, so joining them into the
 * preview printed the solution into a list the student reads before opening the
 * question. Ordering allows a single submission, so a leaked answer became a
 * recorded 100%.
 */

function raw(over: Partial<UnifiedQuestionRaw> = {}): UnifiedQuestionRaw {
  return {
    question: null,
    payload: null,
    answer_key: null,
    explanation: null,
    generation_rationale: null,
    ...over,
  };
}

describe("buildPreview — ordering must not reveal the sequence (#1041)", () => {
  const payload = {
    prompt: "Βάλε τα γεγονότα σε χρονολογική σειρά",
    items: ["Συνέδριο Βιέννης", "Βατερλό", "Ιερή Συμμαχία"],
  };

  it("does not print the stored item order", () => {
    const preview = buildPreview("ordering", raw({ payload }));

    // The stored array IS the answer. Any of these appearing in the list hands
    // it over before the question is opened.
    for (const item of payload.items) {
      expect(preview).not.toContain(item);
    }
    expect(preview).not.toContain("→");
  });

  it("keeps the prompt so the row stays identifiable", () => {
    const preview = buildPreview("ordering", raw({ payload }));

    expect(preview).toContain("Βάλε τα γεγονότα σε χρονολογική σειρά");
    expect(preview).toContain("3 items");
  });

  it("falls back to a bare count when there is no prompt", () => {
    const preview = buildPreview("ordering", raw({ payload: { items: ["a", "b"] } }));

    expect(preview).toBe("2 items");
  });

  it("singularises a one-item list", () => {
    expect(buildPreview("ordering", raw({ payload: { items: ["only"] } }))).toBe("1 item");
  });

  it("survives a payload with no items at all", () => {
    expect(buildPreview("ordering", raw({ payload: { prompt: "P" } }))).toBe("P — 0 items");
  });
});

describe("buildPreview — other types keep their existing summaries", () => {
  it("mcq lists the first three options, labelled", () => {
    const preview = buildPreview(
      "mcq",
      raw({ question: "Ποια πρόταση ισχύει;", payload: { options: ["Alpha", "Beta", "Gamma"] } }),
    );

    expect(preview).toContain("Ποια πρόταση ισχύει;");
    expect(preview).toContain("A. Alpha");
    expect(preview).toContain("C. Gamma");
  });

  it("mcq marks that more options exist beyond the first three", () => {
    const preview = buildPreview(
      "mcq",
      raw({ question: "Q", payload: { options: ["a", "b", "c", "d", "e"] } }),
    );

    expect(preview).toContain("(+2)");
  });

  it("mcq falls back to the bare stem when options are missing", () => {
    expect(buildPreview("mcq", raw({ question: "Just the stem" }))).toBe("Just the stem");
  });

  it("open uses the question text", () => {
    expect(buildPreview("open", raw({ question: "Explain the causes." }))).toBe(
      "Explain the causes.",
    );
  });

  it("fill_gaps strips the blank placeholders from the stem", () => {
    const preview = buildPreview(
      "fill_gaps",
      raw({ payload: { stem: "Το {{1}} είναι πολιτιστική κοινότητα." } }),
    );

    expect(preview).not.toContain("{{1}}");
    expect(preview).toContain("είναι πολιτιστική κοινότητα");
  });

  it("classification lists the category labels", () => {
    const preview = buildPreview(
      "classification",
      raw({
        payload: {
          prompt: "Κατάταξε τα στοιχεία",
          categories: [{ id: "c1", label: "Εθνικό" }, { id: "c2", label: "Φιλελεύθερο" }],
        },
      }),
    );

    expect(preview).toContain("Κατάταξε τα στοιχεία");
    expect(preview).toContain("Εθνικό");
    expect(preview).toContain("Φιλελεύθερο");
  });

  it("returns a string rather than throwing on a null payload of any type", () => {
    for (const type of ["mcq", "open", "fill_gaps", "ordering", "classification"] as const) {
      expect(typeof buildPreview(type, raw())).toBe("string");
    }
  });
});
