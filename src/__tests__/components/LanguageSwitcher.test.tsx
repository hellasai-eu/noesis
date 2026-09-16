import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { EvaluatorNavBar } from "@/components/evaluator/EvaluatorNavBar";
import i18n from "@/i18n";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";

function noop() {
  /* nav callbacks are irrelevant here */
}

describe("LanguageSwitcher", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage("en");
  });

  it("shows the active locale code", () => {
    render(<LanguageSwitcher />);
    expect(screen.getByTestId("language-switcher")).toHaveTextContent("en");
  });

  it("persists the choice and switches i18next", async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(screen.getByTestId("language-switcher"));
    await user.click(await screen.findByTestId("language-option-el"));

    await waitFor(() => expect(i18n.language).toBe("el"));
    // Persisted, so the choice outranks institutions.default_language on the
    // next load rather than being re-derived from the institution.
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("el");
  });

  it("retranslates already-mounted components when the locale changes", async () => {
    const user = userEvent.setup();
    render(
      <>
        <LanguageSwitcher />
        <EvaluatorNavBar
          currentIndex={2}
          total={7}
          hasUnevaluated
          autoAdvance={false}
          onPrev={noop}
          onNext={noop}
          onJumpUnevaluated={noop}
          onToggleAutoAdvance={noop}
        />
      </>
    );

    expect(screen.getByTestId("nav-position")).toHaveTextContent("Question 3 of 7");

    await user.click(screen.getByTestId("language-switcher"));
    await user.click(await screen.findByTestId("language-option-el"));

    // Interpolated values survive the switch — this is the assertion that would
    // catch a translation dropping a `{{...}}` placeholder in a live component.
    await waitFor(() =>
      expect(screen.getByTestId("nav-position")).toHaveTextContent("Ερώτηση 3 από 7")
    );
  });
});
