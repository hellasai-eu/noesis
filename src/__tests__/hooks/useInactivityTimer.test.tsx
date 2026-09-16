import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useInactivityTimer } from "@/hooks/useInactivityTimer";

const TIMEOUT_MS = 60 * 60 * 1000;
const ACTIVITY_STORAGE_KEY = "noesis:lastActivity";

describe("useInactivityTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls onTimeout after the configured idle period", () => {
    const onTimeout = vi.fn();
    renderHook(() =>
      useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: true, onTimeout }),
    );

    expect(onTimeout).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS - 1);
    });
    expect(onTimeout).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it.each(["mousemove", "keydown", "touchstart", "click"])(
    "resets the timer on %s",
    (eventName) => {
      const onTimeout = vi.fn();
      renderHook(() =>
        useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: true, onTimeout }),
      );

      act(() => {
        vi.advanceTimersByTime(TIMEOUT_MS - 1000);
      });

      act(() => {
        window.dispatchEvent(new Event(eventName));
      });

      act(() => {
        vi.advanceTimersByTime(TIMEOUT_MS - 1);
      });
      expect(onTimeout).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onTimeout).toHaveBeenCalledTimes(1);
    },
  );

  it("resets the timer when another tab broadcasts activity via storage", () => {
    const onTimeout = vi.fn();
    renderHook(() =>
      useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: true, onTimeout }),
    );

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS - 1000);
    });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ACTIVITY_STORAGE_KEY,
          newValue: String(Date.now()),
        }),
      );
    });

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS - 1);
    });
    expect(onTimeout).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("ignores storage events for unrelated keys", () => {
    const onTimeout = vi.fn();
    renderHook(() =>
      useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: true, onTimeout }),
    );

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS - 1000);
    });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "some-other-key",
          newValue: "x",
        }),
      );
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not register listeners or fire when disabled", () => {
    const onTimeout = vi.fn();
    const addSpy = vi.spyOn(window, "addEventListener");

    renderHook(() =>
      useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: false, onTimeout }),
    );

    expect(
      addSpy.mock.calls.filter(([type]) =>
        ["mousemove", "keydown", "touchstart", "click", "storage"].includes(
          String(type),
        ),
      ),
    ).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS * 2);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("cleans up listeners and pending timeout on unmount", () => {
    const onTimeout = vi.fn();
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() =>
      useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: true, onTimeout }),
    );

    unmount();

    const removedTypes = removeSpy.mock.calls.map(([type]) => String(type));
    expect(removedTypes).toEqual(
      expect.arrayContaining([
        "mousemove",
        "keydown",
        "touchstart",
        "click",
        "storage",
      ]),
    );

    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS * 2);
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("broadcasts activity to localStorage but throttles repeated writes", () => {
    const onTimeout = vi.fn();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    renderHook(() =>
      useInactivityTimer({ timeoutMs: TIMEOUT_MS, enabled: true, onTimeout }),
    );

    act(() => {
      window.dispatchEvent(new Event("keydown"));
      window.dispatchEvent(new Event("mousemove"));
      window.dispatchEvent(new Event("click"));
    });

    const writes = setItemSpy.mock.calls.filter(
      ([key]) => key === ACTIVITY_STORAGE_KEY,
    );
    expect(writes).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(2000);
      window.dispatchEvent(new Event("keydown"));
    });

    const writesAfterDelay = setItemSpy.mock.calls.filter(
      ([key]) => key === ACTIVITY_STORAGE_KEY,
    );
    expect(writesAfterDelay).toHaveLength(2);
  });
});
