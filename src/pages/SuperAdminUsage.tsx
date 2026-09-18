import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import { Button } from "@/components/ui/button";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LogOut,
  Loader2,
  Building,
  ArrowLeft,
  Zap,
  TrendingUp,
  Timer,
  AlertTriangle,
  Activity,
  Calendar,
} from "lucide-react";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import {
  CachePerformancePanel,
  computeCachePerformance,
  type CachePerformanceData,
} from "@/components/super-admin/CachePerformancePanel";
import {
  UsageByModelPanel,
  computeUsageByModel,
  type UsageByModelData,
  type UsageByModelTotals,
} from "@/components/super-admin/UsageByModelPanel";
import {
  ModelDecisionPanel,
  computeModelDecisions,
  type DecisionLogRow,
  type ModelDecisionData,
} from "@/components/super-admin/ModelDecisionPanel";
import { useFormatters } from "@/i18n/formatters";
import { BrandMark } from "@/components/BrandMark";

/** PostgREST's own page ceiling; asking for more per request achieves nothing. */
const USAGE_PAGE_SIZE = 1000;

/**
 * Ceiling on how much this page will pull into the browser to aggregate.
 * Reaching it is disclosed on the page rather than silently truncating — the
 * failure mode being fixed here is a wrong number that looks right, and an
 * uncapped fetch would trade it for a tab that hangs.
 *
 * 50k rows is roughly a fortnight of heavy traffic. Past that the aggregation
 * belongs in SQL rather than in the client.
 */
const USAGE_MAX_ROWS = 50_000;

type UsageLogRow = Database["public"]["Tables"]["ai_usage_logs"]["Row"];

interface ResponseTimeByStatus {
  status: string;
  avgResponseTime: number;
  count: number;
}

interface UsageStats {
  /** True when the row cap was hit, so every figure below covers only the most
   *  recent USAGE_MAX_ROWS attempts rather than the whole selected window. */
  truncated: boolean;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  avgResponseTime: number;
  responseTimeByStatus: ResponseTimeByStatus[];
  byFunction: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
  byInstitution: Record<string, { name: string; requests: number; inputTokens: number; outputTokens: number }>;
  byDay: { date: string; requests: number; tokens: number }[];
  cachePerformance: CachePerformanceData;
  usageByModel: UsageByModelData;
  modelDecisions: ModelDecisionData;
}

interface Institution {
  id: string;
  name: string;
}

const SuperAdminUsage = () => {
  const { compareCode, formatNumber } = useFormatters();
  const navigate = useNavigate();
  const { user, loading, signOut } = useAuth();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [stats, setStats] = useState<UsageStats | null>(null);
  /** Set when the usage query fails, so the failure is shown as a failure
   *  rather than as an empty reporting window. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [selectedInstitution, setSelectedInstitution] = useState<string>("all");
  const [dateRange, setDateRange] = useState<string>("7");
  /**
   * Generation counter for the usage fetch. Changing a filter starts a new
   * paginated read while the previous one may still be running, and paging
   * makes those reads long — up to 50 sequential round trips — so overlap is
   * routine here rather than a rare race. Without this, whichever finishes
   * LAST wins: a slow 90-day read can land after a quick 7-day one and paint
   * the old window's figures under the new window's labels.
   */
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
      return;
    }

    if (user) {
      checkSuperAdmin();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check on user/loading change
  }, [user, loading, navigate]);

  useEffect(() => {
    if (isSuperAdmin) {
      fetchUsageStats();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on isSuperAdmin/institution/dateRange change
  }, [isSuperAdmin, selectedInstitution, dateRange]);

  const checkSuperAdmin = async () => {
    try {
      const { data, error } = await supabase.rpc("is_super_admin", {
        _user_id: user!.id,
      });

      if (error) {
        console.error("Error checking super admin status:", error);
        setIsSuperAdmin(false);
        return;
      }

      setIsSuperAdmin(data);

      if (data) {
        await fetchInstitutions();
      }
      setLoadingData(false);
    } catch (error) {
      console.error("Error:", error);
      setIsSuperAdmin(false);
      setLoadingData(false);
    }
  };

  const fetchInstitutions = async () => {
    const { data, error } = await supabase
      .from("institutions")
      .select("id, name")
      .order("name");

    if (!error && data) {
      setInstitutions(data);
    }
  };

  const fetchUsageStats = async () => {
    const generation = ++requestGeneration.current;
    /** False once a newer fetch has started; this one's result is unwanted. */
    const isCurrent = () => generation === requestGeneration.current;

    setLoadingData(true);
    setLoadError(null);
    try {
      const days = parseInt(dateRange);
      const startDate = startOfDay(subDays(new Date(), days));
      const endDate = endOfDay(new Date());

      // Fetch institutions first to ensure we have names
      const { data: instData } = await supabase
        .from("institutions")
        .select("id, name")
        .order("name");
      
      const institutionMap = new Map((instData || []).map(i => [i.id, i.name]));
      if (instData) {
        setInstitutions(instData);
      }

      // Paginated, because PostgREST caps an unbounded select at max-rows
      // (1000 by default) and returns the first page with no error and no
      // indication that anything was dropped. Every figure on this page is a
      // client-side aggregate over these rows, so a silent cap does not shrink
      // the report — it makes every number on it wrong, while still looking
      // like a complete answer for the selected window.
      //
      // One row per HTTP attempt (rather than per successful call) means this
      // bites soonest during a retry storm, which is exactly when someone would
      // open this page.
      const { rows: logs, truncated, aborted } = await fetchAllPages<UsageLogRow>(
        async (cursor) => {
          let query = supabase
            .from("ai_usage_logs")
            .select("*")
            .gte("created_at", startDate.toISOString())
            .lte("created_at", endDate.toISOString())
            // `created_at` alone is not a total order — the attempts of one call
            // land in the same instant — and a cursor on a non-unique key cannot
            // express "after this row". `id` makes it total.
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(USAGE_PAGE_SIZE);

          if (selectedInstitution !== "all") {
            query = query.eq("institution_id", selectedInstitution);
          }

          if (cursor) {
            // Keyset, not offset: this table is written by every edge function
            // on every attempt, and an insert during the read would shift every
            // later offset by one — re-reading the row at each page boundary and
            // dropping one at the far end. Anchoring to the last row seen is
            // unaffected by whatever arrives in front of it.
            //
            // Strictly "older than", never "or equal", or the cursor row itself
            // heads every page and the read never advances. Values are quoted
            // because a timestamp contains characters PostgREST's filter grammar
            // would otherwise read as syntax.
            query = query.or(
              `created_at.lt."${cursor.created_at}",` +
                `and(created_at.eq."${cursor.created_at}",id.lt."${cursor.id}")`,
            );
          }
          return query;
        },
        { pageSize: USAGE_PAGE_SIZE, maxRows: USAGE_MAX_ROWS, shouldContinue: isCurrent },
      );

      // Superseded mid-read: these rows are a partial prefix for filters nobody
      // is looking at any more. Returning early also leaves the newer fetch's
      // loading state and results untouched.
      if (aborted || !isCurrent()) return;

      // Calculate stats
      const byFunction: Record<string, { requests: number; inputTokens: number; outputTokens: number }> = {};
      const byInstitution: Record<string, { name: string; requests: number; inputTokens: number; outputTokens: number }> = {};
      const byDayMap: Record<string, { requests: number; tokens: number }> = {};
      const responseTimeByStatusMap: Record<string, { totalTime: number; count: number }> = {};
      const cacheByFunction: Record<string, { calls: number; inputTokens: number; inputTokensCached: number }> = {};
      const usageByModelTotals: Record<string, UsageByModelTotals> = {};
      const usageByFunctionModel: Record<string, Record<string, UsageByModelTotals>> = {};

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalResponseTime = 0;
      let responseTimeCount = 0;

      for (const log of logs || []) {
        totalInputTokens += log.input_tokens || 0;
        totalOutputTokens += log.output_tokens || 0;

        if (log.response_time_ms) {
          totalResponseTime += log.response_time_ms;
          responseTimeCount++;
          
          // Track response time by status
          const status = log.status || "unknown";
          if (!responseTimeByStatusMap[status]) {
            responseTimeByStatusMap[status] = { totalTime: 0, count: 0 };
          }
          responseTimeByStatusMap[status].totalTime += log.response_time_ms;
          responseTimeByStatusMap[status].count++;
        }

        // By model
        if (log.model) {
          if (!usageByModelTotals[log.model]) {
            usageByModelTotals[log.model] = { calls: 0, inputTokens: 0, outputTokens: 0 };
          }
          usageByModelTotals[log.model].calls++;
          usageByModelTotals[log.model].inputTokens += log.input_tokens || 0;
          usageByModelTotals[log.model].outputTokens += log.output_tokens || 0;

          if (log.function_name) {
            if (!usageByFunctionModel[log.function_name]) {
              usageByFunctionModel[log.function_name] = {};
            }
            if (!usageByFunctionModel[log.function_name][log.model]) {
              usageByFunctionModel[log.function_name][log.model] = {
                calls: 0,
                inputTokens: 0,
                outputTokens: 0,
              };
            }
            usageByFunctionModel[log.function_name][log.model].calls++;
            usageByFunctionModel[log.function_name][log.model].inputTokens += log.input_tokens || 0;
            usageByFunctionModel[log.function_name][log.model].outputTokens += log.output_tokens || 0;
          }
        }

        // By function
        if (log.function_name) {
          if (!byFunction[log.function_name]) {
            byFunction[log.function_name] = { requests: 0, inputTokens: 0, outputTokens: 0 };
          }
          byFunction[log.function_name].requests++;
          byFunction[log.function_name].inputTokens += log.input_tokens || 0;
          byFunction[log.function_name].outputTokens += log.output_tokens || 0;

          if (!cacheByFunction[log.function_name]) {
            cacheByFunction[log.function_name] = { calls: 0, inputTokens: 0, inputTokensCached: 0 };
          }
          cacheByFunction[log.function_name].calls++;
          cacheByFunction[log.function_name].inputTokens += log.input_tokens || 0;
          cacheByFunction[log.function_name].inputTokensCached += log.input_tokens_cached || 0;
        }

        // By institution
        if (log.institution_id) {
          if (!byInstitution[log.institution_id]) {
            byInstitution[log.institution_id] = { 
              name: institutionMap.get(log.institution_id) || "Unknown", 
              requests: 0, 
              inputTokens: 0, 
              outputTokens: 0 
            };
          }
          byInstitution[log.institution_id].requests++;
          byInstitution[log.institution_id].inputTokens += log.input_tokens || 0;
          byInstitution[log.institution_id].outputTokens += log.output_tokens || 0;
        }

        // By day
        const day = format(new Date(log.created_at), "yyyy-MM-dd");
        if (!byDayMap[day]) {
          byDayMap[day] = { requests: 0, tokens: 0 };
        }
        byDayMap[day].requests++;
        byDayMap[day].tokens += log.total_tokens || 0;
      }

      const byDay = Object.entries(byDayMap)
        .map(([date, data]) => ({ date, ...data }))
        .sort((a, b) => compareCode(a.date, b.date));

      const responseTimeByStatus = Object.entries(responseTimeByStatusMap)
        .map(([status, data]) => ({
          status,
          avgResponseTime: Math.round(data.totalTime / data.count),
          count: data.count,
        }))
        .sort((a, b) => b.count - a.count);

      setStats({
        truncated,
        totalRequests: logs.length,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        avgResponseTime: responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : 0,
        responseTimeByStatus,
        byFunction,
        byInstitution,
        byDay,
        cachePerformance: computeCachePerformance(cacheByFunction),
        usageByModel: computeUsageByModel(usageByModelTotals, usageByFunctionModel),
        modelDecisions: computeModelDecisions(logs as DecisionLogRow[]),
      });
    } catch (error) {
      // A failed load must not read as a quiet window. Without this the catch
      // swallowed the error, `stats` stayed null, and the page rendered "No
      // usage data available" — a failure indistinguishable from a period with
      // no AI activity at all, which is the same wrongness-that-looks-right the
      // pagination fix above is about.
      //
      // `stats` is also cleared, not left alone: on a failed refetch after a
      // filter change it would otherwise still hold the previous window's
      // numbers and render them under the newly-selected date range.
      console.error("Error fetching usage stats:", error);
      // A superseded read's failure must not erase the current one's result.
      if (!isCurrent()) return;
      setStats(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      // Only the newest read owns the spinner; an older one clearing it would
      // present a still-loading page as finished.
      if (isCurrent()) setLoadingData(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(2)}M`;
    }
    if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return tokens.toString();
  };

  if (loading || (loadingData && isSuperAdmin === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isSuperAdmin === false) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full mx-4">
          <CardHeader className="text-center">
            <CardTitle className="text-destructive">Access Denied</CardTitle>
            <CardDescription>
              You do not have super admin privileges.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button onClick={() => navigate("/dashboard")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <BrandMark
            badge={
              <span className="ml-2 text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                Super Admin
              </span>
            }
          />
          <div className="flex items-center gap-4">
            <Link to="/super-admin">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Management
              </Button>
            </Link>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-3">
              <Zap className="w-8 h-8" />
              AI Usage Dashboard
            </h1>
            <p className="text-muted-foreground mt-1">
              Monitor AI API usage across the platform
            </p>
          </div>
          <div className="flex gap-3">
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-[140px]">
                <Calendar className="w-4 h-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
            <Select value={selectedInstitution} onValueChange={setSelectedInstitution}>
              <SelectTrigger className="w-[200px]">
                <Building className="w-4 h-4 mr-2" />
                <SelectValue placeholder="All Institutions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Institutions</SelectItem>
                {institutions.map((inst) => (
                  <SelectItem key={inst.id} value={inst.id}>
                    {inst.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loadingData ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : stats ? (
          <>
            {/* A capped window says so. Every figure below is a client-side
                aggregate, so silently dropping rows would not shorten the
                report — it would make all of it quietly wrong. */}
            {stats.truncated && (
              <div
                className="mb-8 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 flex items-start gap-3"
                data-testid="usage-truncated-warning"
              >
                <AlertTriangle className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">Showing a partial window</p>
                  <p className="text-muted-foreground mt-1">
                    This window holds more than {formatNumber(USAGE_MAX_ROWS)} attempts. Every
                    figure below covers only the most recent{" "}
                    {formatNumber(stats.totalRequests)} — older calls in the range are excluded.
                    Narrow the date range or filter to one institution for a complete picture.
                  </p>
                </div>
              </div>
            )}

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Activity className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{formatNumber(stats.totalRequests)}</p>
                      <p className="text-sm text-muted-foreground">Total Requests</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <TrendingUp className="w-6 h-6 text-blue-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{formatTokens(stats.totalInputTokens)}</p>
                      <p className="text-sm text-muted-foreground">Input Tokens</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-green-500/10 flex items-center justify-center">
                      <TrendingUp className="w-6 h-6 text-green-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{formatTokens(stats.totalOutputTokens)}</p>
                      <p className="text-sm text-muted-foreground">Output Tokens</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-purple-500/10 flex items-center justify-center">
                      <Timer className="w-6 h-6 text-purple-500" />
                    </div>
                    <div>
                      <p className="text-2xl font-bold">{stats.avgResponseTime}ms</p>
                      <p className="text-sm text-muted-foreground">Avg Response Time</p>
                    </div>
                  </div>
                  {stats.responseTimeByStatus.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-border">
                      <p className="text-xs text-muted-foreground mb-2">By Status</p>
                      <div className="space-y-1">
                        {stats.responseTimeByStatus.map((item) => (
                          <div key={item.status} className="flex items-center justify-between text-sm">
                            <span className={`inline-flex items-center gap-1.5 ${
                              item.status === "completed" || item.status === "success" 
                                ? "text-green-600" 
                                : item.status === "error" || item.status === "failed"
                                ? "text-red-600"
                                : "text-muted-foreground"
                            }`}>
                              <span className={`w-2 h-2 rounded-full ${
                                item.status === "completed" || item.status === "success"
                                  ? "bg-green-500"
                                  : item.status === "error" || item.status === "failed"
                                  ? "bg-red-500"
                                  : "bg-muted-foreground"
                              }`} />
                              {item.status}
                            </span>
                            <span className="font-medium">{item.avgResponseTime}ms <span className="text-muted-foreground font-normal">({item.count})</span></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Cache Performance */}
            <CachePerformancePanel data={stats.cachePerformance} />

            {/* Usage by Model */}
            <UsageByModelPanel data={stats.usageByModel} />

            {/* Why this model — the same spend, grouped by the decision behind it */}
            <ModelDecisionPanel data={stats.modelDecisions} />

            {/* Daily Usage */}
            {stats.byDay.length > 0 && (
              <Card className="mb-8">
                <CardHeader>
                  <CardTitle>Daily Usage</CardTitle>
                  <CardDescription>Requests and tokens per day</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-48 flex items-end gap-1">
                    {stats.byDay.map((day) => {
                      const maxRequests = Math.max(...stats.byDay.map(d => d.requests));
                      const height = maxRequests > 0 ? (day.requests / maxRequests) * 100 : 0;
                      return (
                        <div key={day.date} className="flex-1 flex flex-col items-center">
                          <div 
                            className="w-full bg-primary/80 rounded-t transition-all hover:bg-primary"
                            style={{ height: `${height}%`, minHeight: day.requests > 0 ? '4px' : '0' }}
                            title={`${day.date}: ${day.requests} requests, ${formatTokens(day.tokens)} tokens`}
                          />
                          <span className="text-[10px] text-muted-foreground mt-1 rotate-45 origin-left">
                            {format(new Date(day.date), "MM/dd")}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* By Function */}
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle>Usage by Function</CardTitle>
                  <CardDescription>Token usage breakdown by edge function</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="max-h-80 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Function</TableHead>
                          <TableHead className="text-right">Requests</TableHead>
                          <TableHead className="text-right">Tokens</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries(stats.byFunction)
                          .sort((a, b) => b[1].requests - a[1].requests)
                          .map(([fn, data]) => (
                            <TableRow key={fn}>
                              <TableCell className="font-medium">
                                <code className="text-xs bg-secondary px-2 py-1 rounded">{fn}</code>
                              </TableCell>
                              <TableCell className="text-right">{formatNumber(data.requests)}</TableCell>
                              <TableCell className="text-right">
                                {formatTokens(data.inputTokens + data.outputTokens)}
                              </TableCell>
                            </TableRow>
                          ))}
                        {Object.keys(stats.byFunction).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                              No usage data
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              {/* By Institution */}
              {selectedInstitution === "all" && (
                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle>Usage by Institution</CardTitle>
                    <CardDescription>Token usage breakdown by institution</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Institution</TableHead>
                          <TableHead className="text-right">Requests</TableHead>
                          <TableHead className="text-right">Input Tokens</TableHead>
                          <TableHead className="text-right">Output Tokens</TableHead>
                          <TableHead className="text-right">Total Tokens</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {Object.entries(stats.byInstitution)
                          .sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens))
                          .map(([id, data]) => (
                            <TableRow key={id}>
                              <TableCell className="font-medium">
                                <div className="flex items-center gap-2">
                                  <Building className="w-4 h-4 text-muted-foreground" />
                                  {data.name}
                                </div>
                              </TableCell>
                              <TableCell className="text-right">{formatNumber(data.requests)}</TableCell>
                              <TableCell className="text-right">{formatTokens(data.inputTokens)}</TableCell>
                              <TableCell className="text-right">{formatTokens(data.outputTokens)}</TableCell>
                              <TableCell className="text-right font-medium">
                                {formatTokens(data.inputTokens + data.outputTokens)}
                              </TableCell>
                            </TableRow>
                          ))}
                        {Object.keys(stats.byInstitution).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                              No usage data
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </div>
          </>
        ) : loadError ? (
          <Card className="border-destructive/40" data-testid="usage-load-error">
            <CardContent className="py-12 text-center">
              <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-destructive" />
              <p className="font-medium">Could not load usage data</p>
              <p className="text-sm text-muted-foreground mt-2 max-w-lg mx-auto">
                This is a failure to read the data, not a quiet period — no conclusion should be
                drawn about AI activity in this window.
              </p>
              <p className="text-xs text-muted-foreground mt-3 font-mono break-words max-w-lg mx-auto">
                {loadError}
              </p>
              <Button variant="outline" className="mt-6" onClick={() => fetchUsageStats()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card data-testid="usage-empty-state">
            <CardContent className="py-12 text-center text-muted-foreground">
              <Zap className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No usage data available</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default SuperAdminUsage;
