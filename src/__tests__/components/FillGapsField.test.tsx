/**
 * Guard tests for the shared fill-the-gaps answer surface (#1035).
 *
 * `FillGapsField` splits its stem on `{{N}}` and nothing else, so a stem that
 * marks its blanks any other way renders zero inputs. That failure used to be
 * invisible: the stem goes through `processLatexContent`, whose markdown pass
 * consumes `___` as bold-italic, so a question with no answerable blanks looked
 * like an ordinary question the student simply could not answer — and since a
 * study guide piece submits only once every question is answered, one such row
 * locked the rest of the guide.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FillGapsField } from "@/components/question-fields";

function renderField(stem: string, gaps: { ordinal: number; acceptable: string[] }[]) {
  return render(
    <FillGapsField
      stem={stem}
      gaps={gaps}
      value={[]}
      onChange={vi.fn()}
      disabled={false}
      reveal={false}
    />,
  );
}

const UNANSWERABLE = /can't be answered/i;

describe("FillGapsField", () => {
  it("renders one input per {{N}} placeholder", () => {
    renderField("The capital of {{1}} is {{2}}.", [
      { ordinal: 1, acceptable: ["France"] },
      { ordinal: 2, acceptable: ["Paris"] },
    ]);

    expect(screen.getByLabelText("Gap 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Gap 2")).toBeInTheDocument();
    expect(screen.queryByText(UNANSWERABLE)).not.toBeInTheDocument();
  });

  it("warns instead of rendering prose when the stem marks its gaps as ___", () => {
    renderField("Η ___ ήταν η επαναφορά του ___.", [
      { ordinal: 1, acceptable: ["Παλινόρθωση"] },
      { ordinal: 2, acceptable: ["Ancien Régime"] },
    ]);

    expect(screen.getByText(UNANSWERABLE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Gap 1")).not.toBeInTheDocument();
  });

  // The pre-#1035 guard only checked `gaps` and `stem` for emptiness, so this
  // is the case it waved through: a populated answer key with a stem that
  // declares no blank at all.
  it("warns when the answer key is populated but the stem declares no blanks", () => {
    renderField("The Restoration returned Europe to its former order.", [
      { ordinal: 1, acceptable: ["Restoration"] },
    ]);

    expect(screen.getByText(UNANSWERABLE)).toBeInTheDocument();
  });

  it("warns when no placeholder in the stem matches a gap in the answer key", () => {
    renderField("The capital of {{2}} is a city.", [{ ordinal: 1, acceptable: ["France"] }]);

    expect(screen.getByText(UNANSWERABLE)).toBeInTheDocument();
  });

  // A stem that places only SOME of its gaps is the same permanent block with
  // part of the question visible: the submit gate sizes its draft from
  // `gaps.length` and requires every entry non-empty, so the gap with no input
  // can never be filled. Rendering the one input it can would look answerable
  // and still never submit.
  it("warns when the stem places only some of the answer key's gaps", () => {
    renderField("The capital of {{1}} is a city.", [
      { ordinal: 1, acceptable: ["France"] },
      { ordinal: 2, acceptable: ["Paris"] },
    ]);

    expect(screen.getByText(UNANSWERABLE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Gap 1")).not.toBeInTheDocument();
  });

  // A stem with more placeholders than gaps is still partly answerable, so it
  // renders: the student can answer the blanks that have a key, and the orphan
  // shows as a visible `___(N)` marker rather than disappearing.
  it("renders the gaps it can and flags an orphaned placeholder", () => {
    renderField("The capital of {{1}} is {{2}}.", [{ ordinal: 1, acceptable: ["France"] }]);

    expect(screen.getByLabelText("Gap 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Gap 2")).not.toBeInTheDocument();
    expect(screen.getByText("___(2)")).toBeInTheDocument();
    expect(screen.queryByText(UNANSWERABLE)).not.toBeInTheDocument();
  });

  it("still warns on an empty stem or an empty answer key", () => {
    const { unmount } = renderField("", [{ ordinal: 1, acceptable: ["France"] }]);
    expect(screen.getByText(UNANSWERABLE)).toBeInTheDocument();
    unmount();

    renderField("The capital of {{1}} is Paris.", []);
    expect(screen.getByText(UNANSWERABLE)).toBeInTheDocument();
  });

  // A grader's verdict beats the local exact matcher (#784 on the quiz surface).
  // The server's fill-gaps grading accepts synonyms and obvious typos, so a
  // field that re-derived its marks would show a gap red under an answer that
  // was recorded correct.
  describe("revealed marks", () => {
    function renderRevealed(value: string[], perGap?: boolean[]) {
      return render(
        <FillGapsField
          stem="The capital of {{1}} is {{2}}."
          gaps={[
            { ordinal: 1, acceptable: ["France"] },
            { ordinal: 2, acceptable: ["Paris"] },
          ]}
          value={value}
          onChange={vi.fn()}
          disabled={false}
          reveal
          perGap={perGap}
        />,
      );
    }

    const wrongMark = (label: string) =>
      screen.getByLabelText(label).className.includes("border-red-500");

    it("marks a gap accepted by the grader as correct, though it is not an exact match", () => {
      renderRevealed(["France", "Pariss"], [true, true]);

      expect(wrongMark("Gap 1")).toBe(false);
      expect(wrongMark("Gap 2")).toBe(false);
      // Nothing was wrong, so there is nothing to correct the student about.
      expect(screen.queryByText(/Expected answers/i)).not.toBeInTheDocument();
    });

    it("still marks a gap the grader rejected, whatever the text looks like", () => {
      renderRevealed(["France", "Berlin"], [true, false]);

      expect(wrongMark("Gap 1")).toBe(false);
      expect(wrongMark("Gap 2")).toBe(true);
      expect(screen.getByText(/Expected answers/i)).toBeInTheDocument();
    });

    it("falls back to exact matching when no verdict is supplied", () => {
      renderRevealed(["France", "Pariss"]);

      expect(wrongMark("Gap 1")).toBe(false);
      expect(wrongMark("Gap 2")).toBe(true);
    });
  });
});
