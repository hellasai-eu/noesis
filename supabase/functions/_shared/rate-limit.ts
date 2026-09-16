/**
 * Per-caller request budget, in memory (#1137).
 *
 * Authentication stops the internet from spending the platform's money.
 * It does not stop one signed-in student from spending it, and
 * `generate-study-image` is the expensive one per call — so it gets a ceiling
 * as well as a gate.
 *
 * Known limit, stated rather than implied: this is per-isolate. Edge functions
 * scale horizontally, so a caller spread across N isolates gets up to N times
 * the budget. That is the same trade `send-contact-form` and
 * `record-login-attempt` already make, and it still turns "unbounded" into
 * "bounded by however many isolates you can get routed to". A durable limit
 * needs a table and is a larger change than this issue.
 *
 * Those two handlers each carry their own copy of this logic and are
 * deliberately not migrated here: `record-login-attempt`'s differs materially
 * (it adds a global window and evicts tracked IPs under pressure), so folding
 * all three into one abstraction is its own change, not a rider on a security
 * fix.
 */

interface Window {
  count: number;
  resetTime: number;
}

const windows = new Map<string, Window>();

/** Bound the map so a burst of distinct callers cannot grow it without limit. */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Records a request against `key` and reports whether it should be refused.
 *
 * Counts the request it is asked about, so a caller at the limit is refused on
 * the call that would have exceeded it rather than the one after.
 */
export function isRateLimited(key: string, opts: RateLimitOptions): boolean {
  const now = Date.now();
  const entry = windows.get(key);

  if (!entry || now > entry.resetTime) {
    if (windows.size >= MAX_TRACKED_KEYS) evictExpired(now);
    windows.set(key, { count: 1, resetTime: now + opts.windowMs });
    return false;
  }

  if (entry.count >= opts.max) return true;

  entry.count++;
  return false;
}

function evictExpired(now: number): void {
  for (const [key, entry] of windows) {
    if (now > entry.resetTime) windows.delete(key);
  }
}

/** Exported for testing — resets state between cases. */
export function resetRateLimits(): void {
  windows.clear();
}
