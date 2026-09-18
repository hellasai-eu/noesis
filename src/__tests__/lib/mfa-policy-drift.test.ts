import { describe, it, expect } from "vitest";

import {
  declaredLabel,
  diffPolicies,
  liveLabel,
  type LivePolicyEntry,
} from "@/lib/mfa-policy-drift";

/**
 * The pure comparison behind the super-admin drift panel
 * (`src/lib/mfa-policy-drift.ts`).
 *
 * This panel is the screen an operator opens when a role is unexpectedly
 * locked out, so it has one obligation above being pretty: never describe the
 * live policy differently from how Postgres will act on it.
 *
 * That cannot be decided in JavaScript, and getting it wrong misleads in both
 * directions — `new Date` accepts `2026-02-30` (Postgres does not, and
 * enforces the role at once), while a strict ISO check rejects
 * `2026-11-01 00:00:00+00` (Postgres accepts it, and the deadline works). So
 * `mfa_policy_effective()` reports the database's own interpretation and these
 * helpers only format it. These tests encode that both failures stay fixed.
 */

const live = (over: Partial<LivePolicyEntry> = {}): LivePolicyEntry => ({
  raw: null,
  starts_at: null,
  valid: true,
  enforced_now: true,
  ...over,
});

describe("liveLabel", () => {
  it("says immediately when the database holds no date", () => {
    expect(liveLabel(live())).toBe("immediately");
  });

  it("formats a future deadline in UTC, not the reader's zone", () => {
    const label = liveLabel(
      live({
        raw: "2099-01-01T00:00:00Z",
        starts_at: "2099-01-01T00:00:00Z",
        enforced_now: false,
      }),
    );
    expect(label).toMatch(/^from /);
    expect(label).toContain("2099");
  });

  it("says a passed deadline is already in force", () => {
    // `from` would read as "not yet" for a date the database is already
    // enforcing.
    const label = liveLabel(
      live({ raw: "2020-01-01T00:00:00Z", starts_at: "2020-01-01T00:00:00Z" }),
    );
    expect(label).toMatch(/^since /);
  });

  it("takes the database's word for a Postgres format a browser would reject", () => {
    // The over-correction this replaced: `2026-11-01 00:00:00+00` is a valid
    // timestamptz, so the deadline works, and labelling it invalid cried wolf
    // on the diagnosis screen. Nothing here re-validates `raw`.
    const label = liveLabel(
      live({
        raw: "2099-11-01 00:00:00+00",
        starts_at: "2099-11-01T00:00:00Z",
        valid: true,
        enforced_now: false,
      }),
    );
    expect(label).toBe(`from ${new Date("2099-11-01T00:00:00Z").toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    })}`);
    expect(label).not.toContain("unreadable");
  });

  it("reports a value Postgres cannot read, and what happens because of it", () => {
    // The original bug: Postgres rejects the literal, mfa_role_enforced_now
    // reads the rejection as "enforce", and the panel must not show a date
    // months away. It shows the value back so the operator can fix the row.
    const label = liveLabel(
      live({ raw: "2026-02-30T00:00:00Z", starts_at: null, valid: false }),
    );
    expect(label).toContain("unreadable date");
    expect(label).toContain("2026-02-30T00:00:00Z");
    expect(label).toContain("enforced immediately");
    expect(label).not.toContain("March");
  });
});

describe("declaredLabel", () => {
  it("says immediately for no date, and formats one the build validated", () => {
    expect(declaredLabel(null)).toBe("immediately");
    expect(declaredLabel("2026-11-01T00:00:00Z")).toMatch(/^from .*2026/);
  });
});

describe("diffPolicies", () => {
  it("agrees when both sides say the same thing", () => {
    const rows = diffPolicies(
      { super_admin: null, admin: "2026-11-01T00:00:00Z" },
      {
        admin: live({
          raw: "2026-11-01T00:00:00Z",
          starts_at: "2026-11-01T00:00:00Z",
          enforced_now: false,
        }),
        super_admin: live(),
      },
    );
    // Key order differs between the two sources and must not read as drift.
    expect(rows.every((r) => r.agrees)).toBe(true);
    expect(rows.map((r) => r.role)).toEqual(["admin", "super_admin"]);
  });

  it("agrees across two spellings of the same instant", () => {
    // The declared side is canonical ISO; an operator may have written the
    // row by hand in Postgres's own format. Same moment, not drift.
    const rows = diffPolicies(
      { admin: "2026-11-01T00:00:00Z" },
      {
        admin: live({
          raw: "2026-11-01 00:00:00+00",
          starts_at: "2026-11-01T00:00:00Z",
          enforced_now: false,
        }),
      },
    );
    expect(rows[0].agrees).toBe(true);
  });

  it("does not report a fractional-second deadline as drifting from itself", () => {
    // `validateSettings` permits fractional seconds, and
    // `mfa_policy_effective` reports through `to_char` at whole-second
    // precision — so an exact comparison flagged a correctly-applied deadline
    // as drift, on the panel whose entire job is to show real drift.
    const rows = diffPolicies(
      { admin: "2026-11-01T00:00:00.500Z" },
      {
        admin: live({
          raw: "2026-11-01T00:00:00.5+00",
          starts_at: "2026-11-01T00:00:00Z",
          enforced_now: false,
        }),
      },
    );
    expect(rows[0].agrees).toBe(true);
  });

  it("still reports a genuine difference of seconds", () => {
    // The rounding must not swallow a real disagreement.
    const rows = diffPolicies(
      { admin: "2026-11-01T00:00:00Z" },
      {
        admin: live({
          raw: "2026-11-01T00:00:01Z",
          starts_at: "2026-11-01T00:00:01Z",
          enforced_now: false,
        }),
      },
    );
    expect(rows[0].agrees).toBe(false);
  });

  it("never lets an unreadable live value agree with a declared one", () => {
    // The database is enforcing this role now; calling it agreement would
    // hide the one row that needs fixing.
    const rows = diffPolicies(
      { admin: "2026-03-02T00:00:00Z" },
      { admin: live({ raw: "2026-02-30T00:00:00Z", starts_at: null, valid: false }) },
    );
    expect(rows[0].agrees).toBe(false);
  });

  it("reports a role the database enforces but the build does not declare", () => {
    // The dangerous direction: people are gated by something this build knows
    // nothing about, so the app will not even nudge them.
    const rows = diffPolicies({ super_admin: null }, { super_admin: live(), instructor: live() });
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
    expect(rows[0].live).toBeNull();
  });

  it("reports a role whose dates disagree", () => {
    const rows = diffPolicies(
      { admin: "2026-11-01T00:00:00Z" },
      {
        admin: live({
          raw: "2027-01-01T00:00:00Z",
          starts_at: "2027-01-01T00:00:00Z",
          enforced_now: false,
        }),
      },
    );
    expect(rows[0].agrees).toBe(false);
    expect(rows[0].declaredWhen).toBe("2026-11-01T00:00:00Z");
    expect(rows[0].live?.starts_at).toBe("2027-01-01T00:00:00Z");
  });

  it("does not confuse a dateless role with a dated one", () => {
    const rows = diffPolicies(
      { admin: null },
      {
        admin: live({
          raw: "2026-11-01T00:00:00Z",
          starts_at: "2026-11-01T00:00:00Z",
          enforced_now: false,
        }),
      },
    );
    expect(rows[0].agrees).toBe(false);
  });

  it("returns nothing at all when neither side enforces anyone", () => {
    expect(diffPolicies({}, {})).toEqual([]);
  });
});
