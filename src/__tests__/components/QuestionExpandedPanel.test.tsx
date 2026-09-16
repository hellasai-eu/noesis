import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Component tests for the five instructor-facing expanded panels and the
 * dispatcher that picks between them (#1054).
 *
 * These are the *review* surfaces: unlike the student answering panels they are
 * allowed — required, in fact — to show the answer key. That asymmetry is the
 * thing worth pinning. The student-side counterparts assert the opposite (see
 * StudentOrderingQuestions.test.tsx and StudentFillGapsQuestions.test.tsx),
 * and #1041 was precisely a case of a student surface behaving like this one.
 */

vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (s: string) => s,
  processLatexContent: (s: string) => s,
}));

import { QuestionExpandedPanel } from "@/components/question-bank/expanded";
import type { UnifiedQuestion } from "@/lib/unified-question";
import type { Json } from "@/integrations/supabase/types";

/** A UnifiedQuestion with every non-type-specific field at a harmless default. */
function makeQuestion(over: {
  type: UnifiedQuestion["type"];
  question?: string | null;
  payload?: Json | null;
  answer_key?: Json | null;
  explanation?: string | null;
}): UnifiedQuestion {
  return {
    id: "q-1",
    type: over.type,
    preview: "preview",
    searchText: "search",
    difficulty: "easy",
    authorName: null,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    hidden: false,
    upvotes: 0,
    downvotes: 0,
    chapters: [],
    competencies: [],
    raw: {
      question: over.question ?? null,
      payload: over.payload ?? null,
      answer_key: over.answer_key ?? null,
      explanation: over.explanation ?? null,
      generation_rationale: null,
    },
  };
}

const noop = () => {};

describe("OrderingExpandedPanel (#1054)", () => {
  const ordering = makeQuestion({
    type: "ordering",
    payload: {
      prompt: "Put the reigns in order",
      items: ["Otto", "George I", "Constantine I"],
    } as unknown as Json,
  });

  it("lists every item in canonical order, numbered from 1", () => {
    render(<QuestionExpandedPanel question={ordering} onClose={noop} isAdmin={false} />);

    const items = screen.getAllByTestId("ordering-item");
    expect(items).toHaveLength(3);
    // Canonical order, not shuffled — this is the review surface.
    expect(items.map((li) => li.textContent)).toEqual([
      "1Otto",
      "2George I",
      "3Constantine I",
    ]);
  });

  it("states the item count alongside the heading", () => {
    render(<QuestionExpandedPanel question={ordering} onClose={noop} isAdmin={false} />);
    expect(screen.getByText("Correct order (3 items)")).toBeInTheDocument();
  });

  it("renders no items for a payload carrying none, rather than throwing", () => {
    const empty = makeQuestion({
      type: "ordering",
      payload: { prompt: "Nothing here", items: [] } as unknown as Json,
    });
    render(<QuestionExpandedPanel question={empty} onClose={noop} isAdmin={false} />);
    expect(screen.queryAllByTestId("ordering-item")).toHaveLength(0);
    expect(screen.getByText("Correct order (0 items)")).toBeInTheDocument();
  });
});

describe("FillGapsExpandedPanel (#1054)", () => {
  const fillGaps = makeQuestion({
    type: "fill_gaps",
    payload: { stem: "The {{1}} was signed in {{2}}." } as unknown as Json,
    answer_key: {
      gaps: [
        { ordinal: 1, acceptable: ["Σύνταγμα", "syntagma"] },
        { ordinal: 2, acceptable: ["1975"] },
      ],
    } as unknown as Json,
  });

  it("renders one row per gap, ordinal-labelled", () => {
    render(<QuestionExpandedPanel question={fillGaps} onClose={noop} isAdmin={false} />);

    const gaps = screen.getAllByTestId("fill-gap-item");
    expect(gaps).toHaveLength(2);
    expect(screen.getByText("Gaps (2)")).toBeInTheDocument();
  });

  it("shows every acceptable answer for a gap, not just the first", () => {
    render(<QuestionExpandedPanel question={fillGaps} onClose={noop} isAdmin={false} />);

    const [firstGap] = screen.getAllByTestId("fill-gap-item");
    // Both the canonical answer and its listed alternative are visible — the
    // instructor needs to see what the grader will accept (grade-fill-gaps.ts
    // matches against the whole list; that matching is unit-tested separately
    // in src/__tests__/lib/grade-fill-gaps.test.ts).
    expect(within(firstGap).getByText("Σύνταγμα")).toBeInTheDocument();
    expect(within(firstGap).getByText("syntagma")).toBeInTheDocument();
  });
});

describe("McqExpandedPanel (#1054)", () => {
  it("renders every option and marks the correct one", () => {
    const mcq = makeQuestion({
      type: "mcq",
      question: "Πόσο κάνει 2 + 2;",
      payload: { options: ["3", "4", "5"] } as unknown as Json,
      answer_key: { correct_index: 1 } as unknown as Json,
    });
    render(<QuestionExpandedPanel question={mcq} onClose={noop} isAdmin={false} />);

    const options = screen.getAllByTestId("mcq-option");
    expect(options).toHaveLength(3);
    expect(screen.getByText("Πόσο κάνει 2 + 2;")).toBeInTheDocument();
    // The panel distinguishes the key from the distractors somehow; assert the
    // distinction exists rather than pinning the exact styling.
    const correct = options[1];
    expect(correct.className).not.toEqual(options[0].className);
  });
});

describe("OpenExpandedPanel (#1054)", () => {
  it("renders the model answer", () => {
    const open = makeQuestion({
      type: "open",
      question: "Explain commutativity.",
      answer_key: { model_answer: "Order does not change the sum." } as unknown as Json,
    });
    render(<QuestionExpandedPanel question={open} onClose={noop} isAdmin={false} />);

    expect(screen.getByTestId("open-model-answer")).toHaveTextContent(
      "Order does not change the sum.",
    );
  });
});

describe("ClassificationExpandedPanel (#1054)", () => {
  it("groups each item under the category the answer key assigns it to", () => {
    const classification = makeQuestion({
      type: "classification",
      payload: {
        prompt: "Sort the shapes",
        // `label`, not `name` — classificationCategoriesFromPayload drops any
        // category without a non-empty string `label`.
        categories: [
          { id: "c1", label: "Round" },
          { id: "c2", label: "Angular" },
        ],
        items: [
          { id: "i1", text: "Circle" },
          { id: "i2", text: "Square" },
          { id: "i3", text: "Ellipse" },
        ],
      } as unknown as Json,
      answer_key: {
        assignments: { i1: "c1", i2: "c2", i3: "c1" },
      } as unknown as Json,
    });
    render(<QuestionExpandedPanel question={classification} onClose={noop} isAdmin={false} />);

    const categories = screen.getAllByTestId("classification-category");
    expect(categories).toHaveLength(2);

    const round = categories.find((c) => c.textContent?.includes("Round"))!;
    const angular = categories.find((c) => c.textContent?.includes("Angular"))!;

    expect(within(round).getAllByTestId("classification-item").map((i) => i.textContent)).toEqual([
      "Circle",
      "Ellipse",
    ]);
    expect(
      within(angular).getAllByTestId("classification-item").map((i) => i.textContent),
    ).toEqual(["Square"]);
  });
});

describe("QuestionExpandedPanel dispatch (#1054)", () => {
  it("routes each question type to the panel that understands its payload", () => {
    // One assertion per branch of the switch in expanded/index.tsx: a
    // mis-routed type would render the wrong panel, which reads the wrong
    // payload shape and silently renders nothing.
    const cases: Array<[UnifiedQuestion, string]> = [
      [
        makeQuestion({
          type: "ordering",
          payload: { prompt: "p", items: ["a"] } as unknown as Json,
        }),
        "ordering-item",
      ],
      [
        makeQuestion({
          type: "fill_gaps",
          payload: { stem: "s {{1}}" } as unknown as Json,
          answer_key: { gaps: [{ ordinal: 1, acceptable: ["x"] }] } as unknown as Json,
        }),
        "fill-gap-item",
      ],
      [
        makeQuestion({
          type: "mcq",
          question: "q",
          payload: { options: ["a", "b"] } as unknown as Json,
          answer_key: { correct_index: 0 } as unknown as Json,
        }),
        "mcq-option",
      ],
      [
        makeQuestion({
          type: "open",
          question: "q",
          answer_key: { model_answer: "m" } as unknown as Json,
        }),
        "open-model-answer",
      ],
      [
        makeQuestion({
          type: "classification",
          payload: {
            prompt: "p",
            categories: [{ id: "c1", label: "C" }],
            items: [{ id: "i1", text: "I" }],
          } as unknown as Json,
          answer_key: { assignments: { i1: "c1" } } as unknown as Json,
        }),
        "classification-category",
      ],
    ];

    for (const [question, testid] of cases) {
      const { unmount } = render(
        <QuestionExpandedPanel question={question} onClose={noop} isAdmin={false} />,
      );
      expect(screen.getAllByTestId(testid).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("invokes onClose from the shared shell", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <QuestionExpandedPanel
        question={makeQuestion({
          type: "open",
          question: "q",
          answer_key: { model_answer: "m" } as unknown as Json,
        })}
        onClose={onClose}
        isAdmin={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /collapse/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
