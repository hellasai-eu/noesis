import { isIsoInstant, type MfaPolicyRow } from "@/deployment/settings";

/**
 * Comparing the declared MFA policy with the live one.
 *
 * Pure, and separate from the panel that renders it, so it can be tested
 * without mounting a component or standing up a Supabase client — the
 * convention the newer surfaces in this repository follow.
 *
 * The obligation these helpers carry is worth stating, because it is easy to
 * lose to a convenience: **never describe the live policy more favourably
 * than Postgres will act on it.** `mfa_role_enforced_now` reads a date
 * Postgres cannot cast as "enforce now", while `new Date` happily rolls
 * `2026-02-30` forward to March 2nd. Built on `new Date`, this panel would
 * announce a future deadline for a role that is already gated — on the exact
 * screen an operator opened to find out why.
 */

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admins",
  admin: "Institution admins",
  instructor: "Instructors",
  evaluator: "Evaluators",
  student: "Students",
};

export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

/**
 * "immediately", or the date enforcement begins, or a plain statement that
 * the stored value is not a date the database will accept.
 */
export function whenLabel(value: string | null): string {
  if (value === null) return "immediately";
  if (!isIsoInstant(value)) {
    return `invalid date (${value}) — enforced immediately`;
  }
  // The stored value is a UTC instant; format its UTC date so a reader west
  // of UTC is not shown the previous day.
  return `from ${new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })}`;
}

/**
 * Both null, or both naming the same instant — so "Z" and "+00:00" agree.
 *
 * A value Postgres would reject never agrees with one it would accept, even
 * when `Date.parse` maps them to the same moment. `2026-02-30` parses to the
 * same instant as `2026-03-02`, but the database rejects the first and
 * enforces the role immediately; reporting that as agreement would hide the
 * one row the operator needs to fix.
 */
export function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (!isIsoInstant(a) || !isIsoInstant(b)) return a === b;
  return Date.parse(a) === Date.parse(b);
}

export interface PolicyDiffRow {
  role: string;
  inDeclared: boolean;
  inLive: boolean;
  declaredWhen: string | null;
  liveWhen: string | null;
  agrees: boolean;
}

/**
 * Compares the two policies role by role.
 *
 * Deliberately not a deep-equal on the objects: an operator needs to know
 * *which* role disagrees, and the two are written by different tools (one
 * sorts its keys, the other is whatever Postgres returns), so object identity
 * would report false differences.
 */
export function diffPolicies(
  declared: MfaPolicyRow,
  live: MfaPolicyRow,
): PolicyDiffRow[] {
  const roles = [...new Set([...Object.keys(declared), ...Object.keys(live)])].sort();
  return roles.map((role) => {
    const inDeclared = role in declared;
    const inLive = role in live;
    const declaredWhen = declared[role] ?? null;
    const liveWhen = live[role] ?? null;
    return {
      role,
      inDeclared,
      inLive,
      declaredWhen,
      liveWhen,
      agrees: inDeclared && inLive && sameInstant(declaredWhen, liveWhen),
    };
  });
}
