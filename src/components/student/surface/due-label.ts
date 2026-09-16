import { differenceInCalendarDays, format, isPast, isToday, isTomorrow } from "date-fns";
import type { Locale } from "date-fns";
import type { TFunction } from "i18next";

/**
 * The short deadline a tile badge carries.
 *
 * A badge has room for two words, so "in about 20 hours" is out; the ladder is
 * the one a student actually uses — is it late, is it today, is it this week,
 * or is it a date. Weekday names and dates come from date-fns with the active
 * locale, so Greek reads as Greek without a catalog entry per weekday.
 */
export function dueLabel(
  iso: string | null,
  t: TFunction,
  locale: Locale,
): { label: string; overdue: boolean } | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  if (isPast(date) && !isToday(date)) {
    return { label: t("surface.due.overdue"), overdue: true };
  }
  if (isToday(date)) return { label: t("surface.due.today"), overdue: false };
  if (isTomorrow(date)) return { label: t("surface.due.tomorrow"), overdue: false };
  if (differenceInCalendarDays(date, new Date()) < 7) {
    return { label: format(date, "EEEE", { locale }), overdue: false };
  }
  return { label: format(date, "d MMM", { locale }), overdue: false };
}
