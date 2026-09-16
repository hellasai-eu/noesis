/**
 * Locale-aware formatting and collation.
 *
 * These are the two things string extraction never touches: a bare
 * `toLocaleDateString()` follows the *runtime's* locale rather than the chosen
 * one, and a bare `localeCompare` sorts by the runtime's collation — so two
 * users can see the same list in different orders.
 */
import { describe, it, expect, afterEach } from "vitest";

import i18n from "@/i18n";
import {
  collatorFor,
  compareText,
  currentLocale,
  dateFnsLocaleFor,
  formatDate,
  formatDateTime,
  formatNumber,
  formatTime,
  intlLocaleFor,
} from "@/i18n/formatters";

const JAN_2026 = "2026-01-15T13:45:00Z";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("locale resolution", () => {
  it("narrows a tag to a locale we ship", () => {
    expect(intlLocaleFor("el-GR")).toBe("el");
    expect(intlLocaleFor("en_US")).toBe("en");
    // No French catalog, so no French formatting either.
    expect(intlLocaleFor("fr")).toBe("en");
    expect(intlLocaleFor(null)).toBe("en");
  });

  it("maps to the matching date-fns locale", () => {
    expect(dateFnsLocaleFor("el").code).toBe("el");
    expect(dateFnsLocaleFor("en").code).toBe("en-US");
    expect(dateFnsLocaleFor("fr").code).toBe("en-US");
  });

  it("follows the active language", async () => {
    expect(currentLocale()).toBe("en");
    await i18n.changeLanguage("el");
    expect(currentLocale()).toBe("el");
  });
});

describe("formatDate", () => {
  it("formats in the active locale, not the runtime's", async () => {
    const inEnglish = formatDate(JAN_2026);
    await i18n.changeLanguage("el");
    const inGreek = formatDate(JAN_2026);

    // Both render the same instant; the point is that the locale is consulted
    // at all, so switching language changes the output.
    expect(inEnglish).toMatch(/2026/);
    expect(inGreek).toMatch(/2026/);
    expect(formatDate(JAN_2026, { month: "long" })).not.toBe(
      "January",
    );
  });

  it("renders month names from the active locale", async () => {
    expect(formatDate(JAN_2026, { month: "long" })).toContain("January");
    await i18n.changeLanguage("el");
    expect(formatDate(JAN_2026, { month: "long" })).toContain("Ιαν");
  });

  it("returns the fallback for a missing or unusable value", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    // "Invalid Date" used to reach the screen from several call sites.
    expect(formatDate("not a date")).toBe("—");
    expect(formatDate(null, undefined, "never")).toBe("never");
  });

  it("accepts a Date, an ISO string and an epoch number alike", () => {
    const iso = formatDate(JAN_2026, { year: "numeric" });
    expect(formatDate(new Date(JAN_2026), { year: "numeric" })).toBe(iso);
    expect(formatDate(Date.parse(JAN_2026), { year: "numeric" })).toBe(iso);
  });
});

describe("formatDateTime / formatTime / formatNumber", () => {
  it("fall back rather than printing Invalid Date", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats numbers in the active locale", async () => {
    expect(formatNumber(1234.5)).toBe("1,234.5");
    await i18n.changeLanguage("el");
    // Greek groups with '.' and uses ',' as the decimal separator.
    expect(formatNumber(1234.5)).toBe("1.234,5");
  });

  it("formats zero rather than treating it as missing", () => {
    expect(formatNumber(0)).toBe("0");
  });
});

describe("compareText", () => {
  it("sorts Greek text in Greek order", async () => {
    await i18n.changeLanguage("el");
    const sorted = ["Γιώργος", "Αννα", "Βασίλης"].sort(compareText);
    expect(sorted).toEqual(["Αννα", "Βασίλης", "Γιώργος"]);
  });

  it("sorts numerically within text, so 2 comes before 10", () => {
    const sorted = ["Τμήμα 10", "Τμήμα 2", "Τμήμα 1"].sort(compareText);
    expect(sorted).toEqual(["Τμήμα 1", "Τμήμα 2", "Τμήμα 10"]);
  });

  it("ignores case and accents rather than splitting equal names apart", () => {
    expect(compareText("Ana", "ana")).toBe(0);
    expect(compareText("Άννα", "Αννα")).toBe(0);
  });

  it("sorts nullish values last instead of throwing", () => {
    // `Array.prototype.sort` moves `undefined` to the end itself, without ever
    // calling the comparator, so only the position of the real strings is
    // this function's doing. `null` is compared and has to be pushed back too.
    expect([undefined, "b", null, "a"].sort(compareText).slice(0, 2)).toEqual([
      "a",
      "b",
    ]);
    expect(compareText(null, "a")).toBeGreaterThan(0);
    expect(compareText("a", null)).toBeLessThan(0);
    expect(compareText(null, null)).toBe(0);
  });

  it("keeps the empty string first, where localeCompare puts it", () => {
    // `""` is a value, not a missing one. `GradeLevelDetailPanel` stores its
    // default category as `""` and documents that the default sorts first, and
    // several sorts pass `a.name || ""` to give an absent name a position.
    // Treating it as missing silently reverses every one of them.
    expect(compareText("", "Alpha")).toBeLessThan(0);
    expect(compareText("Alpha", "")).toBeGreaterThan(0);
    expect(compareText("", "")).toBe(0);
    expect(["Beta", "", "Alpha"].sort(compareText)).toEqual(["", "Alpha", "Beta"]);
  });
});

describe("collatorFor", () => {
  it("returns the same instance for a locale", () => {
    // Sorting builds one comparison per pair; `localeCompare` would construct a
    // collator for each of them.
    expect(collatorFor("el")).toBe(collatorFor("el"));
    expect(collatorFor("el")).not.toBe(collatorFor("en"));
  });

  it("treats regional tags as their base language", () => {
    expect(collatorFor("el-GR")).toBe(collatorFor("el"));
  });
});
