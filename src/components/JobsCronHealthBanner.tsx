import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

// Surfaces the state of the pg_cron driver that powers background jobs
// (issue #780, on top of #762). When the driver is dead — Vault secrets
// are missing or the cron extension hasn't ticked in a while — the
// `JobsPage` would otherwise look identical to a healthy queue with
// nothing pending. This banner makes the silent no-op visible.
//
// The banner is intentionally hidden in the healthy case. It only renders
// when a real misconfiguration would stall jobs; otherwise the JobsPage
// header stays clean.

interface JobsCronHealth {
  secrets_seeded: boolean;
  last_tick_at: string | null;
  last_tick_status: string | null;
  // HTTP status of the most recent tick whose POST to run-jobs has a
  // delivered pg_net response. Distinguishes "cron never fired" (null) from
  // "cron fires but run-jobs rejects it" (e.g. 401 on a stale key).
  last_tick_http_status: number | null;
  last_success_at: string | null;
  minutes_since_success: number | null;
  is_healthy: boolean;
}

// Re-check every minute. Cron itself ticks every minute, so this cadence
// is the natural refresh rate — a banner that lingers after the operator
// seeds the vault would teach users to ignore it.
const REFETCH_INTERVAL_MS = 60_000;

function describe(health: JobsCronHealth): { title: string; body: string } {
  if (!health.secrets_seeded) {
    return {
      title: "Background-job driver not configured",
      body:
        "The pg_cron worker can't find the `project_url` Vault secret it needs to reach run-jobs. " +
        "Jobs you enqueue will not run automatically until an operator seeds it.",
    };
  }
  // Cron is firing (a tick POST got a response) but run-jobs is not returning
  // 2xx. run-jobs is unauthenticated, so this is no longer an auth/key issue —
  // it means run-jobs itself errored (crash, OOM, timeout, bad deploy). Point
  // the operator at the Edge Function logs.
  if (
    health.last_tick_http_status !== null &&
    (health.last_tick_http_status < 200 || health.last_tick_http_status >= 300)
  ) {
    return {
      title: "Background-job driver is erroring",
      body:
        `The pg_cron tick is firing but run-jobs returned HTTP ${health.last_tick_http_status}. ` +
        "Check the run-jobs Edge Function logs for details. " +
        "Jobs will not run automatically until it is fixed.",
    };
  }
  if (health.last_success_at === null) {
    return {
      title: "Background-job driver hasn't ticked yet",
      body:
        "No successful run-jobs-tick has been recorded yet. If this persists, the cron extension may be disabled.",
    };
  }
  const minutes = Math.round(health.minutes_since_success ?? 0);
  return {
    title: "Background-job driver appears stalled",
    body:
      `The pg_cron heartbeat hasn't successfully ticked in about ${minutes} minute${minutes === 1 ? "" : "s"}. ` +
      "Jobs may be stuck until cron resumes.",
  };
}

export function JobsCronHealthBanner() {
  const [health, setHealth] = useState<JobsCronHealth | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchHealth = async () => {
      const { data, error } = await supabase.rpc("get_jobs_cron_health");
      if (cancelled) return;
      if (error || !data) {
        // RPC unavailable (e.g. dev environment without the migration).
        // Hide the banner rather than alarm the user — failing closed
        // here would only add noise.
        setHealth(null);
        return;
      }
      setHealth(data as unknown as JobsCronHealth);
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, REFETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!health || health.is_healthy) return null;

  const { title, body } = describe(health);

  return (
    <Alert
      variant="destructive"
      className="mb-4"
      data-testid="jobs-cron-health-banner"
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}
