import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Database } from "@/integrations/supabase/types";
import { fetchAllPages } from "@/lib/fetch-all-pages";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Bot, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useFormatters } from "@/i18n/formatters";

/**
 * The school's own view of its AI activity (compliance redline G8).
 *
 * `ai_usage_logs` has always been readable by an institution's admins ("Admins
 * can view institution AI usage" RLS policy); this page is the first surface
 * that shows it to them. Counts and context only — the table holds no prompt
 * or response content by design (Pack §6), so nothing here can leak a pupil's
 * words. The CSV mirrors what a school needs for an internal audit: who
 * initiated each call, when, which feature, which model, and what it cost in
 * tokens.
 */

type UsageLogRow = Database["public"]["Tables"]["ai_usage_logs"]["Row"];

const PAGE_SIZE = 1000;
const MAX_ROWS = 50_000;
const TABLE_LIMIT = 100;

const RANGE_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

/** The school-facing family for a row, mirroring _shared/ai-feature-gate.ts. */
function familyOf(row: UsageLogRow): string {
  const key = row.policy_key ?? "";
  const ns = key.split(".", 1)[0];
  if (ns === "tutoring" || ns === "grading" || ns === "analytics") return ns;
  if (ns === "question-bank" || ns === "study-guide" || ns === "materials") return "generation";
  if (ns === "moderation") return "safety screening";
  return row.feature ?? "other";
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // Student-controlled text (a profile name like "=1+1") must not execute
    // as a formula when the admin opens the file in a spreadsheet. Quoting
    // does not prevent that; a leading apostrophe does. Only strings — a
    // negative number is not a formula.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
}

const AiActivity = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const effectiveInstitutionId = sessionStorage.getItem("selectedInstitutionId");
  const { formatDateTime, formatNumber } = useFormatters();

  const [rangeDays, setRangeDays] = useState<string>("30");
  // The range the currently loaded rows were fetched with — the selector may
  // already point elsewhere while a refresh is in flight or has failed, and
  // the CSV filename must describe the data, not the selector.
  const [loadedRangeDays, setLoadedRangeDays] = useState<string>("30");
  const [rows, setRows] = useState<UsageLogRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [nameByUserId, setNameByUserId] = useState<Map<string, string>>(new Map());
  const [loadingData, setLoadingData] = useState(true);
  // Drops a fetch that a newer range selection has superseded.
  const fetchGeneration = useRef(0);

  useEffect(() => {
    const checkAccess = async () => {
      if (!user) return;
      if (!effectiveInstitutionId) {
        navigate("/select-institution");
        return;
      }
      const [{ data: isAdmin }, { data: isSuper }] = await Promise.all([
        supabase.rpc("is_institution_admin", {
          _user_id: user.id,
          _institution_id: effectiveInstitutionId,
        }),
        supabase.rpc("is_super_admin", { _user_id: user.id }),
      ]);
      if (!isAdmin && !isSuper) {
        toast.error("Access denied. Admins only.");
        navigate("/dashboard");
      }
    };

    if (!loading && !user) {
      navigate("/auth");
    } else if (user) {
      checkAccess();
    }
  }, [user, loading, navigate, effectiveInstitutionId]);

  const fetchData = useCallback(async () => {
    if (!effectiveInstitutionId) return;
    const generation = ++fetchGeneration.current;
    const isCurrent = () => fetchGeneration.current === generation;
    setLoadingData(true);
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - Number(rangeDays));

      const result = await fetchAllPages<UsageLogRow>(
        async (cursor) => {
          let query = supabase
            .from("ai_usage_logs")
            .select("*")
            .eq("institution_id", effectiveInstitutionId)
            .gte("created_at", startDate.toISOString())
            // `created_at` alone is not a total order — attempts of one call
            // share an instant — so `id` makes the cursor unambiguous.
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(PAGE_SIZE);
          if (cursor) {
            query = query.or(
              `created_at.lt."${cursor.created_at}",` +
                `and(created_at.eq."${cursor.created_at}",id.lt."${cursor.id}")`,
            );
          }
          return query;
        },
        { pageSize: PAGE_SIZE, maxRows: MAX_ROWS, shouldContinue: isCurrent },
      );
      if (!isCurrent() || result.aborted) return;
      setRows(result.rows);
      setTruncated(result.truncated);
      setLoadedRangeDays(rangeDays);

      // Names for "initiated by". Split query on purpose: ai_usage_logs
      // carries no FK to profiles, so a PostgREST embed cannot join them.
      const userIds = [...new Set(result.rows.map((r) => r.user_id).filter(Boolean))] as string[];
      if (userIds.length > 0) {
        const map = new Map<string, string>();
        // .in() lists go into the URL; chunk to keep it bounded.
        for (let i = 0; i < userIds.length; i += 200) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", userIds.slice(i, i + 200));
          for (const p of profiles ?? []) {
            map.set(p.user_id, p.full_name ?? p.email ?? p.user_id);
          }
        }
        if (!isCurrent()) return;
        setNameByUserId(map);
      } else {
        setNameByUserId(new Map());
      }
    } catch (error: unknown) {
      console.error("Error loading AI activity:", error);
      if (fetchGeneration.current === generation) {
        // Do not leave the previous range's rows behind a failed refresh —
        // an export taken now would carry data the selector no longer describes.
        setRows([]);
        setTruncated(false);
        toast.error("Failed to load AI activity");
      }
    } finally {
      if (fetchGeneration.current === generation) setLoadingData(false);
    }
  }, [effectiveInstitutionId, rangeDays]);

  useEffect(() => {
    if (user && effectiveInstitutionId) fetchData();
  }, [user, effectiveInstitutionId, fetchData]);

  const summary = useMemo(() => {
    const byFamily = new Map<string, number>();
    let totalTokens = 0;
    for (const r of rows) {
      byFamily.set(familyOf(r), (byFamily.get(familyOf(r)) ?? 0) + 1);
      totalTokens += r.total_tokens ?? 0;
    }
    return {
      calls: rows.length,
      totalTokens,
      byFamily: [...byFamily.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [rows]);

  const downloadCsv = () => {
    const csv = toCsv(
      rows.map((r) => ({
        created_at: r.created_at,
        function_name: r.function_name,
        family: familyOf(r),
        policy_key: r.policy_key,
        model: r.model,
        initiated_by: r.user_id ? nameByUserId.get(r.user_id) ?? r.user_id : "",
        user_id: r.user_id,
        course_id: r.course_id,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        total_tokens: r.total_tokens,
        response_time_ms: r.response_time_ms,
        outcome: r.outcome ?? r.status,
      })),
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const partial = truncated ? "-partial" : "";
    link.download = `ai-activity-${loadedRangeDays}d${partial}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <Bot className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-display font-bold">AI Activity</h1>
          </div>
          <div className="flex items-center gap-3">
            <Select value={rangeDays} onValueChange={setRangeDays}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={downloadCsv} disabled={loadingData || rows.length === 0} variant="outline">
              <Download className="h-4 w-4 mr-2" />
              Download CSV
            </Button>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8 space-y-8">
        <p className="text-sm text-muted-foreground max-w-3xl">
          Every AI request made for your school: who initiated it, when, which feature and
          model, and its token use. Usage records hold counts and context only — never a
          pupil's words. AI features can be switched off per family in Institution Settings
          on the dashboard.
        </p>

        {loadingData ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground font-normal">
                    AI requests
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-bold tabular-nums">
                  {formatNumber(summary.calls)}
                  {truncated && (
                    <span className="text-xs font-normal text-muted-foreground ml-2">
                      (first {formatNumber(MAX_ROWS)})
                    </span>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground font-normal">
                    Total tokens
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-bold tabular-nums">
                  {formatNumber(summary.totalTokens)}
                </CardContent>
              </Card>
              <Card className="col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground font-normal">
                    By feature family
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {summary.byFamily.length === 0 && (
                    <span className="text-sm text-muted-foreground">No activity in range</span>
                  )}
                  {summary.byFamily.map(([family, count]) => (
                    <Badge key={family} variant="secondary" className="tabular-nums">
                      {family}: {formatNumber(count)}
                    </Badge>
                  ))}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Most recent requests
                  {rows.length > TABLE_LIMIT && (
                    <span className="text-sm font-normal text-muted-foreground ml-2">
                      (latest {TABLE_LIMIT} of {formatNumber(rows.length)} —{" "}
                      {truncated
                        ? `the CSV holds these newest ${formatNumber(rows.length)} only; older activity in this range exceeded the export cap`
                        : "the CSV has all of them"})
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Feature</TableHead>
                        <TableHead>Family</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead>Initiated by</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead>Outcome</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, TABLE_LIMIT).map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap text-sm">
                            {formatDateTime(r.created_at)}
                          </TableCell>
                          <TableCell className="text-sm">{r.function_name}</TableCell>
                          <TableCell className="text-sm">{familyOf(r)}</TableCell>
                          <TableCell className="text-sm">{r.model}</TableCell>
                          <TableCell className="text-sm">
                            {r.user_id
                              ? nameByUserId.get(r.user_id) ?? (
                                <span className="text-muted-foreground">unknown</span>
                              )
                              : <span className="text-muted-foreground">system</span>}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {formatNumber(r.total_tokens ?? 0)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {(r.outcome ?? r.status) === "success" || r.status === "success" ? (
                              <Badge variant="outline">success</Badge>
                            ) : (
                              <Badge variant="secondary">{r.outcome ?? r.status ?? "—"}</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {rows.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            No AI activity in the selected range.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
};

export default AiActivity;
