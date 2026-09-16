/**
 * The tile's states carry meaning, not decoration.
 *
 * The one that matters most is `locked`: the course page rendered an overdue
 * or closed assignment inert, and a student who can click into a quiz they can
 * no longer submit has been sent to a dead end. `ActivityRow` enforced that
 * with `disabled`; when it retires, this is where the rule lives.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { SurfaceTile } from "@/components/student/surface/SurfaceTile";

describe("SurfaceTile", () => {
  it("fires its action from the button and from the tile body", async () => {
    const onAction = vi.fn();
    render(
      <SurfaceTile
        courseId="course-1"
        kicker="Mathematics"
        title="Quadratic equations"
        actionLabel="Start"
        onAction={onAction}
        testId="tile"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onAction).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId("tile"));
    // Once for the button, once for the body — and never twice for one click,
    // which is what the button's stopPropagation is there to prevent.
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("keeps the two actions apart: the secondary fires alone, the body stays primary", async () => {
    const onAction = vi.fn();
    const onSecondaryAction = vi.fn();
    render(
      <SurfaceTile
        courseId="course-1"
        kicker="History"
        title="Interwar period"
        actionLabel="Analysis & Follow-up"
        onAction={onAction}
        secondaryActionLabel="Create More Questions"
        onSecondaryAction={onSecondaryAction}
        testId="tile"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Create More Questions" }));
    expect(onSecondaryAction).toHaveBeenCalledTimes(1);
    // The secondary click must not bubble into the tile body's primary action.
    expect(onAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("tile"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onSecondaryAction).toHaveBeenCalledTimes(1);
  });

  it("renders a locked tile inert: no button, no click, marked disabled", async () => {
    const onAction = vi.fn();
    render(
      <SurfaceTile
        courseId="course-1"
        kicker="Mathematics"
        title="Closed test"
        actionLabel="Start"
        onAction={onAction}
        tone="locked"
        testId="tile"
      />,
    );

    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();

    const tile = screen.getByTestId("tile");
    expect(tile).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(tile);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("reaches its action from the keyboard", async () => {
    const onAction = vi.fn();
    render(
      <SurfaceTile
        courseId="course-1"
        title="Quadratic equations"
        actionLabel="Start"
        onAction={onAction}
        testId="tile"
      />,
    );

    screen.getByTestId("tile").focus();
    await userEvent.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("marks the hero so a shelf can only have one", () => {
    render(
      <SurfaceTile courseId="course-1" title="Unit test" tone="hero" testId="tile" />,
    );
    expect(screen.getByTestId("tile")).toHaveAttribute("data-tone", "hero");
  });

  it("shows progress as a fraction as well as a bar", () => {
    render(
      <SurfaceTile
        courseId="course-1"
        title="Newton's Laws"
        progress={{ value: 3, max: 7 }}
        testId="tile"
      />,
    );
    // The number is the accessible half of the bar.
    expect(screen.getByText("3/7")).toBeInTheDocument();
  });
});
