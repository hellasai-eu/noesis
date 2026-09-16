import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  checkVersionAndNavigate,
  fetchDeployedVersion,
} from "@/lib/versionCheck";

describe("versionCheck", () => {
  const originalFetch = global.fetch;
  const originalAssign = window.location.assign;

  beforeEach(() => {
    window.location.assign = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.location.assign = originalAssign;
    vi.restoreAllMocks();
  });

  describe("fetchDeployedVersion", () => {
    it("cache-busts the request with a timestamp query param", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "abc123" }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await fetchDeployedVersion();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toMatch(/^\/version\.json\?t=\d+$/);
    });

    it("returns null on non-OK response", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch;

      expect(await fetchDeployedVersion()).toBeNull();
    });

    it("returns null when fetch rejects", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValue(new Error("network")) as unknown as typeof fetch;

      expect(await fetchDeployedVersion()).toBeNull();
    });
  });

  describe("checkVersionAndNavigate", () => {
    it("hard-reloads when the deployed version differs from the running one", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "new-hash" }),
      }) as unknown as typeof fetch;
      const navigate = vi.fn();

      await checkVersionAndNavigate("/select-institution", navigate, "old-hash");

      expect(window.location.assign).toHaveBeenCalledWith("/select-institution");
      expect(navigate).not.toHaveBeenCalled();
    });

    it("uses the SPA router when versions match", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "same-hash" }),
      }) as unknown as typeof fetch;
      const navigate = vi.fn();

      await checkVersionAndNavigate("/select-institution", navigate, "same-hash");

      expect(navigate).toHaveBeenCalledWith("/select-institution");
      expect(window.location.assign).not.toHaveBeenCalled();
    });

    it("falls back to the SPA router when the version fetch fails", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValue(new Error("network")) as unknown as typeof fetch;
      const navigate = vi.fn();

      await checkVersionAndNavigate("/select-institution", navigate, "old-hash");

      expect(navigate).toHaveBeenCalledWith("/select-institution");
      expect(window.location.assign).not.toHaveBeenCalled();
    });

    it("falls back to the SPA router when the running version is empty", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: "any-hash" }),
      }) as unknown as typeof fetch;
      const navigate = vi.fn();

      await checkVersionAndNavigate("/select-institution", navigate, "");

      expect(navigate).toHaveBeenCalledWith("/select-institution");
      expect(window.location.assign).not.toHaveBeenCalled();
    });
  });
});
