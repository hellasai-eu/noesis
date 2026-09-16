/**
 * Minimal error reporter for edge functions, speaking the Sentry envelope
 * protocol — which both Sentry and self-hosted GlitchTip accept, so the
 * vendor stays an operator decision (`supabase secrets set SENTRY_DSN=…`).
 * Unset DSN (the default) means every call is a no-op.
 *
 * Hand-rolled instead of an SDK on purpose: the payload is then, by
 * construction, only what this file assembles — error name, message, stack,
 * function name, trace id, HTTP status. No request bodies, no headers, no
 * user identifiers, no breadcrumbs. That bound is what the compliance pack's
 * "error tracking" claim rests on; widen it only together with the operator's
 * private security-testing record.
 *
 * Reporting must never break the response path: every failure mode ends in a
 * swallowed rejection, and the network call rides EdgeRuntime.waitUntil when
 * available so it survives the response without delaying it.
 */

export interface DsnTarget {
  envelopeUrl: string;
  publicKey: string;
}

/**
 * A DSN is `https://<key>@<host>/<path?>/<projectId>`. HTTPS only: the
 * envelope carries stack traces and the auth key, neither of which may
 * cross the wire in cleartext, so an `http://` DSN disables reporting
 * rather than downgrading it.
 */
export function parseDsn(dsn: string): DsnTarget | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (
    url.protocol !== "https:" ||
    !url.username ||
    !projectId ||
    !/^\d+$/.test(projectId)
  ) return null;
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return {
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: url.username,
  };
}

const MAX_VALUE_LENGTH = 500;
const MAX_STACK_LENGTH = 4000;

export interface ReportContext {
  functionName: string;
  traceId?: string;
  status?: number;
}

/** Build the Sentry event JSON for one error. Pure, for testability. */
export function buildEvent(
  error: { name?: string; message?: string; stack?: string },
  context: ReportContext,
): Record<string, unknown> {
  const tags: Record<string, string> = { function: context.functionName };
  if (context.traceId) tags.trace_id = context.traceId;
  if (context.status !== undefined) tags.status = String(context.status);
  return {
    event_id: crypto.randomUUID().replaceAll("-", ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    logger: context.functionName,
    environment: Deno.env.get("SENTRY_ENVIRONMENT") ?? "production",
    exception: {
      values: [{
        type: error.name || "Error",
        value: (error.message || "unknown error").slice(0, MAX_VALUE_LENGTH),
      }],
    },
    extra: error.stack ? { stack: error.stack.slice(0, MAX_STACK_LENGTH) } : {},
    tags,
  };
}

/** Serialize an event into a Sentry envelope (header line, item header, item). */
export function buildEnvelope(event: Record<string, unknown>): string {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
  });
  return `${header}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
}

function deliver(target: DsnTarget, envelope: string): Promise<unknown> {
  return fetch(target.envelopeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth":
        `Sentry sentry_version=7, sentry_client=noesis-edge/1.0, sentry_key=${target.publicKey}`,
    },
    body: envelope,
    signal: AbortSignal.timeout(3000),
  });
}

/**
 * Report one exception (or handler-built 5xx) upstream. No-op without a DSN;
 * never throws; never blocks the caller.
 */
export function reportException(
  error: unknown,
  context: ReportContext,
): void {
  try {
    const dsn = Deno.env.get("SENTRY_DSN");
    if (!dsn) return;
    const target = parseDsn(dsn);
    if (!target) return;

    const err = error instanceof Error
      ? error
      : { name: "Error", message: String(error), stack: undefined };
    const pending = deliver(target, buildEnvelope(buildEvent(err, context)))
      .catch(() => {});

    const edgeRuntime =
      (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } })
        .EdgeRuntime;
    edgeRuntime?.waitUntil?.(pending);
  } catch {
    // Reporting is best-effort by contract.
  }
}
