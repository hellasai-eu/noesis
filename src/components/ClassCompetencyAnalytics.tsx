import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  Cell,
} from "recharts";
import { Loader2, BarChart2, GraduationCap, School } from "lucide-react";
import { toast } from "sonner";
import { buildClassDisplayName } from "@/lib/greek-school";

interface ClassOption {
  id: string;
  name?: string | null;
  grade_level_id?: string | null;
  section_name?: string | null;
  category?: string | null;
  is_active?: boolean;
}

interface CompetencyAggregate {
  competencyId: string;
  title: string;
  avgScore: number | null;
  evaluatedCount: number;
  nullCount: number;
  missingCount: number;
  totalStudents: number;
  lowCount: number;
  midCount: number;
  highCount: number;
}

interface ClassCompetencyAnalyticsProps {
  courseId: string;
  classes: ClassOption[];
  selectedClassId?: string | null;
  showSelector?: boolean;
  title?: string;
  description?: string;
}

const ALL_SECTIONS_VALUE = "__all__";

const scoreBadgeVariant = (score: number): "default" | "secondary" | "destructive" => {
  if (score >= 70) return "default";
  if (score >= 40) return "secondary";
  return "destructive";
};

export function ClassCompetencyAnalytics({
  courseId,
  classes,
  selectedClassId,
  showSelector = true,
  title = "Class Competency Analytics",
  description = "Average competency scores across student evaluations for the selected section.",
}: ClassCompetencyAnalyticsProps) {
  const pinned = selectedClassId !== undefined;
  const [internalClassId, setInternalClassId] = useState<string>(ALL_SECTIONS_VALUE);
  const [loading, setLoading] = useState(true);
  const [aggregates, setAggregates] = useState<CompetencyAggregate[]>([]);
  const [totalStudents, setTotalStudents] = useState(0);
  const [evaluatedStudents, setEvaluatedStudents] = useState(0);

  const activeClassId = pinned
    ? selectedClassId ?? null
    : internalClassId === ALL_SECTIONS_VALUE
      ? null
      : internalClassId;

  const activeClassIds = useMemo(() => {
    if (activeClassId) return [activeClassId];
    return classes.map((c) => c.id);
  }, [activeClassId, classes]);

  const activeClassIdsKey = activeClassIds.join("|");

  useEffect(() => {
    let cancelled = false;

    async function fetchAnalytics() {
      setLoading(true);
      try {
        if (activeClassIds.length === 0) {
          if (!cancelled) {
            setAggregates([]);
            setTotalStudents(0);
            setEvaluatedStudents(0);
          }
          return;
        }

        const { data: enrollmentData, error: enrollmentError } = await supabase
          .from("class_enrollments")
          .select("user_id")
          .in("class_id", activeClassIds)
          .eq("role", "student");
        if (enrollmentError) throw enrollmentError;

        const studentIds = Array.from(
          new Set((enrollmentData || []).map((e) => e.user_id)),
        );

        const { data: competencyData, error: competencyError } = await supabase
          .from("course_competencies")
          .select("id, title, order_num")
          .eq("course_id", courseId)
          .order("order_num");
        if (competencyError) throw competencyError;
        const competencies = competencyData || [];

        if (studentIds.length === 0) {
          if (!cancelled) {
            setAggregates(
              competencies.map((c) => ({
                competencyId: c.id,
                title: c.title,
                avgScore: null,
                evaluatedCount: 0,
                nullCount: 0,
                missingCount: 0,
                totalStudents: 0,
                lowCount: 0,
                midCount: 0,
                highCount: 0,
              })),
            );
            setTotalStudents(0);
            setEvaluatedStudents(0);
          }
          return;
        }

        const { data: evaluationData, error: evaluationError } = await supabase
          .from("student_evaluations")
          .select("id, user_id, generated_at")
          .eq("course_id", courseId)
          .in("user_id", studentIds)
          .order("generated_at", { ascending: false });
        if (evaluationError) throw evaluationError;

        // Pick the latest evaluation per user.
        const latestEvaluationByUser = new Map<string, string>();
        for (const row of evaluationData || []) {
          if (!latestEvaluationByUser.has(row.user_id)) {
            latestEvaluationByUser.set(row.user_id, row.id);
          }
        }
        const latestEvaluationIds = Array.from(latestEvaluationByUser.values());

        const scoresByCompetency = new Map<
          string,
          { score: number | null }[]
        >();
        if (latestEvaluationIds.length > 0) {
          const { data: scoresData, error: scoresError } = await supabase
            .from("evaluation_competency_scores")
            .select("evaluation_id, competency_id, score")
            .in("evaluation_id", latestEvaluationIds);
          if (scoresError) throw scoresError;

          for (const s of scoresData || []) {
            const list = scoresByCompetency.get(s.competency_id) || [];
            list.push({ score: s.score });
            scoresByCompetency.set(s.competency_id, list);
          }
        }

        const evaluatedUserIds = new Set(latestEvaluationByUser.keys());

        


        const computed: CompetencyAggregate[] = competencies.map((c) => {
          const entries = scoresByCompetency.get(c.id) || [];
          let evaluatedCount = 0;
          let nullCount = 0;
          let scoreSum = 0;
          let lowCount = 0;
          let midCount = 0;
          let highCount = 0;

          for (const entry of entries) {
            if (entry.score === null || entry.score === undefined) {
              nullCount += 1;
              continue;
            }
            const numeric = Number(entry.score);
            if (Number.isNaN(numeric)) {
              nullCount += 1;
              continue;
            }
            evaluatedCount += 1;
            scoreSum += numeric;
            if (numeric < 40) lowCount += 1;
            else if (numeric < 70) midCount += 1;
            else highCount += 1;
          }

          // Students whose latest evaluation produced no row for this
          // competency (plus students who have no evaluation at all).
          const missingCount = studentIds.length - entries.length;

          return {
            competencyId: c.id,
            title: c.title,
            avgScore: evaluatedCount > 0 ? Math.round(scoreSum / evaluatedCount) : null,
            evaluatedCount,
            nullCount,
            missingCount,
            totalStudents: studentIds.length,
            lowCount,
            midCount,
            highCount,
          };
        });

        if (!cancelled) {
          setAggregates(computed);
          setTotalStudents(studentIds.length);
          setEvaluatedStudents(evaluatedUserIds.size);
        }
      } catch (error) {
        console.error("Error loading class competency analytics:", error);
        if (!cancelled) {
          toast.error("Failed to load competency analytics");
          setAggregates([]);
          setTotalStudents(0);
          setEvaluatedStudents(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAnalytics();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeClassIdsKey captures array membership
  }, [courseId, activeClassIdsKey]);

  const selectedClass = activeClassId
    ? classes.find((c) => c.id === activeClassId)
    : null;
  const scopeLabel = selectedClass
    ? buildClassDisplayName(selectedClass)
    : "All sections";

  const barData = useMemo(
    () =>
      aggregates
        .filter((a) => a.avgScore !== null)
        .map((a) => ({
          title: a.title.length > 40 ? a.title.slice(0, 37) + "…" : a.title,
          fullTitle: a.title,
          score: a.avgScore as number,
        })),
    [aggregates],
  );

  const hasCompetencies = aggregates.length > 0;
  const hasAnyEvaluations = aggregates.some(
    (a) => a.evaluatedCount > 0 || a.nullCount > 0,
  );
  const omittedFromChart = aggregates.filter((a) => a.avgScore === null).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BarChart2 className="w-5 h-5" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <GraduationCap className="w-3 h-3" />
              {scopeLabel}
            </Badge>
            <Badge variant="outline">
              {evaluatedStudents}/{totalStudents} students evaluated
            </Badge>
          </div>
        </div>
        {showSelector && !pinned && classes.length > 0 && (
          <div className="flex items-center gap-2 pt-2">
            <School className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Section:</span>
            <Select value={internalClassId} onValueChange={setInternalClassId}>
              <SelectTrigger className="w-[220px] h-8">
                <SelectValue placeholder="Select section" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SECTIONS_VALUE}>All sections</SelectItem>
                {classes.map((cls) => (
                  <SelectItem key={cls.id} value={cls.id}>
                    {buildClassDisplayName(cls)}
                    {cls.is_active === false ? " (inactive)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : !hasCompetencies ? (
          <EmptyState
            title="No competencies defined"
            message="Define competencies for this course to see class-level analytics."
          />
        ) : !hasAnyEvaluations ? (
          <EmptyState
            title="No evaluation data yet"
            message="Generate student evaluations with competency scores to populate this view."
          />
        ) : (
          <div className="space-y-6">
            {barData.length > 0 && (
              <div style={{ height: Math.max(200, barData.length * 44) }} className="w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barData} layout="vertical" margin={{ left: 20, right: 30, top: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
                    <YAxis
                      type="category"
                      dataKey="title"
                      width={250}
                      tick={{ fontSize: 11 }}
                    />
                    <RechartsTooltip
                      formatter={(value: number, _name: string, props: any) => [
                        `${value}/100`,
                        props.payload?.fullTitle || "Class average",
                      ]}
                    />
                    <Bar dataKey="score" radius={[0, 4, 4, 0]} maxBarSize={28}>
                      {barData.map((entry, index) => (
                        <Cell
                          key={index}
                          fill={
                            entry.score >= 70
                              ? "hsl(142, 71%, 45%)"
                              : entry.score >= 40
                              ? "hsl(38, 92%, 50%)"
                              : "hsl(0, 84%, 60%)"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {omittedFromChart > 0 && (
              <p className="text-xs text-muted-foreground -mt-2">
                {omittedFromChart === 1
                  ? "1 competency with no scored evaluations is not shown in the chart."
                  : `${omittedFromChart} competencies with no scored evaluations are not shown in the chart.`}
              </p>
            )}

            <TooltipProvider delayDuration={200}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Competency</TableHead>
                    <TableHead className="w-[110px]">Average</TableHead>
                    <TableHead>Distribution</TableHead>
                    <TableHead className="w-[100px] text-right">Evaluated</TableHead>
                    <TableHead className="w-[90px] text-right">No data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {aggregates.map((row) => (
                    <TableRow key={row.competencyId}>
                      <TableCell className="font-medium">{row.title}</TableCell>
                      <TableCell>
                        {row.avgScore !== null ? (
                          <Badge variant={scoreBadgeVariant(row.avgScore)}>
                            {row.avgScore}/100
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-muted-foreground">
                            —
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DistributionBar
                          low={row.lowCount}
                          mid={row.midCount}
                          high={row.highCount}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.evaluatedCount}/{row.totalStudents}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help text-muted-foreground">
                              {row.nullCount + row.missingCount}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="text-xs space-y-0.5">
                              <div>
                                Insufficient data:{" "}
                                <span className="font-medium">{row.nullCount}</span>
                              </div>
                              <div>
                                Not yet evaluated:{" "}
                                <span className="font-medium">{row.missingCount}</span>
                              </div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TooltipProvider>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <BarChart2 className="w-10 h-10 text-muted-foreground mb-3" />
      <h3 className="text-base font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-md">{message}</p>
    </div>
  );
}

function DistributionBar({ low, mid, high }: { low: number; mid: number; high: number }) {
  const total = low + mid + high;
  if (total === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const pct = (n: number) => (n / total) * 100;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-2 w-full max-w-[180px] overflow-hidden rounded-full bg-muted">
          {low > 0 && (
            <div
              className="bg-destructive"
              style={{ width: `${pct(low)}%` }}
              aria-label={`${low} below 40`}
            />
          )}
          {mid > 0 && (
            <div
              className="bg-amber-500"
              style={{ width: `${pct(mid)}%` }}
              aria-label={`${mid} 40–69`}
            />
          )}
          {high > 0 && (
            <div
              className="bg-emerald-500"
              style={{ width: `${pct(high)}%` }}
              aria-label={`${high} 70+`}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs space-y-0.5">
          <div>
            <span className="inline-block w-2 h-2 rounded-sm bg-destructive mr-1.5" />
            {"< 40"}: <span className="font-medium">{low}</span>
          </div>
          <div>
            <span className="inline-block w-2 h-2 rounded-sm bg-amber-500 mr-1.5" />
            40–69: <span className="font-medium">{mid}</span>
          </div>
          <div>
            <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500 mr-1.5" />
            {"≥ 70"}: <span className="font-medium">{high}</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export default ClassCompetencyAnalytics;
