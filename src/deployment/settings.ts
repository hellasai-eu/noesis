/**
 * Deployment settings: the policy knobs an operator sets, as opposed to the
 * brand they wear or the legal text they publish.
 *
 * Today that means one thing — which roles must enrol in two-factor
 * authentication, and from when.
 *
 * ## This file is a declaration, not the enforcement
 *
 * MFA is enforced in the database: a blanket restrictive RLS policy calls
 * `public.mfa_satisfied()` on every table, and the privileged-role helpers
 * (`is_super_admin`, `is_institution_admin`, `is_admin`) demand an `aal2`
 * session. A setting that lived only in the bundle would gate the SPA and
 * nothing else — anyone holding a JWT could keep reading the database
 * directly. So the declaration here has to reach Postgres to mean anything.
 *
 * The route it takes is deliberate and worth understanding:
 *
 *   1. `deployment/settings.json` declares the policy.
 *   2. `npm run settings:sql` turns it into an `UPDATE public.security_policies`
 *      statement (see `scripts/emit-settings-sql.ts`).
 *   3. The deployment repository applies that statement. This repository
 *      deploys nowhere and holds no credentials, so applying it is not ours
 *      to do.
 *   4. The frontend never trusts this file for authorisation. It asks
 *      `mfa_enrollment_status()` which gate to show, so the server stays the
 *      single source of truth at run time.
 *
 * Step 3 is a step a human can forget, which is the cost of this design: the
 * declared policy and the live one can drift. `mfa_policy_effective()` exists
 * so the drift is visible rather than silent — the super-admin version page
 * shows declared against live, and `settings:sql --check` fails a pipeline on
 * a mismatch.
 */

/**
 * Every role the policy can name.
 *
 * `super_admin` is platform staff, held in the `super_admins` table. The other
 * four are `user_institutions.role` values, and the check constraint there
 * (migration `20260624100000`) is the list this mirrors — a role added to the
 * database and not to this array simply cannot be enforced, which the
 * validator below turns into a build failure rather than a silent gap.
 */
export const MFA_ROLES = [
  "super_admin",
  "admin",
  "instructor",
  "evaluator",
  "student",
] as const;

export type MfaRole = (typeof MFA_ROLES)[number];

export interface MfaSettings {
  /**
   * Roles that must enrol in TOTP to keep using the platform. A role listed
   * here is enforced immediately unless `deadlines` names a later date.
   *
   * An unenrolled user in an enforced role loses *all* database access —
   * that is what the blanket restrictive policy does — and sees the
   * full-screen enrolment gate, which is their route back. Enforcing a role
   * is therefore a real decision about real people, not a display toggle.
   */
  enforceForRoles: MfaRole[];

  /**
   * When enforcement starts for a role, as an ISO-8601 instant.
   *
   * Before the date the role is *recommended*: a dismissible nudge naming the
   * date, and no loss of access. From the date it is *required*. A role in
   * `enforceForRoles` with no entry here is required immediately — which is
   * the right setting for platform staff and a harsh one for a thousand
   * pupils, so give a broad role a deadline and let people see it coming.
   */
  deadlines: Partial<Record<MfaRole, string>>;
}

export interface DeploymentSettings {
  mfa: MfaSettings;
}

/**
 * What an overlay may hand to `defineSettings`.
 *
 * Loosely typed on purpose: the settings arrive from `settings.json`, and
 * TypeScript widens a JSON string array to `string[]` — so demanding
 * `MfaRole[]` here would make every overlay write a cast, and a cast is
 * exactly the wrong thing to teach when the value is operator input.
 * `defineSettings` narrows instead, dropping anything that is not a role.
 */
export type DeploymentSettingsInput = {
  mfa?: {
    enforceForRoles?: readonly string[];
    deadlines?: Readonly<Record<string, string>>;
  };
};

/**
 * The policy an unconfigured clone runs on, and the policy the shipped
 * migration seeds.
 *
 * It reproduces what this codebase enforced before the policy became
 * configurable (migration `20260914180000`): MFA required for platform staff
 * at once, and for institution admins from 2026-11-01. Keeping the default
 * identical to the old hard-coded behaviour is what makes the change safe to
 * deploy without also deciding a new policy.
 */
export const MFA_SETTINGS_DEFAULTS: MfaSettings = {
  enforceForRoles: ["super_admin", "admin"],
  deadlines: { admin: "2026-11-01T00:00:00Z" },
};

export const DEPLOYMENT_SETTINGS_DEFAULTS: DeploymentSettings = {
  mfa: MFA_SETTINGS_DEFAULTS,
};

/**
 * Normalises an overlay's settings.
 *
 * Tolerant on purpose: this runs in the browser, where throwing would replace
 * the app with a blank page over a policy typo. The strict pass is
 * `validateSettings`, which runs at build time and in the SQL emitter — so a
 * typo fails the build, and a bundle that somehow shipped one still boots and
 * still defers to the server for every authorisation decision.
 */
export function defineSettings(input: DeploymentSettingsInput = {}): DeploymentSettings {
  const mfa = input.mfa ?? {};

  // Narrow rather than trust. An unknown role is dropped: enforcing a role
  // the database has never heard of is not a thing that can work, and the
  // build-time validator has already refused it out loud.
  const enforceForRoles =
    mfa.enforceForRoles === undefined
      ? MFA_SETTINGS_DEFAULTS.enforceForRoles
      : dedupe(mfa.enforceForRoles.filter(isMfaRole));

  const deadlines: Partial<Record<MfaRole, string>> = {};
  if (mfa.deadlines === undefined) {
    Object.assign(deadlines, MFA_SETTINGS_DEFAULTS.deadlines);
  } else {
    for (const [role, value] of Object.entries(mfa.deadlines)) {
      if (isMfaRole(role) && typeof value === "string") deadlines[role] = value;
    }
  }

  return { mfa: { enforceForRoles, deadlines } };
}

function isMfaRole(value: string): value is MfaRole {
  return (MFA_ROLES as readonly string[]).includes(value);
}

function dedupe(roles: MfaRole[]): MfaRole[] {
  return [...new Set(roles)];
}

/**
 * The policy as the database stores it: role → enforcement start, where
 * `null` means "immediately".
 *
 * Presence of a key is what makes a role enforced, so an empty object is a
 * valid policy meaning "nobody is required to enrol". The shape is chosen to
 * be cheap to read in SQL (`value ? role`, `value ->> role`) rather than to
 * look like the TypeScript above.
 */
export type MfaPolicyRow = Record<string, string | null>;

export function mfaPolicyRow(settings: DeploymentSettings): MfaPolicyRow {
  const row: MfaPolicyRow = {};
  // Sorted so the emitted SQL is stable: an unchanged policy must produce a
  // byte-identical statement, or every build looks like a policy change.
  for (const role of [...settings.mfa.enforceForRoles].sort()) {
    row[role] = settings.mfa.deadlines[role] ?? null;
  }
  return row;
}

/**
 * Strict validation, for the build and for the SQL emitter.
 *
 * Returns the problems rather than throwing, so a caller can report all of
 * them at once instead of making the operator fix typos one build at a time.
 * An empty array means the settings are usable.
 *
 * Every rule here exists because the failure it catches is *silent*: a
 * misspelled role, or a deadline attached to a role nobody enforces, would
 * otherwise read as a configured policy while enforcing nothing.
 */
export function validateSettings(input: unknown): string[] {
  const problems: string[] = [];

  if (typeof input !== "object" || input === null) {
    return ["settings must be an object"];
  }

  const mfa = (input as { mfa?: unknown }).mfa;
  if (mfa === undefined) return problems; // Absent is fine: defaults apply.
  // `Array.isArray` matters: `typeof [] === "object"`, so without it a JSON
  // array would pass the shape check and then read as an empty policy —
  // rejected here rather than silently enforcing nothing.
  if (typeof mfa !== "object" || mfa === null || Array.isArray(mfa)) {
    return ["settings.mfa must be an object"];
  }

  const { enforceForRoles, deadlines } = mfa as {
    enforceForRoles?: unknown;
    deadlines?: unknown;
  };

  const roles: string[] = [];
  if (enforceForRoles !== undefined) {
    if (!Array.isArray(enforceForRoles)) {
      problems.push("settings.mfa.enforceForRoles must be an array");
    } else {
      for (const role of enforceForRoles) {
        if (typeof role !== "string" || !(MFA_ROLES as readonly string[]).includes(role)) {
          problems.push(
            `settings.mfa.enforceForRoles: ${JSON.stringify(role)} is not a role ` +
              `(expected one of ${MFA_ROLES.join(", ")})`,
          );
          continue;
        }
        if (roles.includes(role)) {
          problems.push(`settings.mfa.enforceForRoles: ${role} listed twice`);
          continue;
        }
        roles.push(role);
      }
    }
  }

  if (deadlines !== undefined) {
    if (typeof deadlines !== "object" || deadlines === null || Array.isArray(deadlines)) {
      problems.push("settings.mfa.deadlines must be an object");
    } else {
      const effectiveRoles = enforceForRoles === undefined
        ? (MFA_SETTINGS_DEFAULTS.enforceForRoles as readonly string[])
        : roles;

      for (const [role, value] of Object.entries(deadlines)) {
        if (!(MFA_ROLES as readonly string[]).includes(role)) {
          problems.push(`settings.mfa.deadlines: ${JSON.stringify(role)} is not a role`);
          continue;
        }
        // The dangerous typo: a date set on a role that is not enforced does
        // nothing at all, and reads like a configured grace period.
        if (!effectiveRoles.includes(role)) {
          problems.push(
            `settings.mfa.deadlines.${role}: ${role} is not in enforceForRoles, ` +
              `so this date has no effect`,
          );
        }
        if (typeof value !== "string" || !isIsoInstant(value)) {
          problems.push(
            `settings.mfa.deadlines.${role}: ${JSON.stringify(value)} is not an ` +
              `ISO-8601 instant (e.g. "2026-11-01T00:00:00Z")`,
          );
        }
      }
    }
  }

  return problems;
}

/**
 * An instant, not a date: a bare "2026-11-01" would be read in the viewer's
 * zone by `Date` and in UTC by Postgres, which is a whole day of disagreement
 * about when people lose access.
 */
function isIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}
