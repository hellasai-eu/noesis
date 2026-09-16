import { describe, it, expect, vi } from "vitest";

// StudentEvaluations.tsx pulls in the Supabase client at module-load time, and
// the client throws if VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are
// not set (the case in the test env). We only need the pure builder export, so
// stub the client out before the import.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { buildStudentSpecialInstructions } from "@/components/StudentEvaluations";

describe("buildStudentSpecialInstructions", () => {
  it("returns the assessment line alone when no notes are provided (issue #537 baseline)", () => {
    const result = buildStudentSpecialInstructions({
      overallAssessment: "Strong on geometry, struggling with proofs.",
      weaknesses: ["proofs"],
      noteBodies: [],
    });

    expect(result).toBe(
      "Creating questions for a student with overall assessment: Strong on geometry, struggling with proofs.",
    );
    expect(result).not.toContain("Student notes:");
  });

  it("falls back to weaknesses line when overall assessment is empty and no notes", () => {
    const result = buildStudentSpecialInstructions({
      overallAssessment: "   ",
      weaknesses: ["proofs", "  ", "algebra"],
      noteBodies: undefined,
    });

    expect(result).toBe(
      "Creating questions for a student focusing on these weaknesses: proofs; algebra",
    );
  });

  it("appends Student notes header and bodies in the order received (oldest first)", () => {
    const result = buildStudentSpecialInstructions({
      overallAssessment: "Solid effort overall.",
      weaknesses: null,
      noteBodies: ["Has IEP, extra time accommodation.", "Diagnosed with dyslexia."],
    });

    expect(result).toBe(
      [
        "Creating questions for a student with overall assessment: Solid effort overall.",
        "",
        "Student notes:",
        "",
        "Has IEP, extra time accommodation.",
        "",
        "Diagnosed with dyslexia.",
      ].join("\n"),
    );
  });

  it("strips empty/whitespace-only note bodies before appending", () => {
    const result = buildStudentSpecialInstructions({
      overallAssessment: "Improving.",
      weaknesses: null,
      noteBodies: ["", "   ", "Peanut allergy", null as unknown as string],
    });

    expect(result).toBe(
      [
        "Creating questions for a student with overall assessment: Improving.",
        "",
        "Student notes:",
        "",
        "Peanut allergy",
      ].join("\n"),
    );
  });

  it("omits the Student notes header entirely when all note bodies are blank", () => {
    const result = buildStudentSpecialInstructions({
      overallAssessment: "Improving.",
      weaknesses: null,
      noteBodies: ["", "   "],
    });

    expect(result).toBe(
      "Creating questions for a student with overall assessment: Improving.",
    );
    expect(result).not.toContain("Student notes:");
  });

  it("returns notes-only block when there is no assessment and no weaknesses but notes exist", () => {
    const result = buildStudentSpecialInstructions({
      overallAssessment: null,
      weaknesses: [],
      noteBodies: ["Needs frequent breaks."],
    });

    expect(result).toBe(
      ["Student notes:", "", "Needs frequent breaks."].join("\n"),
    );
  });

  it("returns empty string when nothing is provided", () => {
    expect(
      buildStudentSpecialInstructions({
        overallAssessment: null,
        weaknesses: null,
        noteBodies: null,
      }),
    ).toBe("");
  });
});
