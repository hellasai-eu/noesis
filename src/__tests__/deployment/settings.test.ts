import { describe, it, expect } from "vitest";

import {
  MFA_ROLES,
  MFA_SETTINGS_DEFAULTS,
  defineSettings,
  mfaPolicyRow,
  validateSettings,
  type DeploymentSettingsInput,
} from "@/deployment/settings";
import { declaredMfaPolicy, settings } from "@/deployment";

/**
 * The deployment policy has two readers with opposite obligations, and these
 * tests pin both:
 *
 * - `defineSettings` runs in the browser and must be **tolerant** — a policy
 *   typo must not replace the app with a blank page.
 * - `validateSettings` runs in the build and in the SQL emitter and must be
 *   **strict** — a typo that reaches production as a silently different policy
 *   is the failure this whole design exists to prevent.
 *
 * `mfaPolicyRow` is the bridge to Postgres, so its shape is a contract with
 * migration 20260918090000 rather than an implementation detail.
 */

describe("defineSettings", () => {
  it("defaults to the policy this codebase enforced before it was configurable", () => {
    // Adopting the configurable version must not also change anyone's policy.
    const result = defineSettings();
    expect(result.mfa.enforceForRoles).toEqual(["super_admin", "admin"]);
    expect(result.mfa.deadlines.admin).toBe("2026-11-01T00:00:00Z");
  });

  it("accepts a plain JSON object without a cast", () => {
    // The overlay spreads settings.json, which TypeScript widens to string[].
    // If this needs a cast, every deployment writes one, over operator input.
    const fromJson: unknown = JSON.parse(
      '{"mfa":{"enforceForRoles":["instructor"],"deadlines":{"instructor":"2026-12-01T00:00:00Z"}}}',
    );
    const result = defineSettings(fromJson as DeploymentSettingsInput);
    expect(result.mfa.enforceForRoles).toEqual(["instructor"]);
  });

  it("drops a role it does not recognise rather than passing it through", () => {
    const result = defineSettings({
      mfa: { enforceForRoles: ["instructor", "teacher", "student"] },
    });
    // "teacher" is not a role; enforcing it could never work, and carrying it
    // into the SQL would write a key nothing reads.
    expect(result.mfa.enforceForRoles).toEqual(["instructor", "student"]);
  });

  it("dedupes a role listed twice", () => {
    const result = defineSettings({ mfa: { enforceForRoles: ["admin", "admin"] } });
    expect(result.mfa.enforceForRoles).toEqual(["admin"]);
  });

  it("treats an empty role list as a real choice, not as absence", () => {
    // "nobody must enrol" has to be expressible, or a deployment cannot opt
    // out of the mandate it inherited.
    const result = defineSettings({ mfa: { enforceForRoles: [] } });
    expect(result.mfa.enforceForRoles).toEqual([]);
    expect(mfaPolicyRow(result)).toEqual({});
  });
});

describe("validateSettings", () => {
  it("passes the shipped default and an absent policy", () => {
    expect(validateSettings({ mfa: MFA_SETTINGS_DEFAULTS })).toEqual([]);
    expect(validateSettings({})).toEqual([]);
  });

  it("rejects a misspelled role", () => {
    const problems = validateSettings({ mfa: { enforceForRoles: ["teacher"] } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("teacher");
    // The message has to say what was expected: the operator cannot guess the
    // spelling from a rejection alone.
    expect(problems[0]).toContain("instructor");
  });

  it("rejects a deadline on a role nobody enforces", () => {
    // The dangerous typo. It reads as a configured grace period and does
    // nothing whatsoever.
    const problems = validateSettings({
      mfa: { enforceForRoles: ["admin"], deadlines: { student: "2026-11-01T00:00:00Z" } },
    });
    expect(problems.some((p) => p.includes("not in enforceForRoles"))).toBe(true);
  });

  it("rejects a bare date, which two systems would read a day apart", () => {
    const problems = validateSettings({
      mfa: { enforceForRoles: ["student"], deadlines: { student: "2026-11-01" } },
    });
    expect(problems.some((p) => p.includes("ISO-8601"))).toBe(true);
  });

  it("accepts an explicit offset as well as Z", () => {
    expect(
      validateSettings({
        mfa: { enforceForRoles: ["student"], deadlines: { student: "2026-11-01T00:00:00+02:00" } },
      }),
    ).toEqual([]);
  });

  it("reports every problem at once", () => {
    // One-typo-per-build is a miserable way to fix a config file.
    const problems = validateSettings({
      mfa: {
        enforceForRoles: ["teacher", "nobody"],
        deadlines: { student: "whenever" },
      },
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects shapes rather than throwing on them", () => {
    expect(validateSettings(null)).toHaveLength(1);
    expect(validateSettings("nope")).toHaveLength(1);
    expect(validateSettings({ mfa: [] })).toHaveLength(1);
    expect(validateSettings({ mfa: { enforceForRoles: "admin" } })).toHaveLength(1);
  });
});

describe("mfaPolicyRow", () => {
  it("maps a role to null when it is enforced immediately", () => {
    // `null` is how migration 20260918090000 spells "immediately"; presence of
    // the key is what enforces the role.
    expect(mfaPolicyRow(defineSettings({ mfa: { enforceForRoles: ["super_admin"] } }))).toEqual({
      super_admin: null,
    });
  });

  it("carries a deadline through unchanged", () => {
    expect(
      mfaPolicyRow(
        defineSettings({
          mfa: {
            enforceForRoles: ["instructor"],
            deadlines: { instructor: "2026-12-01T00:00:00Z" },
          },
        }),
      ),
    ).toEqual({ instructor: "2026-12-01T00:00:00Z" });
  });

  it("omits a deadline for a role it does not enforce", () => {
    const row = mfaPolicyRow(
      defineSettings({
        mfa: {
          enforceForRoles: ["admin"],
          deadlines: { admin: "2026-11-01T00:00:00Z", student: "2027-01-01T00:00:00Z" },
        },
      }),
    );
    expect(Object.keys(row)).toEqual(["admin"]);
  });

  it("emits keys in a stable order", () => {
    // The emitted SQL is diffed and reviewed. If key order tracked insertion
    // order, reordering the JSON array would look like a policy change.
    const a = mfaPolicyRow(defineSettings({ mfa: { enforceForRoles: ["student", "admin"] } }));
    const b = mfaPolicyRow(defineSettings({ mfa: { enforceForRoles: ["admin", "student"] } }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("the resolved overlay's policy", () => {
  it("is valid", () => {
    // The build refuses a malformed policy, so this mirrors the gate that
    // protects a deployment — against whichever overlay is configured.
    expect(validateSettings(settings)).toEqual([]);
  });

  it("names only roles the database can enforce", () => {
    for (const role of Object.keys(declaredMfaPolicy)) {
      expect(MFA_ROLES).toContain(role);
    }
  });

  it("exposes the policy in the shape the database stores", () => {
    expect(declaredMfaPolicy).toEqual(mfaPolicyRow(settings));
  });
});
