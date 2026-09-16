/**
 * LocaleProvider — institution-default behaviour.
 *
 * The switch case here is the one greptile flagged on #1197: a multi-institution
 * user with no explicit language choice switches institutions without a reload
 * and without their user id changing. Resolving the institution through
 * `useUserInstitution` went stale exactly there.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

import i18n from "@/i18n";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { useLocale } from "@/i18n/locale-context";
import {
  clearSelectedInstitutionId,
  setSelectedInstitutionId,
} from "@/lib/selected-institution";

/** institution id → default_language, as `useInstitutionConfig` would report it. */
const INSTITUTION_LANGUAGE: Record<string, string> = {
  "inst-greek": "el",
  "inst-english": "en",
  "inst-french": "fr",
};

vi.mock("@/hooks/useInstitutionConfig", () => ({
  useInstitutionConfig: (institutionId: string | null) => ({
    institutionType: "generic",
    schoolLevels: [],
    defaultLanguage: institutionId ? INSTITUTION_LANGUAGE[institutionId] ?? "en" : "en",
    academicPeriod: null,
    loading: false,
  }),
}));

function LocaleProbe() {
  const { locale } = useLocale();
  return <span data-testid="locale">{locale}</span>;
}

function renderProvider() {
  return render(
    <LocaleProvider>
      <LocaleProbe />
    </LocaleProvider>
  );
}

describe("LocaleProvider", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    clearSelectedInstitutionId();
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  afterEach(async () => {
    window.localStorage.clear();
    clearSelectedInstitutionId();
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  });

  it("adopts the institution default when the user has never chosen", async () => {
    setSelectedInstitutionId("inst-greek");
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("el"));
  });

  it("follows an in-app institution switch with no reload", async () => {
    setSelectedInstitutionId("inst-greek");
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("el"));

    // The user id does not change here — only the selected institution does.
    act(() => setSelectedInstitutionId("inst-english"));

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("en"));
  });

  it("does not override an explicit user choice", async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    setSelectedInstitutionId("inst-greek");

    renderProvider();

    // Give the institution effect every chance to fire and lose.
    await waitFor(() => expect(screen.getByTestId("locale")).toBeInTheDocument());
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
    expect(i18n.language).toBe("en");
  });

  it("ignores an institution default with no catalog", async () => {
    setSelectedInstitutionId("inst-french");
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("locale")).toBeInTheDocument());
    // `fr` is a valid institutions.default_language but has no UI catalog, so
    // the browser/fallback tier decides instead of shipping a half-French UI.
    expect(screen.getByTestId("locale")).toHaveTextContent("en");
  });

  it("keeps <html lang> in step with the active locale", async () => {
    setSelectedInstitutionId("inst-greek");
    renderProvider();

    await waitFor(() => expect(document.documentElement.lang).toBe("el"));
  });
});
