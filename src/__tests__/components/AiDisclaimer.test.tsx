import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  AiDisclaimer,
  AI_DISCLAIMER_EL,
  AI_DISCLAIMER_EN,
  AI_DISCLAIMER_MIXED_EL,
  AI_DISCLAIMER_MIXED_EN,
  AI_FORMATIVE_NOTICE_EL,
  AI_FORMATIVE_NOTICE_EN,
} from "@/components/AiDisclaimer";

describe("AiDisclaimer (#936)", () => {
  it("says it in Greek and in English, in that order", () => {
    render(<AiDisclaimer />);

    const note = screen.getByTestId("ai-disclaimer");
    expect(note).toHaveTextContent(AI_DISCLAIMER_EL);
    expect(note).toHaveTextContent(AI_DISCLAIMER_EN);
    // Greek binds for a Greek school, so it must lead — not sit below a
    // toggle or after the English.
    const text = note.textContent ?? "";
    expect(text.indexOf(AI_DISCLAIMER_EL)).toBeLessThan(text.indexOf(AI_DISCLAIMER_EN));
  });

  it("keeps both languages in the compact variant", () => {
    render(<AiDisclaimer variant="compact" />);

    const note = screen.getByTestId("ai-disclaimer");
    expect(note).toHaveAttribute("data-variant", "compact");
    expect(note).toHaveTextContent(AI_DISCLAIMER_EL);
    expect(note).toHaveTextContent(AI_DISCLAIMER_EN);
  });

  it("labels the tooltip trigger so the notice survives without a pointer", async () => {
    // Deliberately no TooltipProvider around it: the component brings its own,
    // so a surface that forgot the context gets the notice rather than a crash.
    render(<AiDisclaimer variant="tooltip" />);

    const trigger = screen.getByTestId("ai-disclaimer");
    // A hover-only disclaimer discloses nothing on a phone or to a screen
    // reader, so the text is on the trigger itself as well as in the popover.
    expect(trigger).toHaveAccessibleName(`${AI_DISCLAIMER_EL} ${AI_DISCLAIMER_EN}`);
    expect(trigger).toHaveAttribute("tabindex", "0");

    await userEvent.hover(trigger);
    expect(await screen.findAllByText(AI_DISCLAIMER_EL)).not.toHaveLength(0);
  });

  it("makes the weaker claim for content a teacher can have rewritten", () => {
    // A cheat sheet or a piece of study-guide theory starts as the model's and
    // can be edited in place, with no column recording which happened. Saying
    // "AI-generated" flatly would attribute a teacher's words to a machine.
    render(<AiDisclaimer source="model-or-teacher" />);

    const note = screen.getByTestId("ai-disclaimer");
    expect(note).toHaveTextContent(AI_DISCLAIMER_MIXED_EL);
    expect(note).toHaveTextContent(AI_DISCLAIMER_MIXED_EN);
    expect(note).not.toHaveTextContent(AI_DISCLAIMER_EL);
    // Weaker about authorship, never about the thing that matters most.
    expect(note.textContent).toContain("λάθη");
    expect(note.textContent).toContain("errors");
  });

  it("carries the source wording through every variant", () => {
    for (const variant of ["banner", "compact"] as const) {
      const { unmount } = render(
        <AiDisclaimer variant={variant} source="model-or-teacher" />,
      );
      expect(screen.getByTestId("ai-disclaimer")).toHaveTextContent(
        AI_DISCLAIMER_MIXED_EL,
      );
      unmount();
    }

    render(<AiDisclaimer variant="tooltip" source="model-or-teacher" />);
    expect(screen.getByTestId("ai-disclaimer")).toHaveAccessibleName(
      `${AI_DISCLAIMER_MIXED_EL} ${AI_DISCLAIMER_MIXED_EN}`,
    );
  });

  it("does not dim the English line in the compact variant", () => {
    // The compact variant starts from `text-muted-foreground`, which is already
    // the dimmest readable token: 5.20:1 on `--card` in light, 5.66:1 in dark.
    // Dimming it a further 20% measures 3.46:1 and 4.10:1 — under the 4.5:1
    // WCAG AA requires at this size. The banner and tooltip start from much
    // higher-contrast colours and stay above the line, so only this one is
    // affected — and it is the variant on both tutor chats, so it is the
    // notice most students actually read.
    render(<AiDisclaimer variant="compact" />);

    const note = screen.getByTestId("ai-disclaimer");
    for (const el of [note, ...Array.from(note.querySelectorAll("*"))]) {
      // `getAttribute` rather than `.className` — the icon is an <svg>, whose
      // className is an SVGAnimatedString rather than a string.
      expect(el.getAttribute("class") ?? "").not.toMatch(/\bopacity-\d/);
    }
  });

  it("says a score is formative, on the surfaces that carry one", () => {
    render(<AiDisclaimer assessment />);

    const note = screen.getByTestId("ai-disclaimer");
    expect(note).toHaveTextContent(AI_FORMATIVE_NOTICE_EL);
    expect(note).toHaveTextContent(AI_FORMATIVE_NOTICE_EN);
    // The base sentence still leads — "may contain errors" is what a student
    // needs first; what the score is *for* is what a school needs.
    expect(note).toHaveTextContent(AI_DISCLAIMER_EL);

    const text = note.textContent ?? "";
    expect(text.indexOf(AI_DISCLAIMER_EL)).toBeLessThan(
      text.indexOf(AI_FORMATIVE_NOTICE_EL),
    );
    // Greek gets both its sentences before any English begins.
    expect(text.indexOf(AI_FORMATIVE_NOTICE_EL)).toBeLessThan(
      text.indexOf(AI_DISCLAIMER_EN),
    );
  });

  it("keeps the formative sentence off generated study material", () => {
    // A flashcard, a cheat sheet, a tutor turn — none of them decides anything
    // about a student, and a notice repeated where it does not apply is a
    // notice people learn to skip.
    render(<AiDisclaimer />);

    const note = screen.getByTestId("ai-disclaimer");
    expect(note).not.toHaveTextContent(AI_FORMATIVE_NOTICE_EL);
    expect(note).not.toHaveTextContent(AI_FORMATIVE_NOTICE_EN);
  });

  it("carries the formative sentence through every variant", () => {
    for (const variant of ["banner", "compact"] as const) {
      const { unmount } = render(<AiDisclaimer variant={variant} assessment />);
      expect(screen.getByTestId("ai-disclaimer")).toHaveTextContent(
        AI_FORMATIVE_NOTICE_EL,
      );
      unmount();
    }

    // The tooltip trigger shows only an icon, so the accessible name is the
    // whole notice — all four sentences, or a screen-reader user loses the
    // half that says what the score is for.
    render(<AiDisclaimer variant="tooltip" assessment />);
    expect(screen.getByTestId("ai-disclaimer")).toHaveAccessibleName(
      `${AI_DISCLAIMER_EL} ${AI_FORMATIVE_NOTICE_EL} ${AI_DISCLAIMER_EN} ${AI_FORMATIVE_NOTICE_EN}`,
    );
  });

  it("has no dismiss control in any variant", () => {
    for (const variant of ["banner", "compact", "tooltip"] as const) {
      const { unmount } = render(<AiDisclaimer variant={variant} />);
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });
});
