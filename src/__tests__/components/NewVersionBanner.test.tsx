import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { NewVersionBanner } from "@/components/NewVersionBanner";

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

describe("NewVersionBanner", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("VITE_GIT_COMMIT", "running-hash");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("renders nothing when versions match", async () => {
    mockFetchVersion("running-hash");

    render(<NewVersionBanner />);

    await waitFor(() => {
      expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("new-version-banner")).toBeNull();
  });

  it("renders the banner when versions differ", async () => {
    mockFetchVersion("new-hash");

    render(<NewVersionBanner />);

    const banner = await screen.findByTestId("new-version-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });

  it("calls window.location.reload when Refresh is clicked", async () => {
    mockFetchVersion("new-hash");
    const reloadMock = window.location.reload as unknown as ReturnType<typeof vi.fn>;
    reloadMock.mockClear();

    render(<NewVersionBanner />);

    const refreshButton = await screen.findByRole("button", { name: /refresh/i });
    fireEvent.click(refreshButton);

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
