import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
  FALLBACK_LOCALE,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  readStoredLocale,
  resolveLocale,
  writeStoredLocale,
} from "@/i18n/config";

describe("normalizeLocale", () => {
  it("accepts a bare supported code", () => {
    expect(normalizeLocale("el")).toBe("el");
    expect(normalizeLocale("en")).toBe("en");
  });

  it("narrows a regional tag to its base language", () => {
    expect(normalizeLocale("el-GR")).toBe("el");
    expect(normalizeLocale("en_US")).toBe("en");
    expect(normalizeLocale("EL")).toBe("el");
    expect(normalizeLocale("  el-GR  ")).toBe("el");
  });

  it("rejects a language we have no catalog for", () => {
    // `fr` is a legitimate institutions.default_language — 38 of the 39 entries
    // in LANGUAGE_OPTIONS have no UI catalog, and must not be selected.
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("fr-FR")).toBeNull();
    expect(normalizeLocale("zh")).toBeNull();
  });

  it("rejects empty and junk input", () => {
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale("not-a-language")).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("prefers an explicit stored choice over everything else", () => {
    expect(
      resolveLocale({
        stored: "en",
        institutionDefault: "el",
        browser: ["el-GR"],
      })
    ).toBe("en");
  });

  it("falls back to the institution default when nothing is stored", () => {
    expect(
      resolveLocale({ stored: null, institutionDefault: "el", browser: ["en-US"] })
    ).toBe("el");
  });

  it("skips an institution default we have no catalog for", () => {
    // A French institution gets the browser's language, not a crash and not
    // a half-translated French UI.
    expect(
      resolveLocale({ institutionDefault: "fr", browser: ["el-GR", "en-US"] })
    ).toBe("el");
  });

  it("falls back to the browser preference order", () => {
    expect(resolveLocale({ browser: ["de-DE", "el-GR", "en"] })).toBe("el");
  });

  it("falls back to en when no candidate is supported", () => {
    expect(
      resolveLocale({ stored: "fr", institutionDefault: "ja", browser: ["de", "it"] })
    ).toBe(FALLBACK_LOCALE);
  });

  it("falls back to en for completely empty input", () => {
    expect(resolveLocale({})).toBe("en");
  });
});

describe("stored locale round-trip", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads back what it wrote", () => {
    writeStoredLocale("el");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("el");
    expect(readStoredLocale()).toBe("el");
  });

  it("returns null when nothing was ever chosen", () => {
    expect(readStoredLocale()).toBeNull();
  });

  it("ignores a stale value for a locale we dropped", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    expect(readStoredLocale()).toBeNull();
  });

  it("survives storage being unavailable", () => {
    // Safari private mode throws from getItem/setItem rather than returning null.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(readStoredLocale()).toBeNull();
    expect(() => writeStoredLocale("el")).not.toThrow();
  });
});
