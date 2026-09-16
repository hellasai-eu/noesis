/**
 * #680 — EvaluatorNavBar tests.
 *
 * The bar is logic-free; verify it renders the position, disables the right
 * buttons at the boundaries, and forwards every action to its callbacks.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvaluatorNavBar } from "@/components/evaluator/EvaluatorNavBar";

// Popover from Radix relies on pointer-capture in jsdom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
});

function setup(props: Partial<React.ComponentProps<typeof EvaluatorNavBar>> = {}) {
  const handlers = {
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onJumpUnevaluated: vi.fn(),
    onToggleAutoAdvance: vi.fn(),
  };
  render(
    <EvaluatorNavBar
      currentIndex={1}
      total={5}
      hasUnevaluated
      autoAdvance
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("EvaluatorNavBar", () => {
  it("shows the 1-based position label", () => {
    setup({ currentIndex: 2, total: 7 });
    expect(screen.getByTestId("nav-position")).toHaveTextContent("Question 3 of 7");
  });

  it("disables Previous on the first question and Next on the last", () => {
    const { rerender } = render(
      <EvaluatorNavBar
        currentIndex={0}
        total={3}
        hasUnevaluated
        autoAdvance
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onJumpUnevaluated={vi.fn()}
        onToggleAutoAdvance={vi.fn()}
      />,
    );
    expect(screen.getByTestId("nav-prev")).toBeDisabled();
    expect(screen.getByTestId("nav-next")).not.toBeDisabled();

    rerender(
      <EvaluatorNavBar
        currentIndex={2}
        total={3}
        hasUnevaluated
        autoAdvance
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onJumpUnevaluated={vi.fn()}
        onToggleAutoAdvance={vi.fn()}
      />,
    );
    expect(screen.getByTestId("nav-prev")).not.toBeDisabled();
    expect(screen.getByTestId("nav-next")).toBeDisabled();
  });

  it("disables 'next unevaluated' when none remain", () => {
    setup({ hasUnevaluated: false });
    expect(screen.getByTestId("nav-jump-unevaluated")).toBeDisabled();
  });

  it("dispatches every action to its callback", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId("nav-prev"));
    await user.click(screen.getByTestId("nav-next"));
    await user.click(screen.getByTestId("nav-jump-unevaluated"));
    expect(handlers.onPrev).toHaveBeenCalledTimes(1);
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(handlers.onJumpUnevaluated).toHaveBeenCalledTimes(1);
  });

  it("forwards the auto-advance toggle", async () => {
    const user = userEvent.setup();
    const handlers = setup({ autoAdvance: true });
    await user.click(screen.getByTestId("nav-auto-advance"));
    expect(handlers.onToggleAutoAdvance).toHaveBeenCalledWith(false);
  });

  it("opens a keyboard-shortcut legend on click", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByTestId("keyboard-legend")).toBeNull();
    await user.click(screen.getByTestId("keyboard-legend-trigger"));
    expect(await screen.findByTestId("keyboard-legend")).toBeInTheDocument();
    // A handful of shortcut strings should be present.
    expect(screen.getByText("Next question")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
  });
});
