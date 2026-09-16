/**
 * The chips are the surface's only navigation, so they have to be reachable
 * the way a radio group is reachable: one tab stop, arrows to move and select,
 * Home and End to the ends. Eight separately-tabbable buttons would put a
 * student's whole timetable between the keyboard and the first shelf.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { CourseChips } from "@/components/student/surface/CourseChips";

const COURSES = [
  { id: "course-1", title: "Mathematics", description: null, theme: null },
  { id: "course-2", title: "Physics", description: null, theme: null },
  { id: "course-3", title: "Biology", description: null, theme: null },
];

function renderChips(selectedCourseId: string | null, onSelect = vi.fn()) {
  render(
    <CourseChips
      courses={COURSES}
      selectedCourseId={selectedCourseId}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("CourseChips", () => {
  it("is a single tab stop, landing on the selected option", async () => {
    renderChips("course-2");

    const options = screen.getAllByRole("radio");
    // Only the selected chip is in the tab order.
    expect(options.filter((o) => o.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(screen.getByTestId("course-chip-course-2")).toHaveAttribute("tabindex", "0");

    await userEvent.tab();
    expect(screen.getByTestId("course-chip-course-2")).toHaveFocus();
  });

  it("moves and selects with the arrow keys, wrapping at both ends", async () => {
    const onSelect = renderChips(null);

    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}");
    expect(onSelect).toHaveBeenLastCalledWith("course-1");

    // From "Everything", going left wraps to the last course.
    await userEvent.keyboard("{ArrowLeft}");
    expect(onSelect).toHaveBeenLastCalledWith("course-3");
  });

  it("jumps to the ends with Home and End", async () => {
    const onSelect = renderChips("course-2");

    await userEvent.tab();
    await userEvent.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("course-3");

    await userEvent.keyboard("{Home}");
    // Home is "Everything" — the filter's off position.
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("reports the current selection to assistive technology", () => {
    renderChips("course-1");
    expect(screen.getByTestId("course-chip-course-1")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("course-chip-course-2")).toHaveAttribute("aria-checked", "false");
  });
});
