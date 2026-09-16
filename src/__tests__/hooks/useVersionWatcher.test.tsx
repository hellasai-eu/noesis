import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

import { useVersionWatcher } from "@/hooks/useVersionWatcher";
import { NEW_VERSION_EVENT, __resetChunkLoadRecoveryForTests } from "@/lib/chunkLoadRecovery";

function mockFetchVersion(version: string | null) {
  if (version === null) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    return;
  }
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ version }),
  }) as unknown as typeof fetch;
}

describe("useVersionWatcher", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("VITE_GIT_COMMIT", "running-hash");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    __resetChunkLoadRecoveryForTests();
  });

  it("stays hidden when deployed version matches running version", async () => {
    mockFetchVersion("running-hash");

    const { result } = renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });

    expect(result.current.updateAvailable).toBe(false);
  });

  it("flips to updateAvailable when deployed version differs", async () => {
    mockFetchVersion("new-hash");

    const { result } = renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect(result.current.updateAvailable).toBe(true);
    });
  });

  it("stays hidden when /version.json returns null (e.g. local dev)", async () => {
    mockFetchVersion(null);

    const { result } = renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });

    expect(result.current.updateAvailable).toBe(false);
  });

  it("stays hidden when running version is empty", async () => {
    vi.stubEnv("VITE_GIT_COMMIT", "");
    mockFetchVersion("new-hash");

    const { result } = renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });

    expect(result.current.updateAvailable).toBe(false);
  });

  it("flips to updateAvailable when chunk-load event fires", async () => {
    mockFetchVersion("running-hash");

    const { result } = renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });
    expect(result.current.updateAvailable).toBe(false);

    act(() => {
      window.dispatchEvent(new CustomEvent(NEW_VERSION_EVENT));
    });

    await waitFor(() => {
      expect(result.current.updateAvailable).toBe(true);
    });
  });

  it("throttles re-checks triggered by rapid focus events", async () => {
    mockFetchVersion("running-hash");
    const fetchMock = global.fetch as unknown as { mock: { calls: unknown[] } };

    renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    const callsAfterInitial = fetchMock.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock.mock.calls.length).toBe(callsAfterInitial);
  });

  it("cleans up listeners on unmount", async () => {
    mockFetchVersion("running-hash");
    const windowRemoveSpy = vi.spyOn(window, "removeEventListener");
    const documentRemoveSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = renderHook(() => useVersionWatcher());

    await waitFor(() => {
      expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });

    unmount();

    const windowRemovedTypes = windowRemoveSpy.mock.calls.map(([type]) => String(type));
    expect(windowRemovedTypes).toEqual(
      expect.arrayContaining(["focus", NEW_VERSION_EVENT]),
    );

    const documentRemovedTypes = documentRemoveSpy.mock.calls.map(([type]) => String(type));
    expect(documentRemovedTypes).toContain("visibilitychange");
  });
});
