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
import { Info, Layers, Zap } from "lucide-react";
import { useFormatters } from "@/i18n/formatters";

// This panel reports cached tokens, not dollars saved.
//
// It used to multiply cached tokens by a single hardcoded savings rate to show
// an "Estimated savings" figure. That rate was pinned to one model's pricing
// and applied to every function regardless of which model it called, so the
// number was wrong for the mini tier in one direction and for the flagship in
// the other — and wrong for all of them the moment OpenAI repriced.
//
// The cache hit rate is the actionable number here anyway: it is what a prompt
// with an unstable prefix damages, and what restructuring one improves. Tokens
// saved is exact and stays true; convert to money outside the app.

export interface CachePerformanceFunctionRow {
  functionName: string;
  totalCalls: number;
  totalInputTokens: number;
  totalInputTokensCached: number;
  cachePct: number;
}

export interface CachePerformanceData {
  overallCachePct: number;
  overallInputTokens: number;
  overallInputTokensCached: number;
  perFunction: CachePerformanceFunctionRow[];
  hasData: boolean;
}

export function getCachePctColor(pct: number): "red" | "yellow" | "green" {
  if (pct < 20) return "red";
  if (pct < 60) return "yellow";
  return "green";
}

const COLOR_TEXT_CLASS: Record<"red" | "yellow" | "green", string> = {
  red: "text-red-600",
  yellow: "text-yellow-600",
  green: "text-green-600",
};

const COLOR_BG_CLASS: Record<"red" | "yellow" | "green", string> = {
  red: "bg-red-500/10",
  yellow: "bg-yellow-500/10",
  green: "bg-green-500/10",
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

function formatPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

const CACHE_TOOLTIP_TEXT =
  "Cache hit % = fraction of input tokens served from OpenAI's prompt cache. Higher is better. Improves automatically when our prompts have stable static prefixes.";

export function CachePerformancePanel({ data }: { data: CachePerformanceData }) {
  const { formatNumber } = useFormatters();
  if (!data.hasData) {
    return (
      <Card className="mb-8" data-testid="cache-performance-panel">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Cache Performance
          </CardTitle>
          <CardDescription>OpenAI prompt-cache hit rate</CardDescription>
        </CardHeader>
        <CardContent>
          <p
            className="text-center text-muted-foreground py-8"
            data-testid="cache-empty-state"
          >
            No AI calls in this window
          </p>
        </CardContent>
      </Card>
    );
  }

  const overallColor = getCachePctColor(data.overallCachePct);

  return (
    <Card className="mb-8" data-testid="cache-performance-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="w-5 h-5" />
          Cache Performance
        </CardTitle>
        <CardDescription>OpenAI prompt-cache hit rate and cached token volume</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div className={`rounded-lg p-6 flex items-center gap-4 ${COLOR_BG_CLASS[overallColor]}`}>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm text-muted-foreground">Overall cache hit rate</p>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="Cache hit rate explanation"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Info className="w-4 h-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {CACHE_TOOLTIP_TEXT}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p
                className={`text-4xl font-bold ${COLOR_TEXT_CLASS[overallColor]}`}
                data-testid="overall-cache-pct"
              >
                {formatPct(data.overallCachePct)}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                {formatTokens(data.overallInputTokensCached)} / {formatTokens(data.overallInputTokens)} input
                tokens cached
              </p>
            </div>
          </div>
          <div className="rounded-lg p-6 flex items-center gap-4 bg-primary/10">
            <div className="w-12 h-12 rounded-lg bg-primary/20 flex items-center justify-center">
              <Layers className="w-6 h-6 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Tokens served from cache</p>
              <p className="text-4xl font-bold" data-testid="overall-cached-tokens">
                {formatTokens(data.overallInputTokensCached)}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                billed at a reduced rate rather than the full input rate
              </p>
            </div>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Function</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Cached</TableHead>
              <TableHead className="text-right">Cache %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.perFunction.map((row) => {
              const color = getCachePctColor(row.cachePct);
              return (
                <TableRow key={row.functionName} data-testid={`cache-row-${row.functionName}`}>
                  <TableCell className="font-medium">
                    <code className="text-xs bg-secondary px-2 py-1 rounded">{row.functionName}</code>
                  </TableCell>
                  <TableCell className="text-right">{formatNumber(row.totalCalls)}</TableCell>
                  <TableCell className="text-right">{formatTokens(row.totalInputTokens)}</TableCell>
                  <TableCell className="text-right">{formatTokens(row.totalInputTokensCached)}</TableCell>
                  <TableCell
                    className={`text-right font-medium ${COLOR_TEXT_CLASS[color]}`}
                    data-testid={`cache-pct-${row.functionName}`}
                  >
                    {formatPct(row.cachePct)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function computeCachePerformance(
  perFunctionTotals: Record<
    string,
    { calls: number; inputTokens: number; inputTokensCached: number }
  >,
): CachePerformanceData {
  let overallInputTokens = 0;
  let overallInputTokensCached = 0;

  const perFunction: CachePerformanceFunctionRow[] = Object.entries(perFunctionTotals)
    .map(([functionName, totals]) => {
      overallInputTokens += totals.inputTokens;
      overallInputTokensCached += totals.inputTokensCached;
      const cachePct =
        totals.inputTokens > 0 ? (totals.inputTokensCached * 100) / totals.inputTokens : 0;
      return {
        functionName,
        totalCalls: totals.calls,
        totalInputTokens: totals.inputTokens,
        totalInputTokensCached: totals.inputTokensCached,
        cachePct,
      };
    })
    .sort((a, b) => b.totalInputTokens - a.totalInputTokens);

  const overallCachePct =
    overallInputTokens > 0 ? (overallInputTokensCached * 100) / overallInputTokens : 0;
  return {
    overallCachePct,
    overallInputTokens,
    overallInputTokensCached,
    perFunction,
    hasData: overallInputTokens > 0,
  };
}
