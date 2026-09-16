/**
 * Locale-aware formatting and sorting.
 *
 * Extracting strings alone does not localise a screen. Three things stay wrong
 * until they are given the active locale explicitly:
 *
 * - `format(date, "MMM d")` renders "Sep 3" under any catalog.
 * - A bare `toLocaleDateString()` follows the *runtime's* locale, not the one
 *   the user picked — so an English UI in a Greek browser prints Greek dates.
 * - A bare `localeCompare` sorts by the runtime's collation, so two users see
 *   the same list of names in different orders.
 *
 * Both hook and plain-function forms are exported. Components should prefer the
 * hooks, which re-render on a language change; the plain forms exist for module
 * scope and for callbacks where a hook cannot be called, and read the i18next
 * singleton directly.
 */
import { el, enUS, type Locale } from "date-fns/locale";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import i18n from "./index";
import { FALLBACK_LOCALE, normalizeLocale, type SupportedLocale } from "./config";

/** date-fns locale objects, one per locale we ship a catalog for. */
const DATE_FNS_LOCALES: Record<SupportedLocale, Locale> = {
  en: enUS,
  el,
};

export function dateFnsLocaleFor(tag: string | null | undefined): Locale {
  return DATE_FNS_LOCALES[normalizeLocale(tag) ?? FALLBACK_LOCALE];
}

/**
 * BCP-47 tag for `Intl` / `toLocaleDateString`.
 *
 * Regionless on purpose: we ship language catalogs, not regional variants, so
 * claiming `en-US` or `el-GR` would assert a regional convention we have not
 * chosen. `Intl` resolves a bare language to a sensible default.
 */
export function intlLocaleFor(tag: string | null | undefined): SupportedLocale {
  return normalizeLocale(tag) ?? FALLBACK_LOCALE;
}

/**
 * The active locale, read outside React.
 *
 * Not reactive: a component that formats through this and renders no translated
 * text will keep its old formatting until something else re-renders it. Use
 * `useIntlLocale` where that matters.
 */
export function currentLocale(): SupportedLocale {
  return intlLocaleFor(i18n.language);
}

/** The active locale's date-fns object, for `format`/`formatDistanceToNow`. */
export function useDateFnsLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return dateFnsLocaleFor(instance.language);
}

/** The active locale as a tag for `Intl` and the `toLocale*` methods. */
export function useIntlLocale(): SupportedLocale {
  const { i18n: instance } = useTranslation();
  return intlLocaleFor(instance.language);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Parse whatever the callers hold — a `Date`, an ISO string, an epoch number —
 * into a `Date`, or `null` when it is not a usable instant. Returning `null`
 * rather than `Invalid Date` keeps "no value" and "bad value" out of the UI as
 * the literal string "Invalid Date", which is what several call sites rendered.
 */
function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A date in the active locale. `fallback` is rendered for a missing value. */
export function formatDate(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  fallback = "—",
): string {
  const date = toDate(value);
  return date ? date.toLocaleDateString(currentLocale(), options) : fallback;
}

/** A date and time in the active locale. */
export function formatDateTime(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  fallback = "—",
): string {
  const date = toDate(value);
  return date ? date.toLocaleString(currentLocale(), options) : fallback;
}

/** A time of day in the active locale. */
export function formatTime(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  fallback = "—",
): string {
  const date = toDate(value);
  return date ? date.toLocaleTimeString(currentLocale(), options) : fallback;
}

/** A number in the active locale. */
export function formatNumber(
  value: number | null | undefined,
  options?: Intl.NumberFormatOptions,
  fallback = "—",
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(currentLocale(), options)
    : fallback;
}

// ---------------------------------------------------------------------------
// Collation
// ---------------------------------------------------------------------------

/**
 * One collator per locale.
 *
 * `String.prototype.localeCompare` builds a collator on every call, so sorting
 * a list of n names constructed one per comparison — O(n log n) of them. A
 * cached `Intl.Collator` is the documented way to avoid that, and it is also
 * the only way to pin the collation to the app's locale rather than the
 * runtime's.
 */
const COLLATORS = new Map<string, Intl.Collator>();

export function collatorFor(tag: string | null | undefined): Intl.Collator {
  const locale = intlLocaleFor(tag);
  let collator = COLLATORS.get(locale);
  if (!collator) {
    // `numeric` so "Τμήμα 2" sorts before "Τμήμα 10"; `base` so case and
    // accents do not split otherwise-equal names apart.
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    COLLATORS.set(locale, collator);
  }
  return collator;
}

/**
 * Compare two display strings in the active locale.
 *
 * The drop-in replacement for a bare `localeCompare` in a sort comparator.
 * `null` and `undefined` sort last rather than throwing.
 *
 * The empty string is NOT treated as missing. It is a string, it collates ahead
 * of everything else exactly as `localeCompare` puts it, and callers rely on
 * that: `GradeLevelDetailPanel` stores its default category as `""` and
 * documents that the default sorts first, while several sorts pass
 * `a.name || ""` to give an absent name a defined position. Treating `""` as
 * missing quietly reverses all of them.
 */
export function compareText(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return collatorFor(i18n.language).compare(a, b);
}

/**
 * Compare two machine values — an id, an ISO timestamp, a code.
 *
 * The counterpart to `compareText`, and the choice to make whenever the strings
 * are not read by anyone. Several sorts reached for `localeCompare` on ISO dates
 * and grade-level ids, which is both slower and wrong in principle: the order of
 * a timestamp must not depend on who is looking at it.
 */
export function compareCode(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The active locale's collator, for a component that sorts on every render. */
export function useCollator(): Intl.Collator {
  const { i18n: instance } = useTranslation();
  return useMemo(() => collatorFor(instance.language), [instance.language]);
}

// ---------------------------------------------------------------------------
// The React entry point
// ---------------------------------------------------------------------------

/**
 * The formatters, bound to the active locale and subscribed to changes of it.
 *
 * This is what a component should use. The plain functions above read the
 * current locale correctly whenever they run, but nothing tells React to run a
 * component again when the language changes — so a screen that renders dates or
 * sorted names and no translated text would keep the previous locale's
 * formatting until an unrelated re-render or a navigation.
 *
 * Destructuring gives the call sites the same names and shapes as the plain
 * functions, so the only line that differs from module scope is this one:
 *
 * ```tsx
 * const { formatDate, compareText } = useFormatters();
 * ```
 *
 * Module-scope helpers cannot call a hook and go on using the plain functions;
 * they are correct at call time and stale only across a language switch.
 */
export function useFormatters() {
  const { i18n: instance } = useTranslation();
  const locale = intlLocaleFor(instance.language);

  return useMemo(
    () => ({
      formatDate: (
        value: Date | string | number | null | undefined,
        options?: Intl.DateTimeFormatOptions,
        fallback = "—",
      ) => {
        const date = toDate(value);
        return date ? date.toLocaleDateString(locale, options) : fallback;
      },
      formatDateTime: (
        value: Date | string | number | null | undefined,
        options?: Intl.DateTimeFormatOptions,
        fallback = "—",
      ) => {
        const date = toDate(value);
        return date ? date.toLocaleString(locale, options) : fallback;
      },
      formatTime: (
        value: Date | string | number | null | undefined,
        options?: Intl.DateTimeFormatOptions,
        fallback = "—",
      ) => {
        const date = toDate(value);
        return date ? date.toLocaleTimeString(locale, options) : fallback;
      },
      formatNumber: (
        value: number | null | undefined,
        options?: Intl.NumberFormatOptions,
        fallback = "—",
      ) =>
        typeof value === "number" && Number.isFinite(value)
          ? value.toLocaleString(locale, options)
          : fallback,
      compareText: (a: string | null | undefined, b: string | null | undefined) => {
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
        return collatorFor(locale).compare(a, b);
      },
      compareCode,
    }),
    [locale],
  );
}
