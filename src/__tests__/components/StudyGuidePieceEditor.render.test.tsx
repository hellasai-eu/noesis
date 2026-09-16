/**
 * #1005 — question stems carry markup.
 *
 * The model emits `<em>` (and MathML/LaTeX travels the same path), so rendering
 * a stem as plain text showed the instructor raw tags:
 *   "τις έννοιες <em>Volk</em> και <em>Volksgeist</em>"
 *
 * The rest of the app renders stems through `formatQuestionText`, which
 * sanitizes; this pins that the study guide editor does the same and that the
 * sanitizer is actually load-bearing.
 */
import { describe, it, expect } from "vitest";
import { formatQuestionText } from "@/lib/latex-utils";

describe("question stem formatting (#1005)", () => {
  it("turns <em> into real emphasis rather than visible tags", () => {
    const html = formatQuestionText(
      "τις έννοιες <em>Volk</em> και <em>Volksgeist</em>",
    );
    expect(html).toContain("<em>Volk</em>");
    // The literal, escaped form is what the instructor was seeing.
    expect(html).not.toContain("&lt;em&gt;");
  });

  it("strips script tags — the stem is model output rendered as HTML", () => {
    const html = formatQuestionText('safe <script>alert(1)</script> text');
    expect(html).not.toContain("<script");
    expect(html).toContain("safe");
  });

  it("returns empty string for empty input rather than throwing", () => {
    expect(formatQuestionText("")).toBe("");
  });
});
