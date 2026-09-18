import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { declaredMfaPolicy, type MfaPolicyRow } from "@/deployment";
import {
  diffPolicies,
  roleLabel,
  whenLabel,
} from "@/lib/mfa-policy-drift";
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
 *
 * The comparison itself lives in `@/lib/mfa-policy-drift`, so it can be tested
 * without a Supabase client; this file is the rendering.
 */

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
