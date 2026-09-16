/**
 * Sessions view of the course evaluations report (#669).
 *
 * Lists one row per `question_evaluation_sessions` ordered newest-first,
 * showing the evaluator, dates, summary fields, and how many evaluations
 * were recorded during that session. Read-only.
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { WOULD_USE_OPTIONS, type WouldUseCode } from "@/components/evaluator/rubric";
import type { Database } from "@/integrations/supabase/database-additions";
import { useFormatters } from "@/i18n/formatters";

export type SessionRow =
  Database["public"]["Tables"]["question_evaluation_sessions"]["Row"];

interface CourseEvaluationsSessionsTabProps {
  sessions: SessionRow[];
  evaluatorNameById: Map<string, string>;
  /** Map of session_id → number of question_evaluations recorded in it. */
  evaluationsCountBySession: Map<string, number>;
}

function wouldUseLabel(code: string | null): string {
  if (!code) return "—";
  return (
    WOULD_USE_OPTIONS.find((o) => o.code === (code as WouldUseCode))?.label ??
    code
  );
}

export function CourseEvaluationsSessionsTab({
  sessions,
  evaluatorNameById,
  evaluationsCountBySession,
}: CourseEvaluationsSessionsTabProps) {
  const { formatDateTime } = useFormatters();
  const fmtDate = (value: string | null) => formatDateTime(value);
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Evaluator</TableHead>
              <TableHead className="w-40">Started</TableHead>
              <TableHead className="w-40">Ended</TableHead>
              <TableHead className="w-28">Overall (1–5)</TableHead>
              <TableHead className="w-40">Would use</TableHead>
              <TableHead>Recurring problems</TableHead>
              <TableHead className="w-24">Evals</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center text-sm text-muted-foreground py-10"
                >
                  Δεν υπάρχουν συνεδρίες αξιολόγησης ακόμη.
                </TableCell>
              </TableRow>
            )}
            {sessions.map((s) => (
              <TableRow key={s.id} data-testid={`session-row-${s.id}`}>
                <TableCell className="text-sm">
                  {evaluatorNameById.get(s.evaluator_id) ?? "Unknown"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {fmtDate(s.started_at)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {s.ended_at ? (
                    fmtDate(s.ended_at)
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      In progress
                    </Badge>
                  )}
                </TableCell>
                <TableCell
                  className="font-medium tabular-nums"
                  data-testid={`overall-${s.id}`}
                >
                  {s.overall_quality ?? "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {wouldUseLabel(s.would_use)}
                </TableCell>
                <TableCell
                  className="text-sm max-w-md"
                  data-testid={`recurring-${s.id}`}
                >
                  {s.recurring_problems ? (
                    <div className="line-clamp-2 whitespace-pre-wrap">
                      {s.recurring_problems}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {evaluationsCountBySession.get(s.id) ?? 0}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
