/**
 * #681 — EvaluatorMobileActionBar tests.
 *
 * Sticky thumb-reach action bar. Same shape of test as EvaluatorNavBar:
 * disabled boundaries, callbacks forwarded, saving state swaps the label.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvaluatorMobileActionBar } from "@/components/evaluator/EvaluatorMobileActionBar";

function setup(props: Partial<React.ComponentProps<typeof EvaluatorMobileActionBar>> = {}) {
  const handlers = {
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onSave: vi.fn(),
  };
  render(
    <EvaluatorMobileActionBar
      currentIndex={1}
      total={5}
      saving={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("EvaluatorMobileActionBar", () => {
  it("disables Previous on the first question and Next on the last", () => {
    const { rerender } = render(
      <EvaluatorMobileActionBar
        currentIndex={0}
        total={3}
        saving={false}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mobile-action-prev")).toBeDisabled();
    expect(screen.getByTestId("mobile-action-next")).not.toBeDisabled();

    rerender(
      <EvaluatorMobileActionBar
        currentIndex={2}
        total={3}
        saving={false}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mobile-action-prev")).not.toBeDisabled();
    expect(screen.getByTestId("mobile-action-next")).toBeDisabled();
  });

  it("dispatches every action to its callback", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.click(screen.getByTestId("mobile-action-prev"));
    await user.click(screen.getByTestId("mobile-action-next"));
    await user.click(screen.getByTestId("mobile-action-save"));
    expect(handlers.onPrev).toHaveBeenCalledTimes(1);
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
  });

  it("disables Save and swaps the label while saving", () => {
    setup({ saving: true });
    const save = screen.getByTestId("mobile-action-save");
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("Saving…");
  });

  it("disables Save when there are no questions", () => {
    setup({ total: 0, currentIndex: -1 });
    expect(screen.getByTestId("mobile-action-save")).toBeDisabled();
  });
});
