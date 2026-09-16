/**
 * The panel that answers "why".
 *
 * "Usage by Model" answers *what* answered and how much it consumed. It cannot
 * answer why consumption moved, because a model id is the outcome of a
 * decision, not the decision. These three views read the decision columns that
 * `ai_usage_logs` now carries:
 *
 *   - **By feature** — "why is tutoring usage up 30%" is one row here, where
 *     `function_name` would have required knowing in advance that tutoring
 *     means study-tutor *and* socratic-chat.
 *   - **By policy** — "does Sol earn its keep on outlines?" reads off
 *     tokens-per-call against the tier the policy asked for.
 *   - **Wasted attempts** — attempts that ended in anything but success. These
 *     rows did not exist at all before, which is what made a usage spike
 *     unattributable: a call retried three times logged only its last attempt.
 *
 * Everything is denominated in tokens, never dollars. Token counts are what the
 * API reports and they stay true; a rate table would be wrong at the next
 * repricing. Convert outside the app if you want money.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Compass } from "lucide-react";
import { useFormatters } from "@/i18n/formatters";

export interface FeatureUsageRow {
  feature: string;
  calls: number;
  totalTokens: number;
  outputTokens: number;
}

export interface PolicyUsageRow {
  policyKey: string;
  feature: string;
  /** Distinct models seen under this policy. More than one means the policy
   *  changed inside the window — which is exactly when a cost delta needs
   *  explaining, so it is surfaced rather than collapsed. */
  models: string[];
  tiers: string[];
  policyVersions: number[];
  calls: number;
  totalTokens: number;
  /** Tokens per call — what a tier or effort change actually moves, and the
   *  figure a policy comparison turns on. Call counts alone hide it. */
  avgTokensPerCall: number;
  avgLatencyMs: number;
}

export interface WastedAttemptRow {
  outcome: string;
  attempts: number;
  /** Tokens burned by attempts that produced nothing usable. A rate-limited
   *  attempt contributes 0; an `incomplete` one contributes everything it
   *  generated before hitting the ceiling. */
  totalTokens: number;
}

export interface ModelDecisionData {
  byFeature: FeatureUsageRow[];
  byPolicy: PolicyUsageRow[];
  wasted: WastedAttemptRow[];
  successfulCalls: number;
  failedAttempts: number;
  wastedTokens: number;
  totalTokens: number;
  /** Rows predating the decision columns, or written by a call site that does
   *  not yet name a policy. Stated plainly so a partial view is never mistaken
   *  for a complete one. */
  unattributedCalls: number;
  hasData: boolean;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

const TIER_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  flagship: "default",
  balanced: "secondary",
  standard: "secondary",
  mini: "outline",
  image: "outline",
  unknown: "outline",
};

export function ModelDecisionPanel({ data }: { data: ModelDecisionData }) {
  const { formatNumber } = useFormatters();
  if (!data.hasData) {
    return (
      <Card className="mb-8" data-testid="model-decision-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="w-5 h-5" />
            Why this model
          </CardTitle>
          <CardDescription>Cost by feature and by model policy</CardDescription>
        </CardHeader>
        <CardContent>
          <p
            className="text-center text-muted-foreground py-8"
            data-testid="model-decision-empty-state"
          >
            No AI calls in this window
          </p>
        </CardContent>
      </Card>
    );
  }

  const wastedPct =
    data.totalTokens > 0 ? (data.wastedTokens / data.totalTokens) * 100 : 0;

  return (
    <Card className="mb-8" data-testid="model-decision-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Compass className="w-5 h-5" />
          Why this model
        </CardTitle>
        <CardDescription>
          Token usage grouped by the decision that produced it, not by the model that answered
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        {data.unattributedCalls > 0 && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="model-decision-unattributed"
          >
            {formatNumber(data.unattributedCalls)} call
            {data.unattributedCalls === 1 ? "" : "s"} in this window carry no policy — logged
            before the decision columns existed, or from a call site that does not name one.
            They are excluded from the two tables below.
          </p>
        )}

        <section>
          <h3 className="text-sm font-medium mb-3">By feature</h3>
          <Table data-testid="model-decision-feature-table">
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Total Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byFeature.map((row) => (
                <TableRow key={row.feature} data-testid={`model-decision-feature-${row.feature}`}>
                  <TableCell className="font-medium">{row.feature}</TableCell>
                  <TableCell className="text-right">{formatNumber(row.calls)}</TableCell>
                  <TableCell className="text-right">{formatTokens(row.outputTokens)}</TableCell>
                  <TableCell className="text-right font-medium">
                    {formatTokens(row.totalTokens)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>

        <section>
          <h3 className="text-sm font-medium mb-3">By policy</h3>
          <div className="overflow-x-auto">
            <Table data-testid="model-decision-policy-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Policy</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Avg tokens/call</TableHead>
                  <TableHead className="text-right">Avg latency</TableHead>
                  <TableHead className="text-right">Total Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byPolicy.map((row) => (
                  <TableRow
                    key={row.policyKey}
                    data-testid={`model-decision-policy-${row.policyKey}`}
                  >
                    <TableCell className="font-medium">
                      <code className="text-xs bg-secondary px-2 py-1 rounded">
                        {row.policyKey}
                      </code>
                      {row.policyVersions.length > 1 && (
                        <span
                          className="text-xs text-muted-foreground ml-2"
                          title="This policy changed during the window — compare the versions before reading the average"
                        >
                          v{row.policyVersions.join("/")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.models.map((m) => (
                        <code
                          key={m}
                          className="text-xs bg-secondary px-2 py-1 rounded mr-1 inline-block"
                        >
                          {m}
                        </code>
                      ))}
                    </TableCell>
                    <TableCell>
                      {row.tiers.map((t) => (
                        <Badge key={t} variant={TIER_VARIANT[t] ?? "outline"} className="mr-1">
                          {t}
                        </Badge>
                      ))}
                    </TableCell>
                    <TableCell className="text-right">{formatNumber(row.calls)}</TableCell>
                    <TableCell className="text-right">
                      {formatTokens(row.avgTokensPerCall)}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.avgLatencyMs > 0 ? `${(row.avgLatencyMs / 1000).toFixed(1)}s` : "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatTokens(row.totalTokens)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Tokens spent on attempts that did not succeed
          </h3>
          {data.failedAttempts === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="model-decision-no-waste">
              Every attempt in this window succeeded on its first try.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-3" data-testid="model-decision-waste-summary">
                {formatNumber(data.failedAttempts)} of{" "}
                {formatNumber((data.failedAttempts + data.successfulCalls))} attempts failed or
                came back incomplete, burning {formatTokens(data.wastedTokens)} tokens —{" "}
                {wastedPct.toFixed(1)}% of the window's total.
              </p>
              <Table data-testid="model-decision-waste-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Tokens burned</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.wasted.map((row) => (
                    <TableRow
                      key={row.outcome}
                      data-testid={`model-decision-waste-${row.outcome}`}
                    >
                      <TableCell className="font-medium">{row.outcome}</TableCell>
                      <TableCell className="text-right">{formatNumber(row.attempts)}</TableCell>
                      <TableCell className="text-right font-medium">
                        {formatTokens(row.totalTokens)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** One `ai_usage_logs` row, narrowed to the fields this panel reads. */
export interface DecisionLogRow {
  feature: string | null;
  policy_key: string | null;
  policy_version: number | null;
  model_tier: string | null;
  model: string | null;
  outcome: string | null;
  total_tokens: number | null;
  output_tokens: number | null;
  response_time_ms: number | null;
}

/** Token columns are plain integers, but a NULL must contribute 0, not NaN. */
function tokens(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function computeModelDecisions(logs: DecisionLogRow[]): ModelDecisionData {
  const byFeature = new Map<string, FeatureUsageRow>();
  const byPolicy = new Map<
    string,
    {
      feature: string;
      models: Set<string>;
      tiers: Set<string>;
      versions: Set<number>;
      calls: number;
      totalTokens: number;
      latencySum: number;
      latencyCount: number;
    }
  >();
  const wasted = new Map<string, WastedAttemptRow>();

  let successfulCalls = 0;
  let failedAttempts = 0;
  let wastedTokens = 0;
  let totalTokens = 0;
  let unattributedCalls = 0;

  for (const log of logs) {
    const rowTokens = tokens(log.total_tokens);
    totalTokens += rowTokens;

    // A row with no outcome predates this column; treat it as the success it
    // must have been, since only successes were ever written back then.
    const outcome = log.outcome ?? "success";
    if (outcome === "success") {
      successfulCalls++;
    } else {
      failedAttempts++;
      wastedTokens += rowTokens;
      const entry = wasted.get(outcome) ?? { outcome, attempts: 0, totalTokens: 0 };
      entry.attempts++;
      entry.totalTokens += rowTokens;
      wasted.set(outcome, entry);
    }

    if (!log.feature || !log.policy_key) {
      unattributedCalls++;
      continue;
    }

    const feature = byFeature.get(log.feature) ?? {
      feature: log.feature,
      calls: 0,
      totalTokens: 0,
      outputTokens: 0,
    };
    feature.calls++;
    feature.totalTokens += rowTokens;
    feature.outputTokens += tokens(log.output_tokens);
    byFeature.set(log.feature, feature);

    const policy = byPolicy.get(log.policy_key) ?? {
      feature: log.feature,
      models: new Set<string>(),
      tiers: new Set<string>(),
      versions: new Set<number>(),
      calls: 0,
      totalTokens: 0,
      latencySum: 0,
      latencyCount: 0,
    };
    policy.calls++;
    policy.totalTokens += rowTokens;
    if (log.model) policy.models.add(log.model);
    if (log.model_tier) policy.tiers.add(log.model_tier);
    if (log.policy_version !== null) policy.versions.add(log.policy_version);
    if (log.response_time_ms) {
      policy.latencySum += log.response_time_ms;
      policy.latencyCount++;
    }
    byPolicy.set(log.policy_key, policy);
  }

  return {
    byFeature: [...byFeature.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byPolicy: [...byPolicy.entries()]
      .map(([policyKey, p]) => ({
        policyKey,
        feature: p.feature,
        models: [...p.models].sort(),
        tiers: [...p.tiers].sort(),
        policyVersions: [...p.versions].sort((a, b) => a - b),
        calls: p.calls,
        totalTokens: p.totalTokens,
        avgTokensPerCall: p.calls > 0 ? Math.round(p.totalTokens / p.calls) : 0,
        avgLatencyMs: p.latencyCount > 0 ? Math.round(p.latencySum / p.latencyCount) : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
    wasted: [...wasted.values()].sort(
      (a, b) => b.totalTokens - a.totalTokens || b.attempts - a.attempts,
    ),
    successfulCalls,
    failedAttempts,
    wastedTokens,
    totalTokens,
    unattributedCalls,
    hasData: logs.length > 0,
  };
}
