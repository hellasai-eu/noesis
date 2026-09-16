/**
 * The quiz catalog's `<Trans>` messages.
 *
 * Mounting `StudentQuiz` needs a very large mock surface, and would mostly test
 * the mocks. These messages are where the real risk is: each carries component
 * slots, and two also carry plurals, so a translation can break in a way that
 * renders a literal `<1>` on screen or silently drops the count. Rendered here
 * exactly as the component does.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Trans } from "react-i18next";

import i18n from "@/i18n";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("quiz Trans messages", () => {
  describe("the timed-start warning", () => {
    function Warning({ minutes }: { minutes: number }) {
      return (
        <Trans
          i18nKey="quiz:timedStart.warning"
          values={{ count: minutes }}
          components={{ 1: <strong data-testid="limit" />, 2: <strong data-testid="cannot" /> }}
        />
      );
    }

    it("fills both slots in English", () => {
      render(<Warning minutes={30} />);
      expect(screen.getByTestId("limit")).toHaveTextContent("30-minute");
      expect(screen.getByTestId("cannot")).toHaveTextContent("cannot be paused or stopped");
      expect(screen.queryByText(/<1>|<2>/)).not.toBeInTheDocument();
    });

    it("fills both slots in Greek", async () => {
      await i18n.changeLanguage("el");
      render(<Warning minutes={30} />);
      expect(screen.getByTestId("limit")).toHaveTextContent("30 λεπτών");
      expect(screen.getByTestId("cannot")).toHaveTextContent("δεν σταματά ούτε διακόπτεται");
      expect(screen.queryByText(/<1>|<2>/)).not.toBeInTheDocument();
    });
  });

  describe("the grace-period dialog", () => {
    // The only message carrying a plural AND a component slot together, which
    // is the combination most likely to be got wrong in a translation.
    function Grace({ seconds }: { seconds: number }) {
      return (
        <Trans
          i18nKey="quiz:graceDialog.body"
          count={seconds}
          values={{ count: seconds }}
          components={{ 1: <strong data-testid="countdown" /> }}
        />
      );
    }

    it("inflects the countdown in English", () => {
      const { unmount } = render(<Grace seconds={1} />);
      expect(screen.getByTestId("countdown")).toHaveTextContent("1 second");
      unmount();

      render(<Grace seconds={30} />);
      expect(screen.getByTestId("countdown")).toHaveTextContent("30 seconds");
    });

    it("inflects the countdown in Greek", async () => {
      await i18n.changeLanguage("el");
      const { unmount } = render(<Grace seconds={1} />);
      expect(screen.getByTestId("countdown")).toHaveTextContent("1 δευτερόλεπτο");
      unmount();

      render(<Grace seconds={30} />);
      expect(screen.getByTestId("countdown")).toHaveTextContent("30 δευτερόλεπτα");
    });
  });

  describe("the submitted-count line", () => {
    function Answered({ count }: { count: number }) {
      return (
        <Trans
          i18nKey="quiz:submitted.answeredCount"
          values={{ count }}
          components={{ 1: <span data-testid="count" /> }}
        />
      );
    }

    it("puts the count in its own slot, in both locales", async () => {
      const { unmount } = render(<Answered count={12} />);
      expect(screen.getByTestId("count")).toHaveTextContent("12");
      expect(screen.getByText(/You answered/)).toBeInTheDocument();
      unmount();

      await i18n.changeLanguage("el");
      render(<Answered count={12} />);
      expect(screen.getByTestId("count")).toHaveTextContent("12");
      expect(screen.getByText(/Απάντησες σε/)).toBeInTheDocument();
    });
  });

  describe("the exit-dialog warnings", () => {
    it("renders both slotted sentences in Greek", async () => {
      await i18n.changeLanguage("el");

      const { unmount } = render(
        <Trans
          i18nKey="quiz:exitDialog.warningBody"
          components={{ 1: <strong data-testid="no-resume" /> }}
        />
      );
      expect(screen.getByTestId("no-resume")).toHaveTextContent("δεν θα μπορείς να συνεχίσεις");
      unmount();

      render(
        <Trans
          i18nKey="quiz:exitDialog.timeExpiredBody"
          components={{ 1: <strong data-testid="expired" /> }}
        />
      );
      expect(screen.getByTestId("expired")).toHaveTextContent("Ο χρόνος έληξε");
    });
  });
});

describe("quiz plural toasts", () => {
  it("inflects the unanswered count in both locales", async () => {
    expect(i18n.t("quiz:submitDialog.unanswered", { count: 1 })).toContain(
      "1 unanswered question."
    );
    expect(i18n.t("quiz:submitDialog.unanswered", { count: 3 })).toContain(
      "3 unanswered questions."
    );

    await i18n.changeLanguage("el");
    expect(i18n.t("quiz:submitDialog.unanswered", { count: 1 })).toContain(
      "1 αναπάντητη ερώτηση"
    );
    expect(i18n.t("quiz:submitDialog.unanswered", { count: 3 })).toContain(
      "3 αναπάντητες ερωτήσεις"
    );
  });
});
