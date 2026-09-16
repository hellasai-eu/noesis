/**
 * Read-only study guide roster for My Class → Class Performance → Study Guides.
 *
 * Deliberately not the StudyGuideManager: no outline builder, no assignment,
 * no deletion — this surface answers "how did each guide go?", so it lists
 * only assigned guides (the loader drops unassigned ones — they have no
 * performance to show) and every row leads to the same
 * StudyGuideResultsDialog the manager's results action opens. Creation and
 * assignment stay under AI Tutoring → Study Guides. Data comes through
 * `useStudyGuidePerformance` (pure loader + React Query), the surface
 * pattern.
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
import { AlertTriangle, BarChart2, BookText, Loader2 } from "lucide-react";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useStudyGuidePerformance } from "@/hooks/useClassPerformanceSurface";
import type { GuidePerformanceRow } from "@/lib/class-performance-surface";
import { StudyGuideResultsDialog } from "@/components/study-guide/StudyGuideResultsDialog";
import {
  ClassFilterSelect,
  type PerformanceClass,
} from "@/components/class-performance/ClassFilterSelect";

interface StudyGuidePerformanceListProps {
  courseId: string;
  /** The course's classes, for labelling assignment targets by offering. */
  classes: PerformanceClass[];
}

export const StudyGuidePerformanceList = ({
  courseId,
  classes,
}: StudyGuidePerformanceListProps) => {
  const classLabelByOffering = useMemo(
    () =>
      Object.fromEntries(classes.map((c) => [c.offering_id, buildClassDisplayName(c)])),
    [classes],
  );
  const { data: rows, isPending, isError } = useStudyGuidePerformance(
    courseId,
    classLabelByOffering,
  );
  const [resultsGuide, setResultsGuide] = useState<GuidePerformanceRow | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string>("all");

  // A selection that no longer resolves (the class list refreshed and the id
  // is gone) falls back to "all" in the trigger too, not just in the rows.
  const selectedClass =
    selectedClassId !== "all"
      ? classes.find((c) => c.id === selectedClassId)
      : undefined;
  const effectiveClassId = selectedClass ? selectedClassId : "all";
  const selectedOfferingId = selectedClass?.offering_id;

  // Section-aware view: with a class selected, only guides assigned to that
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
              <BookText className="w-5 h-5" />
              Study Guide Performance
            </CardTitle>
            <CardDescription>
              Every assigned study guide in this course, with a shortcut to its results
              and class analysis. Create and assign guides under AI Tutoring → Study Guides.
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
            Could not load the study guides — reload the page to try again.
          </p>
        ) : visibleRows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            {selectedOfferingId
              ? "No study guides assigned to this class yet."
              : "No study guides assigned yet — assign one under AI Tutoring → Study Guides."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Study guide</TableHead>
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
                  <TableRow key={row.id} data-testid={`guide-performance-row-${row.id}`}>
                    <TableCell className="font-medium">{row.title}</TableCell>
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
                        onClick={() => setResultsGuide(row)}
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

      <StudyGuideResultsDialog
        open={!!resultsGuide}
        onOpenChange={(open) => !open && setResultsGuide(null)}
        studyGuideId={resultsGuide?.id ?? null}
        courseId={courseId}
        studyGuideTitle={resultsGuide?.title ?? ""}
        initialTab="students"
      />
    </Card>
  );
};
