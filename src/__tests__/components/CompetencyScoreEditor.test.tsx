import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockUpsert = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() =>
  vi.fn(() => ({
    upsert: mockUpsert,
  })),
);
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mockFrom,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

beforeAll(() => {
  // Radix Popover / Tooltip rely on pointer-capture methods not in jsdom
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();

  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  } as unknown as typeof ResizeObserver;
});

import {
  CompetencyScoreEditor,
  type CompetencyGridEntry,
} from "@/components/student-evaluations/CompetencyScoreEditor";

const baseEntry: CompetencyGridEntry = {
  competencyId: "comp-1",
  title: "Algebra fundamentals",
  score: 72,
  rationale: "Consistently correct on linear equations.",
  status: "scored",
  isManual: false,
};

const renderEditor = (overrides: Partial<Parameters<typeof CompetencyScoreEditor>[0]> = {}) => {
  const onSaved = vi.fn();
  const props = {
    entry: baseEntry,
    evaluationId: "eval-1",
    canEdit: true,
    hasEvaluation: true,
    onSaved,
    ...overrides,
  };
  const utils = render(
    <TooltipProvider>
      <CompetencyScoreEditor {...props} />
    </TooltipProvider>,
  );
  return { ...utils, onSaved, props };
};

describe("CompetencyScoreEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue({ error: null });
  });

  it("does not render the pencil badge when the score was AI-generated", () => {
    renderEditor();
    expect(
      screen.queryByLabelText(/manually edited/i),
    ).not.toBeInTheDocument();
  });

  it("renders the pencil badge when the score was manually edited", () => {
    renderEditor({ entry: { ...baseEntry, isManual: true } });
    expect(screen.getByLabelText(/manually edited/i)).toBeInTheDocument();
  });

  it("renders a read-only row when canEdit is false", async () => {
    renderEditor({ canEdit: false });
    expect(
      screen.queryByRole("button", { name: /edit score/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the popover with current values when the row is clicked", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(
      screen.getByRole("button", { name: /edit score for algebra fundamentals/i }),
    );

    expect(await screen.findByLabelText(/score \(0–100\)/i)).toHaveValue(72);
    expect(screen.getByLabelText(/rationale/i)).toHaveValue(
      "Consistently correct on linear equations.",
    );
  });

  it("upserts the score with is_manual=true and calls onSaved optimistically", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderEditor();

    await user.click(
      screen.getByRole("button", { name: /edit score for algebra fundamentals/i }),
    );

    const scoreInput = await screen.findByLabelText(/score \(0–100\)/i);
    await user.clear(scoreInput);
    await user.type(scoreInput, "88");

    const rationaleInput = screen.getByLabelText(/rationale/i);
    await user.clear(rationaleInput);
    await user.type(rationaleInput, "Strong on word problems too.");

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    // Optimistic update fires synchronously before the upsert resolves
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        competencyId: "comp-1",
        score: 88,
        rationale: "Strong on word problems too.",
        isManual: true,
        status: "scored",
      }),
    );

    await waitFor(() => {
      expect(mockFrom).toHaveBeenCalledWith("evaluation_competency_scores");
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      {
        evaluation_id: "eval-1",
        competency_id: "comp-1",
        score: 88,
        rationale: "Strong on word problems too.",
        is_manual: true,
      },
      { onConflict: "evaluation_id,competency_id" },
    );

    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
    });
  });

  it("reverts the optimistic update and toasts on error", async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: "boom" } });
    const user = userEvent.setup();
    const { onSaved } = renderEditor();

    await user.click(
      screen.getByRole("button", { name: /edit score for algebra fundamentals/i }),
    );
    const scoreInput = await screen.findByLabelText(/score \(0–100\)/i);
    await user.clear(scoreInput);
    await user.type(scoreInput, "40");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    // Two onSaved calls: optimistic update, then revert back to baseEntry
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(onSaved.mock.calls[1][0]).toEqual(baseEntry);
  });

  it("lets instructors add a score for an N/A (insufficient) competency", async () => {
    const user = userEvent.setup();
    const insufficient: CompetencyGridEntry = {
      competencyId: "comp-2",
      title: "Geometry basics",
      score: null,
      rationale: null,
      status: "insufficient",
      isManual: false,
    };
    const { onSaved } = renderEditor({ entry: insufficient });

    await user.click(
      screen.getByRole("button", { name: /edit score for geometry basics/i }),
    );
    const scoreInput = await screen.findByLabelText(/score \(0–100\)/i);
    expect(scoreInput).toHaveValue(null);

    await user.type(scoreInput, "55");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          competency_id: "comp-2",
          score: 55,
          is_manual: true,
        }),
        { onConflict: "evaluation_id,competency_id" },
      );
    });

    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ status: "scored", isManual: true }),
    );
  });

  it("disables Save when the score is out of range", async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(
      screen.getByRole("button", { name: /edit score for algebra fundamentals/i }),
    );
    const scoreInput = await screen.findByLabelText(/score \(0–100\)/i);
    await user.clear(scoreInput);
    await user.type(scoreInput, "150");

    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
