import type { MfaPolicyRow } from "@/deployment/settings";

/**
 * Comparing the declared MFA policy with the live one.
 *
 * Pure, and separate from the panel that renders it, so it can be tested
 * without mounting a component or standing up a Supabase client — the
 * convention the newer surfaces in this repository follow.
 *
 * ## Why nothing here parses a live date
 *
 * The obligation this panel carries is to never describe the live policy
 * differently from how Postgres will act on it. Deciding that in JavaScript
 * cannot be done, and both ways of getting it wrong are equally misleading on
 * the one screen an operator opens when a role is unexpectedly locked out:
 *
 * - `new Date("2026-02-30T00:00:00Z")` rolls forward to March 2nd, while
 *   Postgres rejects the literal and enforces the role *immediately*. A
 *   lockout hidden behind a date months away.
 * - Postgres accepts far more than any ISO subset a frontend would check for
 *   — `2026-11-01 00:00:00+00` is a perfectly good `timestamptz`. Validating
 *   against a strict subset cries wolf about a deadline that is working.
 *
 * So `mfa_policy_effective()` returns the database's own interpretation —
 * whether the value is readable, the instant it normalises to, and whether
 * the role is enforced *right now* — and this module only formats it. The
 * declared side is different: the build already refuses anything that is not
 * canonical, so it is safe to format directly.
 */

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admins",
  admin: "Institution admins",
  instructor: "Instructors",
  evaluator: "Evaluators",
  student: "Students",
};

export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

/** One role's entry in `mfa_policy_effective()`. */
export interface LivePolicyEntry {
  /** The stored text, verbatim. `null` means "immediately". */
  raw: string | null;
  /** `raw` normalised to an ISO instant, or `null` when there is no date. */
  starts_at: string | null;
  /** `false` when Postgres cannot read `raw` as a timestamptz. */
  valid: boolean;
  /** What the database says about enforcement at this moment. */
  enforced_now: boolean;
}

export type LivePolicy = Record<string, LivePolicyEntry>;

/** A UTC date, so a reader west of UTC is not shown the previous day. */
function formatUtcDate(instant: string): string {
  return new Date(instant).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * How the database will treat this role, in words.
 *
 * Driven by `enforced_now` and `valid` rather than by re-reading the date,
 * so the label cannot disagree with the enforcement.
 */
export function liveLabel(entry: LivePolicyEntry): string {
  if (!entry.valid) {
    // Postgres could not read it, and `mfa_role_enforced_now` reads an
    // unreadable value as "enforce". Say both parts.
    return `unreadable date (${entry.raw}) — enforced immediately`;
  }
  if (entry.starts_at === null) return "immediately";
  if (entry.enforced_now) return `since ${formatUtcDate(entry.starts_at)}`;
  return `from ${formatUtcDate(entry.starts_at)}`;
}

/**
 * The declared side, which the build has already validated as a canonical ISO
 * instant — so this one may format directly.
 */
export function declaredLabel(value: string | null): string {
  if (value === null) return "immediately";
  return `from ${formatUtcDate(value)}`;
}

/**
 * The same instant to the second.
 *
 * Not to the millisecond, because the two sides cannot agree at that
 * precision: `validateSettings` permits a fractional-second deadline, and
 * `mfa_policy_effective` normalises its report with `to_char` to whole
 * seconds. Comparing exactly would report a deadline as drifting from itself.
 *
 * Rounding here rather than widening the SQL format keeps `mfa_user_deadline`
 * — whose value the enrolment nudge shows to every user — spelled the way an
 * operator wrote it. And sub-second precision in a date that decides when a
 * thousand pupils lose access is not a distinction worth preserving.
 */
function sameSecond(a: string, b: string): boolean {
  return Math.floor(Date.parse(a) / 1000) === Math.floor(Date.parse(b) / 1000);
}

export interface PolicyDiffRow {
  role: string;
  inDeclared: boolean;
  inLive: boolean;
  declaredWhen: string | null;
  live: LivePolicyEntry | null;
  agrees: boolean;
}

/**
 * Compares the two policies role by role.
 *
 * Deliberately not a deep-equal on the objects: an operator needs to know
 * *which* role disagrees, and the two are written by different tools, so
 * object identity would report false differences.
 *
 * Agreement compares the declared instant with the database's *normalised*
 * one, which is what makes `2026-11-01T00:00:00Z` and
 * `2026-11-01 00:00:00+00` agree — the same moment, differently spelled, and
 * not drift. A value Postgres cannot read never agrees with one it can.
 */
export function diffPolicies(declared: MfaPolicyRow, live: LivePolicy): PolicyDiffRow[] {
  const roles = [...new Set([...Object.keys(declared), ...Object.keys(live)])].sort();
  return roles.map((role) => {
    const inDeclared = role in declared;
    const inLive = role in live;
    const declaredWhen = declared[role] ?? null;
    const liveEntry = live[role] ?? null;

    let agrees = false;
    if (inDeclared && inLive && liveEntry) {
      if (!liveEntry.valid) {
        agrees = false;
      } else if (declaredWhen === null || liveEntry.starts_at === null) {
        agrees = declaredWhen === null && liveEntry.starts_at === null;
      } else {
        agrees = sameSecond(declaredWhen, liveEntry.starts_at);
      }
    }

    return { role, inDeclared, inLive, declaredWhen, live: liveEntry, agrees };
  });
}
