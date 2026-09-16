import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  clearSelectedInstitutionId,
  getSelectedInstitutionId,
  setSelectedInstitutionId,
  subscribeSelectedInstitution,
} from "@/lib/selected-institution";

describe("selected-institution store", () => {
  const unsubscribes: Array<() => void> = [];

  /** Subscribe and register teardown — the listener set is module-level. */
  function subscribe(listener: () => void) {
    unsubscribes.push(subscribeSelectedInstitution(listener));
  }

  beforeEach(() => {
    clearSelectedInstitutionId();
  });

  afterEach(() => {
    unsubscribes.splice(0).forEach((fn) => fn());
    vi.restoreAllMocks();
  });

  it("round-trips through sessionStorage", () => {
    setSelectedInstitutionId("inst-1");
    expect(getSelectedInstitutionId()).toBe("inst-1");
    expect(sessionStorage.getItem("selectedInstitutionId")).toBe("inst-1");
  });

  it("returns null once cleared", () => {
    setSelectedInstitutionId("inst-1");
    clearSelectedInstitutionId();
    expect(getSelectedInstitutionId()).toBeNull();
  });

  it("notifies subscribers on set and on clear", () => {
    const listener = vi.fn();
    subscribe(listener);

    setSelectedInstitutionId("inst-1");
    expect(listener).toHaveBeenCalledTimes(1);

    clearSelectedInstitutionId();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSelectedInstitution(listener);
    unsubscribe();

    setSelectedInstitutionId("inst-2");
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not announce a switch that storage rejected", () => {
    // Deliberate degradation, not an oversight. An earlier revision held the
    // rejected write in memory so the locale would still follow the switch, and
    // review found three defects flowing from it — ending in LocaleProvider
    // reading the new institution from memory while the ~8 direct
    // `sessionStorage` readers still read the old one.
    //
    // Spied on the `window.sessionStorage` object rather than `Storage.prototype`
    // — vitest.setup.ts replaces sessionStorage with a plain mock object, so a
    // prototype spy would never be consulted and this test would pass vacuously.
    setSelectedInstitutionId("inst-old");

    const listener = vi.fn();
    subscribe(listener);
    // Restored explicitly rather than via `vi.restoreAllMocks()`: sessionStorage
    // here is a plain mock object, and leaving this installed makes every later
    // test in the file throw SecurityError.
    const setItem = vi
      .spyOn(window.sessionStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    try {
      expect(() => setSelectedInstitutionId("inst-new")).not.toThrow();

      // Everything agrees the switch did not happen: this module, and every
      // page reading the key directly.
      expect(getSelectedInstitutionId()).toBe("inst-old");
      expect(sessionStorage.getItem("selectedInstitutionId")).toBe("inst-old");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("agrees with code that writes the key directly", () => {
    // Several existing tests, and nothing else in the app, write the key
    // straight to sessionStorage. Storage is the only source of truth, so there
    // is no in-memory copy that could disagree with them.
    setSelectedInstitutionId("inst-from-module");
    sessionStorage.setItem("selectedInstitutionId", "inst-written-directly");

    expect(getSelectedInstitutionId()).toBe("inst-written-directly");
  });
});
