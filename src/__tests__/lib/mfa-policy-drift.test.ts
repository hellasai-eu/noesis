import { describe, it, expect } from "vitest";

import { diffPolicies, sameInstant, whenLabel } from "@/lib/mfa-policy-drift";

/**
 * The pure comparison behind the super-admin drift panel
 * (`src/lib/mfa-policy-drift.ts`).
 *
 * This panel is the screen an operator opens when a role is unexpectedly
 * locked out, so it has one obligation above being pretty: never describe the
 * live policy more favourably than Postgres will act on it.
 *
 * That is not hypothetical. `mfa_role_enforced_now` reads a date Postgres
 * cannot cast as "enforce now", while `new Date("2026-02-30T00:00:00Z")`
 * happily rolls forward to March 2nd. A panel built on `new Date` would
 * announce a future deadline for a role that is already gated — on the exact
 * screen opened to explain why.
 */

describe("whenLabel", () => {
  it("says immediately when there is no date", () => {
    expect(whenLabel(null)).toBe("immediately");
  });

  it("formats a real date in UTC, not the reader's zone", () => {
    // Formatted as a UTC date so a reader west of UTC is not shown the
    // previous day and told enforcement starts then.
    expect(whenLabel("2026-11-01T00:00:00Z")).toContain("2026");
    expect(whenLabel("2026-11-01T00:00:00Z")).toMatch(/^from /);
  });

  it("calls an impossible date what it is, and says what happens", () => {
    // The case that matters. Postgres rejects the literal and the role is
    // enforced now; the panel must not say "from 2 March".
    const label = whenLabel("2026-02-30T00:00:00Z");
    expect(label).toContain("invalid date");
    expect(label).toContain("enforced immediately");
    expect(label).not.toContain("March");
  });

  it("rejects a bare date, which the database and the browser read differently", () => {
    expect(whenLabel("2026-11-01")).toContain("invalid date");
  });
});

describe("sameInstant", () => {
  it("treats the same moment written two ways as agreement", () => {
    expect(sameInstant("2026-11-01T00:00:00Z", "2026-11-01T00:00:00+00:00")).toBe(true);
    expect(sameInstant("2026-11-01T02:00:00+02:00", "2026-11-01T00:00:00Z")).toBe(true);
  });

  it("treats two nulls as agreement and a null against a date as drift", () => {
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant(null, "2026-11-01T00:00:00Z")).toBe(false);
  });

  it("never lets a date Postgres rejects agree with one it accepts", () => {
    // Both parse to the same instant in JavaScript. The database rejects the
    // first and enforces the role at once, so calling this agreement would
    // hide the single row the operator has to fix.
    expect(Date.parse("2026-02-30T00:00:00Z")).toBe(Date.parse("2026-03-02T00:00:00Z"));
    expect(sameInstant("2026-03-02T00:00:00Z", "2026-02-30T00:00:00Z")).toBe(false);
  });

  it("still reports an identical invalid value on both sides as agreement", () => {
    // Nothing to fix by changing one side: they are the same string, and the
    // declared side cannot hold this anyway because the build rejects it.
    expect(sameInstant("2026-02-30T00:00:00Z", "2026-02-30T00:00:00Z")).toBe(true);
  });
});

describe("diffPolicies", () => {
  it("agrees when both sides say the same thing", () => {
    const rows = diffPolicies(
      { super_admin: null, admin: "2026-11-01T00:00:00Z" },
      { admin: "2026-11-01T00:00:00Z", super_admin: null },
    );
    // Key order differs between the two sources — one sorts, the other is
    // whatever Postgres returns — and must not read as drift.
    expect(rows.every((r) => r.agrees)).toBe(true);
    expect(rows.map((r) => r.role)).toEqual(["admin", "super_admin"]);
  });

  it("reports a role the database enforces but the build does not declare", () => {
    // The dangerous direction: people are being gated by something this
    // build knows nothing about, so the app will not even nudge them.
    const rows = diffPolicies({ super_admin: null }, { super_admin: null, instructor: null });
    const instructor = rows.find((r) => r.role === "instructor")!;
    expect(instructor.agrees).toBe(false);
    expect(instructor.inLive).toBe(true);
    expect(instructor.inDeclared).toBe(false);
  });

  it("reports a role the build declares but the database does not enforce", () => {
    // The other direction: the apply step was skipped, so the mandate is
    // announced and not enforced.
    const rows = diffPolicies({ instructor: null }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].agrees).toBe(false);
    expect(rows[0].inDeclared).toBe(true);
    expect(rows[0].inLive).toBe(false);
  });

  it("reports a role whose dates disagree", () => {
    const rows = diffPolicies(
      { admin: "2026-11-01T00:00:00Z" },
      { admin: "2027-01-01T00:00:00Z" },
    );
    expect(rows[0].agrees).toBe(false);
    expect(rows[0].declaredWhen).toBe("2026-11-01T00:00:00Z");
    expect(rows[0].liveWhen).toBe("2027-01-01T00:00:00Z");
  });

  it("returns nothing at all when neither side enforces anyone", () => {
    expect(diffPolicies({}, {})).toEqual([]);
  });
});
