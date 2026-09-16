/**
 * Locale resolution — the single source of truth for "which language is the UI in".
 *
 * Kept free of i18next and of React so it can be unit-tested directly, and so the
 * ordering rule below lives in one readable place rather than spread across an
 * i18next detector chain.
 */

/**
 * Locales we actually ship catalogs for.
 *
 * This is deliberately NOT `LANGUAGE_OPTIONS` from `@/lib/language-options` — that
 * list is the set of languages an institution can ask the AI to *generate content*
 * in (39 of them), which is a different question from the set of languages the UI
 * chrome has been translated into. An institution whose `default_language` is `fr`
 * still gets an English UI until someone writes `locales/fr`.
 */
export const SUPPORTED_LOCALES = ["en", "el"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const FALLBACK_LOCALE: SupportedLocale = "en";

/** Namespaces are split per surface so a locale chunk stays small as coverage grows. */
export const NAMESPACES = [
  "common",
  "evaluator",
  "student",
  "quiz",
  "studyGuide",
  "practice",
  "study",
] as const;

export const DEFAULT_NAMESPACE = "common";

/** localStorage key holding an *explicit* user choice. Absent means "never chose". */
export const LOCALE_STORAGE_KEY = "dianoisis.locale";

/** Display names, in the language itself — never translated. */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  el: "Ελληνικά",
};

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * Narrow a BCP-47 tag to a locale we ship, or null.
 *
 * `el-GR` and `EL` both resolve to `el`; `fr-FR` resolves to null because we have
 * no French catalog, even though `fr` is a valid `institutions.default_language`.
 */
export function normalizeLocale(tag: string | null | undefined): SupportedLocale | null {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isSupportedLocale(base) ? base : null;
}

export interface LocaleResolutionInput {
  /** Explicit user choice, as read from storage. Wins over everything. */
  stored?: string | null;
  /** `institutions.default_language` for the user's institution. */
  institutionDefault?: string | null;
  /** Browser preferences, most-preferred first (`navigator.languages`). */
  browser?: readonly string[];
}

/**
 * Resolve the active locale.
 *
 * Order: explicit user choice → institution default → browser preference → `en`.
 *
 * The user choice comes first on purpose: a Greek institution's English-speaking
 * exchange student must be able to override the institution, and that override has
 * to survive the institution row loading in late (which it does, asynchronously,
 * one render after the app mounts).
 */
export function resolveLocale({
  stored,
  institutionDefault,
  browser = [],
}: LocaleResolutionInput): SupportedLocale {
  const candidates = [stored, institutionDefault, ...browser];
  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) return normalized;
  }
  return FALLBACK_LOCALE;
}

/** Read the stored user choice, ignoring stale or unsupported values. */
export function readStoredLocale(): SupportedLocale | null {
  try {
    return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    // Safari in private mode, or storage disabled by policy. Not worth failing over.
    return null;
  }
}

export function writeStoredLocale(locale: SupportedLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Preference simply won't persist; the current session still switches.
  }
}
