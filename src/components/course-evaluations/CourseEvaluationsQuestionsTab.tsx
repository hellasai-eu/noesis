/**
 * Per-question view of the course evaluations report (#669).
 *
 * Pure presentation: receives the already-loaded questions + evaluations from
 * the parent and renders the filterable/sortable table. Drill-in opens a
 * dialog that re-uses `QuestionExpandedPanel` (with isAdmin=false to suppress
 * the question-bank write affordances) and renders each evaluator's full
 * response via `EvaluationResponseCard`.
 *
 * Read-only by construction — no Supabase mutation calls in this component.
 */
import { useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  PROBLEM_CATEGORIES,
  VERDICT_OPTIONS,
  type ProblemCategoryCode,
  type VerdictCode,
} from "@/components/evaluator/rubric";
import { QuestionExpandedPanel } from "@/components/question-bank/expanded";
import { TypeBadge } from "@/components/UnifiedQuestionsTable";
import type { UnifiedQuestion } from "@/lib/unified-question";
import { EvaluationResponseCard } from "./EvaluationResponseCard";
import type { EvaluationRow, QuestionAggregate } from "./aggregate";

type SortKey = "avgScore" | "evaluatorCount";
type SortDir = "asc" | "desc";

interface CourseEvaluationsQuestionsTabProps {
  questions: UnifiedQuestion[];
  rowsByQuestionId: Map<string, EvaluationRow[]>;
  aggregatesByQuestionId: Map<string, QuestionAggregate>;
  evaluatorNameById: Map<string, string>;
}

const VERDICT_PILL_CLASS: Record<VerdictCode, string> = {
  good: "bg-green-500/10 text-green-700 border-green-500/30",
  needs_fixing: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  reject: "bg-red-500/10 text-red-700 border-red-500/30",
};

function problemLabel(code: ProblemCategoryCode): string {
  return PROBLEM_CATEGORIES.find((c) => c.code === code)?.label ?? code;
}

function verdictLabel(code: VerdictCode): string {
  return VERDICT_OPTIONS.find((o) => o.code === code)?.label ?? code;
}

export function CourseEvaluationsQuestionsTab({
  questions,
  rowsByQuestionId,
  aggregatesByQuestionId,
  evaluatorNameById,
}: CourseEvaluationsQuestionsTabProps) {
  const [verdictFilter, setVerdictFilter] = useState<"all" | VerdictCode>("all");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("avgScore");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [openQuestionId, setOpenQuestionId] = useState<string | null>(null);

  // Only show questions that have at least one evaluation. The drilled-in
  // dialog reads from the same maps so the open state can index by id.
  const evaluatedQuestions = useMemo(() => {
    return questions.filter((q) => aggregatesByQuestionId.has(q.id));
  }, [questions, aggregatesByQuestionId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return evaluatedQuestions.filter((q) => {
      const agg = aggregatesByQuestionId.get(q.id);
      if (!agg) return false;
      if (verdictFilter !== "all" && agg.majorityVerdict !== verdictFilter) {
        return false;
      }
      if (onlyFlagged && agg.flaggedProblems.length === 0) {
        return false;
      }
      if (needle && !q.searchText.toLowerCase().includes(needle)) {
        return false;
      }
      return true;
    });
  }, [evaluatedQuestions, aggregatesByQuestionId, verdictFilter, onlyFlagged, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const aa = aggregatesByQuestionId.get(a.id);
      const bb = aggregatesByQuestionId.get(b.id);
      if (!aa || !bb) return 0;
      const av = sortKey === "avgScore" ? aa.overallAverage : aa.evaluatorCount;
      const bv = sortKey === "avgScore" ? bb.overallAverage : bb.evaluatorCount;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [filtered, aggregatesByQuestionId, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="w-3 h-3 inline ml-1" />;
    return sortDir === "asc" ? (
      <ArrowUp className="w-3 h-3 inline ml-1" />
    ) : (
      <ArrowDown className="w-3 h-3 inline ml-1" />
    );
  };

  const openQuestion = openQuestionId
    ? questions.find((q) => q.id === openQuestionId) ?? null
    : null;
  const openRows = openQuestionId
    ? rowsByQuestionId.get(openQuestionId) ?? []
    : [];

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-end gap-3"
        data-testid="evaluations-filters"
      >
        <div className="flex-1 min-w-[200px]">
          <Label htmlFor="evals-search" className="text-xs">
            Αναζήτηση
          </Label>
          <Input
            id="evals-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by question text…"
            data-testid="evals-search"
          />
        </div>
        <div className="w-[240px]">
          <Label className="text-xs">Verdict</Label>
          <Select
            value={verdictFilter}
            onValueChange={(v) => setVerdictFilter(v as typeof verdictFilter)}
          >
            <SelectTrigger data-testid="verdict-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Όλες</SelectItem>
              {VERDICT_OPTIONS.map((opt) => (
                <SelectItem key={opt.code} value={opt.code}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-1">
          <Switch
            id="only-flagged"
            checked={onlyFlagged}
            onCheckedChange={setOnlyFlagged}
            data-testid="only-flagged-toggle"
          />
          <Label htmlFor="only-flagged" className="cursor-pointer text-sm">
            Με σημειωμένα προβλήματα
          </Label>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Question</TableHead>
                <TableHead className="w-24">Type</TableHead>
                <TableHead className="w-44">Verdicts</TableHead>
                <TableHead>Flagged problems</TableHead>
                <TableHead
                  className="w-28 cursor-pointer select-none"
                  onClick={() => toggleSort("avgScore")}
                  data-testid="sort-avg-score"
                >
                  Avg score{sortIcon("avgScore")}
                </TableHead>
                <TableHead
                  className="w-24 cursor-pointer select-none"
                  onClick={() => toggleSort("evaluatorCount")}
                  data-testid="sort-evaluator-count"
                >
                  Evaluators{sortIcon("evaluatorCount")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-sm text-muted-foreground py-10"
                  >
                    Δεν υπάρχουν αξιολογήσεις που να ταιριάζουν με τα φίλτρα.
                  </TableCell>
                </TableRow>
              )}
              {sorted.map((q, idx) => {
                const agg = aggregatesByQuestionId.get(q.id);
                if (!agg) return null;
                return (
                  <TableRow
                    key={q.id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setOpenQuestionId(q.id)}
                    data-testid={`evaluations-row-${q.id}`}
                  >
                    <TableCell className="text-xs text-muted-foreground">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="line-clamp-2 text-sm">{q.preview}</div>
                    </TableCell>
                    <TableCell>
                      <TypeBadge type={q.type} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(["good", "needs_fixing", "reject"] as VerdictCode[]).map(
                          (v) => {
                            const n = agg.verdictCounts[v];
                            if (n === 0) return null;
                            return (
                              <Badge
                                key={v}
                                variant="outline"
                                className={`text-[10px] ${VERDICT_PILL_CLASS[v]}`}
                                data-testid={`verdict-count-${q.id}-${v}`}
                              >
                                {verdictLabel(v)} · {n}
                              </Badge>
                            );
                          },
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {agg.flaggedProblems.slice(0, 3).map((code) => (
                          <Badge
                            key={code}
                            variant="outline"
                            className="text-[10px] bg-amber-500/5"
                          >
                            {problemLabel(code)}
                          </Badge>
                        ))}
                        {agg.flaggedProblems.length > 3 && (
                          <Badge variant="outline" className="text-[10px]">
                            +{agg.flaggedProblems.length - 3}
                          </Badge>
                        )}
                        {agg.flaggedProblems.length === 0 && (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className="font-medium tabular-nums"
                      data-testid={`avg-score-${q.id}`}
                    >
                      {agg.overallAverage.toFixed(1)}
                    </TableCell>
                    <TableCell
                      className="tabular-nums"
                      data-testid={`evaluator-count-${q.id}`}
                    >
                      {agg.evaluatorCount}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={!!openQuestionId}
        onOpenChange={(o) => !o && setOpenQuestionId(null)}
      >
        <DialogContent
          className="max-w-4xl max-h-[90vh] overflow-y-auto"
          data-testid="evaluation-drill-dialog"
        >
          <DialogHeader>
            <DialogTitle>Αξιολογήσεις ερώτησης</DialogTitle>
          </DialogHeader>
          {openQuestion && (
            <div className="space-y-6">
              <Card>
                <CardContent className="pt-6">
                  <QuestionExpandedPanel
                    question={openQuestion}
                    onClose={() => {
                      /* no-op — the dialog owns close */
                    }}
                    isAdmin={false}
                  />
                </CardContent>
              </Card>

              <div className="space-y-3">
                <div className="text-sm font-medium text-muted-foreground">
                  Απαντήσεις αξιολογητών ({openRows.length})
                </div>
                {openRows.map((r) => (
                  <EvaluationResponseCard
                    key={r.id}
                    row={r}
                    evaluatorName={
                      evaluatorNameById.get(r.evaluator_id) ?? "Unknown"
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
