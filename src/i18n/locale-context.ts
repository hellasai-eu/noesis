import { createContext, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { readStoredLocale, writeStoredLocale, type SupportedLocale } from "./config";

export interface LocaleContextValue {
  locale: SupportedLocale;
  /** Records an explicit user choice: persists it and switches immediately. */
  setLocale: (locale: SupportedLocale) => void;
  /** True once the user has picked a language; their pick outranks the institution. */
  hasExplicitChoice: boolean;
}

/**
 * Split out of `LocaleProvider.tsx` so that file exports only its component and
 * stays eligible for React Fast Refresh.
 */
export const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

/**
 * Read and change the active locale.
 *
 * Falls back to a provider-less mode so a component under test renders without
 * being wrapped: the i18next instance is a module-level singleton, so reading
 * and switching still work — only the institution-default sync is absent.
 */
export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  const { i18n } = useTranslation();

  // Hoisted into its own binding so the dependency list tracks the *language*.
  // `i18n` is a stable singleton, so depending on it alone would pin the value
  // to whatever the language was on first render.
  const language = i18n.language;

  const fallback = useMemo<LocaleContextValue>(
    () => ({
      locale: (language as SupportedLocale) ?? "en",
      setLocale: (next: SupportedLocale) => {
        writeStoredLocale(next);
        void i18n.changeLanguage(next);
      },
      hasExplicitChoice: readStoredLocale() !== null,
    }),
    [i18n, language]
  );

  return context ?? fallback;
}
