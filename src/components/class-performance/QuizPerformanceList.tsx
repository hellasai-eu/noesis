/**
 * Read-only quiz roster for My Class → Class Performance → Quiz.
 *
 * Deliberately not the QuizManager: no builder, no assignment, no
 * publish/delete — this surface answers one question, "how did each quiz
 * go?", so it lists only assigned quizzes (the loader drops unassigned
 * drafts — they have no performance to show) and every row leads to the
 * same QuizResultsDialog the manager's results action opens. Creation and
 * assignment stay under Assessments. Data comes through
 * `useQuizPerformance` (pure loader + React Query), the surface pattern.
 */
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, BarChart2, ClipboardList, Loader2 } from "lucide-react";
import { useQuizPerformance } from "@/hooks/useClassPerformanceSurface";
import type { QuizPerformanceRow } from "@/lib/class-performance-surface";
import { QuizResultsDialog } from "@/components/quiz/QuizResultsDialog";
import {
  ClassFilterSelect,
  type PerformanceClass,
} from "@/components/class-performance/ClassFilterSelect";

interface QuizPerformanceListProps {
  courseId: string;
  /** The course's classes, for the section filter over assignment targets. */
  classes: PerformanceClass[];
}

export const QuizPerformanceList = ({ courseId, classes }: QuizPerformanceListProps) => {
  const { data: rows, isPending, isError } = useQuizPerformance(courseId);
  const [reportQuiz, setReportQuiz] = useState<QuizPerformanceRow | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string>("all");

  // A selection that no longer resolves (the class list refreshed and the id
  // is gone) falls back to "all" in the trigger too, not just in the rows.
  const selectedClass =
    selectedClassId !== "all"
      ? classes.find((c) => c.id === selectedClassId)
      : undefined;
  const effectiveClassId = selectedClass ? selectedClassId : "all";
  const selectedOfferingId = selectedClass?.offering_id;

  // Section-aware view: with a class selected, only quizzes assigned to that
  // class's offering remain, and each row shows just that class's targets.
  const visibleRows = useMemo(() => {
    if (!rows) return [];
    if (!selectedOfferingId) return rows;
    return rows
      .map((row) => ({
        ...row,
        targets: row.targets.filter((t) => t.offeringId === selectedOfferingId),
      }))
      .filter((row) => row.targets.length > 0);
  }, [rows, selectedOfferingId]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="w-5 h-5" />
              Quiz Performance
            </CardTitle>
            <CardDescription>
              Every assigned quiz in this course, with a shortcut to its per-student
              analytics. Create and assign quizzes under Assessments.
            </CardDescription>
          </div>
          <ClassFilterSelect
            classes={classes}
            value={effectiveClassId}
            onChange={setSelectedClassId}
          />
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <p className="flex items-center gap-2 text-sm text-destructive py-4">
            <AlertTriangle className="w-4 h-4" />
            Could not load the quizzes — reload the page to try again.
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            {selectedOfferingId
              ? "No quizzes assigned to this class yet."
              : "No quizzes assigned yet — assign one under Assessments → Quizzes (Online)."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quiz</TableHead>
                <TableHead>Questions</TableHead>
                <TableHead>Assigned to</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Analytics</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => {
                const liveCount = row.targets.filter((t) => !t.done).length;
                const doneCount = row.targets.length - liveCount;
                return (
                  <TableRow key={row.id} data-testid={`quiz-performance-row-${row.id}`}>
                    <TableCell className="font-medium">{row.title}</TableCell>
                    <TableCell>{row.questionCount}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {row.targets.map((t, i) => (
                          <Badge key={i} variant="outline">{t.label}</Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {liveCount > 0 && <Badge>Live × {liveCount}</Badge>}
                        {doneCount > 0 && <Badge variant="secondary">Done × {doneCount}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setReportQuiz(row)}
                      >
                        <BarChart2 className="w-4 h-4 mr-1" />
                        See analytics
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <QuizResultsDialog
        open={!!reportQuiz}
        onOpenChange={(open) => !open && setReportQuiz(null)}
        quizId={reportQuiz?.id ?? null}
        courseId={courseId}
        quizTitle={reportQuiz?.title ?? ""}
        initialTab="students"
      />
    </Card>
  );
};
