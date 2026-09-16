import { describe, it, expect } from "vitest";
import { gradeClassification } from "@/lib/grade-classification";

describe("gradeClassification", () => {
  const canonical: Record<string, string> = {
    "item-1": "physical",
    "item-2": "chemical",
    "item-3": "physical",
    "item-4": "chemical",
  };

  it("returns allCorrect=true when every item is in the right category", () => {
    const result = gradeClassification(
      {
        "item-1": "physical",
        "item-2": "chemical",
        "item-3": "physical",
        "item-4": "chemical",
      },
      canonical,
    );
    expect(result.perItem).toEqual({
      "item-1": true,
      "item-2": true,
      "item-3": true,
      "item-4": true,
    });
    expect(result.correctCount).toBe(4);
    expect(result.totalCount).toBe(4);
    expect(result.allCorrect).toBe(true);
  });

  it("returns allCorrect=false when every item is in the wrong category", () => {
    const result = gradeClassification(
      {
        "item-1": "chemical",
        "item-2": "physical",
        "item-3": "chemical",
        "item-4": "physical",
      },
      canonical,
    );
    expect(result.correctCount).toBe(0);
    expect(result.allCorrect).toBe(false);
    expect(result.perItem["item-1"]).toBe(false);
  });

  it("grades each item independently on a partial submission", () => {
    const result = gradeClassification(
      {
        "item-1": "physical", // correct
        "item-2": "physical", // wrong
        "item-3": "physical", // correct
        "item-4": "physical", // wrong
      },
      canonical,
    );
    expect(result.perItem).toEqual({
      "item-1": true,
      "item-2": false,
      "item-3": true,
      "item-4": false,
    });
    expect(result.correctCount).toBe(2);
    expect(result.totalCount).toBe(4);
    expect(result.allCorrect).toBe(false);
  });

  it("treats missing assignments as false (unplaced cards)", () => {
    const result = gradeClassification(
      {
        "item-1": "physical",
        "item-2": null,
      },
      canonical,
    );
    expect(result.perItem["item-1"]).toBe(true);
    expect(result.perItem["item-2"]).toBe(false);
    expect(result.perItem["item-3"]).toBe(false);
    expect(result.perItem["item-4"]).toBe(false);
    expect(result.correctCount).toBe(1);
    expect(result.totalCount).toBe(4);
  });

  it("treats an unknown category id as false without throwing", () => {
    const result = gradeClassification(
      { "item-1": "made-up-bucket" },
      { "item-1": "physical" },
    );
    expect(result.perItem["item-1"]).toBe(false);
    expect(result.allCorrect).toBe(false);
  });

  it("derives totalCount from the canonical map, not the submitted one", () => {
    // Submission has an extra entry for an unknown item; it shouldn't
    // inflate the denominator or appear in perItem.
    const result = gradeClassification(
      { "item-1": "physical", "phantom-item": "chemical" },
      { "item-1": "physical" },
    );
    expect(result.totalCount).toBe(1);
    expect(result.perItem).toEqual({ "item-1": true });
    expect(result.allCorrect).toBe(true);
  });

  it("returns allCorrect=false for an empty canonical map (defensive)", () => {
    const result = gradeClassification({}, {});
    expect(result.totalCount).toBe(0);
    expect(result.correctCount).toBe(0);
    expect(result.allCorrect).toBe(false);
  });
});
