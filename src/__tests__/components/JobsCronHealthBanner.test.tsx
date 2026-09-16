/**
 * #873 — JobsCronHealthBanner surfaces the pg_cron driver state. Covers the
 * four `describe()` branches (not-seeded / erroring / never-ticked / stalled),
 * plus the two hidden cases (healthy, RPC unavailable). The banner is fed by
 * the `get_jobs_cron_health` RPC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: rpcMock },
}));

import { JobsCronHealthBanner } from "@/components/JobsCronHealthBanner";

interface JobsCronHealth {
  secrets_seeded: boolean;
  last_tick_at: string | null;
  last_tick_status: string | null;
  last_tick_http_status: number | null;
  last_success_at: string | null;
  minutes_since_success: number | null;
  is_healthy: boolean;
}

const healthy: JobsCronHealth = {
  secrets_seeded: true,
  last_tick_at: "2026-07-17T10:00:00Z",
  last_tick_status: "ok",
  last_tick_http_status: 200,
  last_success_at: "2026-07-17T10:00:00Z",
  minutes_since_success: 0,
  is_healthy: true,
};

function mockHealth(overrides: Partial<JobsCronHealth>) {
  rpcMock.mockResolvedValue({
    data: { ...healthy, ...overrides },
    error: null,
  });
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe("JobsCronHealthBanner (#873)", () => {
  it("renders the not-configured branch when secrets are not seeded", async () => {
    mockHealth({ secrets_seeded: false, is_healthy: false });
    render(<JobsCronHealthBanner />);

    await waitFor(() => {
      expect(
        screen.getByText("Background-job driver not configured"),
      ).toBeInTheDocument();
    });
    expect(rpcMock).toHaveBeenCalledWith("get_jobs_cron_health");
    expect(screen.getByText(/project_url` Vault secret/)).toBeInTheDocument();
  });

  it("renders the erroring branch when run-jobs returns a non-2xx status", async () => {
    mockHealth({
      last_tick_http_status: 401,
      is_healthy: false,
    });
    render(<JobsCronHealthBanner />);

    await waitFor(() => {
      expect(
        screen.getByText("Background-job driver is erroring"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/returned HTTP 401/)).toBeInTheDocument();
  });

  it("renders the never-ticked branch when there is no recorded success", async () => {
    mockHealth({
      last_tick_http_status: null,
      last_success_at: null,
      is_healthy: false,
    });
    render(<JobsCronHealthBanner />);

    await waitFor(() => {
      expect(
        screen.getByText("Background-job driver hasn't ticked yet"),
      ).toBeInTheDocument();
    });
  });

  it("renders the stalled branch with the minutes-since-success count", async () => {
    mockHealth({
      last_tick_http_status: 200,
      last_success_at: "2026-07-17T09:30:00Z",
      minutes_since_success: 12,
      is_healthy: false,
    });
    render(<JobsCronHealthBanner />);

    await waitFor(() => {
      expect(
        screen.getByText("Background-job driver appears stalled"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/about 12 minutes/)).toBeInTheDocument();
  });

  it("renders nothing when the driver is healthy", async () => {
    mockHealth({ is_healthy: true });
    const { container } = render(<JobsCronHealthBanner />);

    // Give the effect a chance to resolve, then confirm nothing rendered.
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId("jobs-cron-health-banner"),
    ).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the RPC is unavailable (error)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "missing" } });
    render(<JobsCronHealthBanner />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId("jobs-cron-health-banner"),
    ).not.toBeInTheDocument();
  });
});
