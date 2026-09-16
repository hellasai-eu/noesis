import { describe, it, expect } from "vitest";
import { renderQuestionStem } from "@/lib/question-stem";

describe("renderQuestionStem", () => {
  it("returns the stem unchanged for single-correct items", () => {
    expect(renderQuestionStem("Which is prime?", false)).toBe("Which is prime?");
  });

  it("prepends 'Select all that apply.' when more than one option is correct", () => {
    expect(renderQuestionStem("Which of these are prime?", true)).toBe(
      "Select all that apply. Which of these are prime?",
    );
  });

  it("skips the prefix when the stem already says 'select all that apply'", () => {
    expect(renderQuestionStem("Select all that apply. Pick the primes.", true)).toBe(
      "Select all that apply. Pick the primes.",
    );
  });

  it("phrase-detection is case-insensitive", () => {
    expect(renderQuestionStem("SELECT ALL THAT APPLY. Pick A or B.", true)).toBe(
      "SELECT ALL THAT APPLY. Pick A or B.",
    );
  });

  it("zero correct = treated as single (no prefix)", () => {
    // Defensive: a malformed row with no correct answer shouldn't acquire the
    // multi hint just because it has 0 correct options.
    expect(renderQuestionStem("Stem", false)).toBe("Stem");
  });
});
