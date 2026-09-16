/**
 * The shared answer fields render translated copy.
 *
 * These are the inputs a student actually types into, in both the quiz and the
 * study-guide player. Two things make them worth their own test:
 *
 * 1. greptile caught my first sweep leaving the broken-question alerts, the
 *    drag handle's screen-reader label and the open-answer notes in English.
 * 2. Wiring those up introduced a `t` with no hook in `OrderingSortableRow` —
 *    a runtime crash for anyone answering an ordering question. Nothing here
 *    rendered these components, so nothing caught it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  ClassificationField,
  FillGapsField,
  OpenField,
  OrderingField,
} from "@/components/question-fields";
import i18n from "@/i18n";

function noop() {
  /* fields are read-only in these tests */
}

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("question fields — translated copy", () => {
  it("renders an ordering field, including the drag handle's label", () => {
    // Regression guard: `OrderingSortableRow` calls `t` and had no hook, which
    // threw the moment this component mounted.
    render(
      <OrderingField
        value={["alpha", "beta"]}
        canonical={["alpha", "beta"]}
        onChange={noop}
        disabled={false}
        reveal={false}
        needsConfirm
      />
    );

    expect(screen.getByRole("button", { name: "Drag item at position 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep this order" })).toBeInTheDocument();
    expect(screen.getByText(/This order was shuffled for you/)).toBeInTheDocument();
  });

  it("renders the ordering field in Greek", async () => {
    await i18n.changeLanguage("el");
    render(
      <OrderingField
        value={["alpha", "beta"]}
        canonical={["alpha", "beta"]}
        onChange={noop}
        disabled={false}
        reveal={false}
        needsConfirm
      />
    );

    expect(
      screen.getByRole("button", { name: "Σύρε το στοιχείο στη θέση 1" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Κράτα αυτή τη σειρά" })).toBeInTheDocument();
  });

  it("translates the broken-question alerts, in both locales", async () => {
    // The only text a student sees when a question cannot be rendered at all,
    // so leaving it English is the worst place to leave it.
    const { unmount } = render(
      <OrderingField
        value={[]}
        canonical={[]}
        onChange={noop}
        disabled={false}
        reveal={false}
      />
    );
    expect(screen.getByText(/This ordering question is missing its items/)).toBeInTheDocument();
    unmount();

    await i18n.changeLanguage("el");
    render(
      <OrderingField
        value={[]}
        canonical={[]}
        onChange={noop}
        disabled={false}
        reveal={false}
      />
    );
    expect(
      screen.getByText(/Σε αυτή την ερώτηση σειράς λείπουν τα στοιχεία/)
    ).toBeInTheDocument();
  });

  it("translates the classification field's broken state", async () => {
    await i18n.changeLanguage("el");
    render(
      <ClassificationField
        questionId="q1"
        categories={[]}
        items={[]}
        assignments={{}}
        userId="u1"
        value={{}}
        onSelect={noop}
        disabled={false}
        reveal={false}
      />
    );

    expect(
      screen.getByText(/Σε αυτή την ερώτηση ταξινόμησης λείπουν/)
    ).toBeInTheDocument();
  });

  it("translates the fill-gaps field's broken state", async () => {
    await i18n.changeLanguage("el");
    render(
      <FillGapsField
        stem="no gaps here"
        gaps={[]}
        value={[]}
        onChange={noop}
        disabled={false}
        reveal={false}
      />
    );

    expect(
      screen.getByText(/Σε αυτή την ερώτηση συμπλήρωσης λείπουν τα κενά/)
    ).toBeInTheDocument();
  });

  it("translates the open field's input and its recording notice", async () => {
    const { unmount } = render(
      <OpenField value="" onChange={noop} disabled={false} reveal={false} />
    );
    expect(
      screen.getByPlaceholderText("Write your answer here...")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your answer will be recorded for your instructor to review.")
    ).toBeInTheDocument();
    unmount();

    await i18n.changeLanguage("el");
    render(<OpenField value="" onChange={noop} disabled={false} reveal={false} />);
    expect(
      screen.getByPlaceholderText("Γράψε την απάντησή σου εδώ...")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Η απάντησή σου θα καταγραφεί για να τη δει ο καθηγητής σου.")
    ).toBeInTheDocument();
  });

  it("translates the expected-answers list, including the alternates", async () => {
    // greptile's second finding: the "(also accepted: …)" aside sat beside
    // already-translated text. It opens with a bracket, which is exactly why
    // three successive greps looking for a leading capital never saw it.
    const props = {
      stem: "Water freezes at {{1}} degrees.",
      gaps: [{ ordinal: 1, acceptable: ["zero", "0", "nought"] }],
      value: ["wrong"],
      onChange: noop,
      disabled: true,
      reveal: true,
    };

    const { unmount } = render(<FillGapsField {...props} />);
    expect(screen.getByText("Expected answers")).toBeInTheDocument();
    expect(screen.getByText("(also accepted: 0, nought)")).toBeInTheDocument();
    unmount();

    await i18n.changeLanguage("el");
    render(<FillGapsField {...props} />);
    expect(screen.getByText("Αναμενόμενες απαντήσεις")).toBeInTheDocument();
    expect(
      screen.getByText("(γίνονται δεκτά επίσης: 0, nought)")
    ).toBeInTheDocument();
  });

  it("translates the reviewed open answer, including the empty placeholder", async () => {
    await i18n.changeLanguage("el");
    render(<OpenField value="" onChange={noop} disabled reveal />);

    expect(screen.getByText("(καμία απάντηση)")).toBeInTheDocument();
    expect(
      screen.getByText("Οι ανοικτές απαντήσεις καταγράφονται για να τις δει ο καθηγητής σου.")
    ).toBeInTheDocument();
  });
});
