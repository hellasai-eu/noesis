import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { useInstitutionConfig } from "@/hooks/useInstitutionConfig";
import {
  getSelectedInstitutionId,
  subscribeSelectedInstitution,
} from "@/lib/selected-institution";

import { readStoredLocale, resolveLocale, writeStoredLocale, type SupportedLocale } from "./config";
import { LocaleContext, type LocaleContextValue } from "./locale-context";

/** `useSyncExternalStore` requires a stable server snapshot; this app is a SPA. */
const noSelection = () => null;

/**
 * Owns the active UI locale.
 *
 * `src/i18n/index.ts` already picked a locale synchronously from storage and the
 * browser before React mounted, so there is never untranslated text on screen.
 * This provider exists for the one input that cannot be read synchronously:
 * `institutions.default_language`, which needs an authenticated round-trip and
 * therefore lands a few renders late.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();

  const [hasExplicitChoice, setHasExplicitChoice] = useState(
    () => readStoredLocale() !== null
  );

  // Subscribed rather than read once: a multi-institution user can switch
  // institutions without the page reloading and without the user id changing,
  // and the UI language has to follow them. Reading through `useUserInstitution`
  // instead would go stale exactly there — that hook re-resolves only when the
  // user id changes, which a switch does not.
  const selectedInstitutionId = useSyncExternalStore(
    subscribeSelectedInstitution,
    getSelectedInstitutionId,
    noSelection
  );

  // This provider wraps every route, so its lookup runs on every page load — on
  // top of the identical one the pages themselves already make. A user who has
  // chosen a language never consults the institution default, so skip the query
  // entirely for them: a null id short-circuits the hook before it queries.
  const institutionId = hasExplicitChoice ? null : selectedInstitutionId;
  const { defaultLanguage, loading: configLoading } = useInstitutionConfig(institutionId);

  const language = i18n.language;

  // Apply the institution default once it arrives — but only for users who have
  // never chosen. Overriding an explicit choice here would silently undo the
  // language switcher one render after the user used it.
  useEffect(() => {
    if (hasExplicitChoice || configLoading || !institutionId) return;

    const resolved = resolveLocale({
      institutionDefault: defaultLanguage,
      browser: typeof navigator === "undefined" ? [] : navigator.languages,
    });

    if (resolved !== i18n.language) {
      void i18n.changeLanguage(resolved);
    }
  }, [hasExplicitChoice, configLoading, institutionId, defaultLanguage, i18n]);

  // Keep the document in sync so screen readers and `:lang()` CSS agree with
  // what is on screen, and so browser translation prompts stop firing.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLocale = useCallback(
    (next: SupportedLocale) => {
      writeStoredLocale(next);
      setHasExplicitChoice(true);
      void i18n.changeLanguage(next);
    },
    [i18n]
  );

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale: (language as SupportedLocale) ?? "en",
      setLocale,
      hasExplicitChoice,
    }),
    [language, setLocale, hasExplicitChoice]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
