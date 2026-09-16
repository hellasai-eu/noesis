import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Gauge, Info } from "lucide-react";
import { useFormatters } from "@/i18n/formatters";

// This panel reports tokens, not money.
//
// It used to carry a hardcoded per-model rate table and render an "Est Cost
// USD" column from it. That table had drifted: gpt-5.6-sol, gpt-5.6-terra,
// gpt-5.5 and gpt-5.2 were all missing, so they rendered "—" and the
// study-guide path — the heaviest in the product — appeared to cost nothing.
// Worse, the figure was recomputed on every page load, so a repricing silently
// rewrote what previous months had "cost".
//
// A rate table in the frontend is wrong the moment OpenAI reprices, and keeping
// one current for every callable model is a maintenance burden that buys an
// approximation nobody should bill against anyway. Token counts are what the
// API actually reports, and they stay true. Convert to money against current
// rates outside the app; the OpenAI dashboard is the billing truth regardless.

export interface UsageByModelTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageByModelRow {
  model: string;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export interface UsageByModelCrossTab {
  models: string[];
  functions: {
    functionName: string;
    cells: Record<string, { calls: number; totalTokens: number } | undefined>;
  }[];
}

export interface UsageByModelData {
  rows: UsageByModelRow[];
  crossTab: UsageByModelCrossTab;
  hasData: boolean;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

const TOKENS_TOOLTIP_TEXT =
  "Token counts as reported by the OpenAI API. Cached input tokens are included " +
  "in the input figure — see the Cache Performance panel for the split. This app " +
  "deliberately records no dollar amounts: a rate table here would be wrong the " +
  "moment OpenAI reprices. The OpenAI dashboard is the source of truth for billing.";

export function UsageByModelPanel({ data }: { data: UsageByModelData }) {
  const { formatNumber } = useFormatters();
  const [crossTabOpen, setCrossTabOpen] = useState(false);

  if (!data.hasData) {
    return (
      <Card className="mb-8" data-testid="usage-by-model-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="w-5 h-5" />
            Usage by Model
          </CardTitle>
          <CardDescription>Calls and token volume per model</CardDescription>
        </CardHeader>
        <CardContent>
          <p
            className="text-center text-muted-foreground py-8"
            data-testid="usage-by-model-empty-state"
          >
            No AI calls in this window
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-8" data-testid="usage-by-model-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="w-5 h-5" />
          Usage by Model
        </CardTitle>
        <CardDescription>Calls and token volume per model</CardDescription>
      </CardHeader>
      <CardContent>
        <Table data-testid="usage-by-model-table">
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">
                <span className="inline-flex items-center gap-1.5 justify-end">
                  Total Tokens
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Token count explanation"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">{TOKENS_TOOLTIP_TEXT}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.model} data-testid={`usage-by-model-row-${row.model}`}>
                <TableCell className="font-medium">
                  <code className="text-xs bg-secondary px-2 py-1 rounded">{row.model}</code>
                </TableCell>
                <TableCell className="text-right">{formatNumber(row.totalCalls)}</TableCell>
                <TableCell className="text-right">{formatTokens(row.totalInputTokens)}</TableCell>
                <TableCell className="text-right">{formatTokens(row.totalOutputTokens)}</TableCell>
                <TableCell
                  className="text-right font-medium"
                  data-testid={`usage-by-model-tokens-${row.model}`}
                >
                  {formatTokens(row.totalTokens)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {data.crossTab.functions.length > 0 && (
        <Collapsible open={crossTabOpen} onOpenChange={setCrossTabOpen} className="mt-6">
          <CollapsibleTrigger
            type="button"
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="usage-by-model-crosstab-toggle"
          >
            {crossTabOpen ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            Function × Model breakdown
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <div className="overflow-x-auto" data-testid="usage-by-model-crosstab">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Function</TableHead>
                    {data.crossTab.models.map((model) => (
                      <TableHead key={model} className="text-right">
                        <code className="text-xs bg-secondary px-2 py-1 rounded">{model}</code>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.crossTab.functions.map((row) => (
                    <TableRow
                      key={row.functionName}
                      data-testid={`usage-by-model-crosstab-row-${row.functionName}`}
                    >
                      <TableCell className="font-medium">
                        <code className="text-xs bg-secondary px-2 py-1 rounded">
                          {row.functionName}
                        </code>
                      </TableCell>
                      {data.crossTab.models.map((model) => {
                        const cell = row.cells[model];
                        const cellTestId = `usage-by-model-crosstab-cell-${row.functionName}-${model}`;
                        if (!cell) {
                          return (
                            <TableCell
                              key={model}
                              className="text-right text-muted-foreground"
                              data-testid={cellTestId}
                            />
                          );
                        }
                        return (
                          <TableCell
                            key={model}
                            className="text-right"
                            data-testid={cellTestId}
                          >
                            <span className="font-medium">{formatTokens(cell.totalTokens)}</span>
                            <span className="text-xs text-muted-foreground ml-1">
                              ({formatNumber(cell.calls)})
                            </span>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CollapsibleContent>
        </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

export function computeUsageByModel(
  perModel: Record<string, UsageByModelTotals>,
  perFunctionModel: Record<string, Record<string, UsageByModelTotals>>,
): UsageByModelData {
  const rows: UsageByModelRow[] = Object.entries(perModel).map(([model, totals]) => ({
    model,
    totalCalls: totals.calls,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalTokens: totals.inputTokens + totals.outputTokens,
  }));

  // Heaviest first. Output tokens break ties because they are the expensive
  // half on every model, so between two models at equal volume the one
  // generating more is the one worth looking at.
  rows.sort((a, b) => b.totalTokens - a.totalTokens || b.totalOutputTokens - a.totalOutputTokens);

  const modelSet = new Set<string>();
  for (const byModel of Object.values(perFunctionModel)) {
    for (const model of Object.keys(byModel)) {
      modelSet.add(model);
    }
  }
  const models = Array.from(modelSet).sort();

  const functions = Object.entries(perFunctionModel)
    .map(([functionName, byModel]) => {
      const cells: UsageByModelCrossTab["functions"][number]["cells"] = {};
      let total = 0;
      for (const [model, totals] of Object.entries(byModel)) {
        if (totals.calls === 0) continue;
        const cellTotal = totals.inputTokens + totals.outputTokens;
        cells[model] = { calls: totals.calls, totalTokens: cellTotal };
        total += cellTotal;
      }
      return { functionName, cells, total };
    })
    .filter((row) => Object.keys(row.cells).length > 0)
    .sort((a, b) => b.total - a.total)
    .map(({ functionName, cells }) => ({ functionName, cells }));

  return {
    rows,
    crossTab: { models, functions },
    hasData: rows.length > 0,
  };
}
