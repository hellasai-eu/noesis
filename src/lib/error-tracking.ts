/**
 * Minimal browser error reporter speaking the Sentry envelope protocol —
 * accepted by both Sentry and self-hosted GlitchTip, so the vendor is chosen
 * by setting `VITE_SENTRY_DSN` at build time (Vercel env var), not by code.
 * Without a DSN (the default) nothing initializes and nothing is sent.
 *
 * Hand-rolled instead of the Sentry SDK on purpose: the payload is, by
 * construction, only what this file assembles — error name, message, stack,
 * and the current route path with query and hash stripped. No user
 * identifiers, no cookies, no headers, no breadcrumbs, no session replay.
 * Most users are minors; that bound is load-bearing for the compliance
 * pack's "error tracking" claim and must only widen together with the
 * operator's private security-testing record.
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
    // Browser sends auth as query params (the SDK convention) — a custom
    // header would only add a CORS preflight to every report.
    envelopeUrl:
      `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/` +
      `?sentry_version=7&sentry_client=noesis-web%2F1.0&sentry_key=${url.username}`,
    publicKey: url.username,
  };
}

const MAX_VALUE_LENGTH = 500;
const MAX_STACK_LENGTH = 4000;
/** Cap per page load — an error loop must not become an outbound flood. */
const MAX_EVENTS_PER_LOAD = 10;

/** Build the Sentry event JSON for one error. Pure, for testability. */
export function buildEvent(
  error: { name?: string; message?: string; stack?: string },
  urlPath: string,
): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: import.meta.env.MODE,
    exception: {
      values: [{
        type: error.name || "Error",
        value: (error.message || "unknown error").slice(0, MAX_VALUE_LENGTH),
      }],
    },
    extra: error.stack ? { stack: error.stack.slice(0, MAX_STACK_LENGTH) } : {},
    // Path only — query strings and fragments can carry tokens (password
    // recovery, invitations) and never leave the page.
    tags: { url_path: urlPath },
  };
}

/** Serialize an event into a Sentry envelope (header, item header, item). */
export function buildEnvelope(event: Record<string, unknown>): string {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
  });
  return `${header}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
}

let sentCount = 0;
const seen = new Set<string>();

function report(target: DsnTarget, error: { name?: string; message?: string; stack?: string }): void {
  const dedupeKey = `${error.name}:${error.message}`;
  if (sentCount >= MAX_EVENTS_PER_LOAD || seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  sentCount += 1;

  const event = buildEvent(error, window.location.pathname);
  // keepalive lets a report from a closing tab still leave; failures are
  // irrelevant by contract — reporting must never affect the app.
  fetch(target.envelopeUrl, {
    method: "POST",
    body: buildEnvelope(event),
    keepalive: true,
  }).catch(() => {});
}

function toErrorShape(value: unknown): { name?: string; message?: string; stack?: string } {
  if (value instanceof Error) return value;
  return { name: "Error", message: String(value) };
}

/**
 * Install global handlers for uncaught errors and unhandled promise
 * rejections. Call once, before the first render. No-op without a DSN.
 */
export function initErrorTracking(
  dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN,
): void {
  if (!dsn) return;
  const target = parseDsn(dsn);
  if (!target) return;

  window.addEventListener("error", (event) => {
    report(target, event.error ? toErrorShape(event.error) : { message: event.message });
  });
  window.addEventListener("unhandledrejection", (event) => {
    report(target, toErrorShape(event.reason));
  });
}
