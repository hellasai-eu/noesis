import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { declaredMfaPolicy, type MfaPolicyRow } from "@/deployment";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Declared MFA policy against live MFA policy.
 *
 * The deployment overlay declares the policy (`deployment/settings.json`) and
 * the database enforces it (`security_policies.mfa_policy`). One source of
 * truth, but two places it has to arrive — `npm run settings:sql` generates
 * the statement and the deployment repository applies it, which is a step a
 * human can forget.
 *
 * Forgetting it is quiet and bad in both directions: the app nudges a role the
 * database does not gate, or says nothing about one it does. So the drift gets
 * a panel rather than a comment in a runbook. This is the only place the two
 * are compared at run time; `npm run settings:sql -- --check` covers the
 * pipeline, but it validates the declaration and cannot see a database.
 *
 * Super-admins only, because `mfa_policy_effective()` returns null to everyone
 * else — this panel is for the person who can fix it.
 */

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admins",
  admin: "Institution admins",
  instructor: "Instructors",
  evaluator: "Evaluators",
  student: "Students",
};

const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;

/** "immediately", or the date enforcement begins. */
function whenLabel(value: string | null): string {
  if (value === null) return "immediately";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return `invalid date (${value})`;
  // The stored value is a UTC instant; format its UTC date so a reader west
  // of UTC is not shown the previous day.
  return `from ${parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })}`;
}

/**
 * Compares the two policies role by role.
 *
 * Deliberately not a deep-equal on the objects: an operator needs to know
 * *which* role disagrees, and the two are written by different tools (one
 * sorts its keys, the other is whatever Postgres returns), so object identity
 * would report false differences.
 */
function diffPolicies(declared: MfaPolicyRow, live: MfaPolicyRow) {
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

/** Both null, or both parsing to the same instant — "Z" and "+00:00" agree. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return left === right;
}

export function MfaPolicyPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["mfa-policy-effective"],
    staleTime: 60_000,
    queryFn: async (): Promise<MfaPolicyRow | null> => {
      const { data: policy, error: rpcError } = await supabase.rpc("mfa_policy_effective");
      if (rpcError) throw rpcError;
      return (policy as MfaPolicyRow | null) ?? null;
    },
  });

  const rows = data ? diffPolicies(declaredMfaPolicy, data) : [];
  const drifted = rows.filter((r) => !r.agrees);

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          Two-factor policy
        </CardTitle>
        <CardDescription>
          What this build declares, against what the database enforces. The
          database is what counts — generate the statement with{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run settings:sql</code>{" "}
          and apply it from the deployment repository.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-20 w-full" />}

        {error && (
          <p className="text-sm text-destructive">
            Could not read the live policy: {(error as Error).message}
          </p>
        )}

        {!isLoading && !error && data === null && (
          <p className="text-sm text-muted-foreground">
            The live policy is only readable by a super-admin session at aal2.
          </p>
        )}

        {data && (
          <>
            <div
              className={cn(
                "flex items-start gap-2 rounded-md border p-3 text-sm",
                drifted.length === 0
                  ? "border-border text-muted-foreground"
                  : "border-amber-500/60 bg-amber-500/10 text-foreground",
              )}
              data-testid="mfa-policy-drift"
            >
              {drifted.length === 0 ? (
                <>
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                    aria-hidden="true"
                  />
                  <span>The live policy matches this build.</span>
                </>
              ) : (
                <>
                  <ShieldAlert
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <span>
                    {drifted.length} role{drifted.length === 1 ? "" : "s"} disagree. The
                    database is what is enforced, whatever this build says.
                  </span>
                </>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No role requires two-factor authentication.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {rows.map((row) => (
                  <li
                    key={row.role}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
                  >
                    <span className="font-medium text-foreground">{roleLabel(row.role)}</span>
                    <span
                      className={cn(
                        "font-mono text-xs",
                        row.agrees ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {row.agrees
                        ? whenLabel(row.liveWhen)
                        : `live: ${row.inLive ? whenLabel(row.liveWhen) : "not enforced"} · build: ${
                            row.inDeclared ? whenLabel(row.declaredWhen) : "not enforced"
                          }`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default MfaPolicyPanel;
