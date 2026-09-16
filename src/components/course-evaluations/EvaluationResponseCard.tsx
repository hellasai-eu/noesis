/**
 * EvaluationResponseCard (#669) — renders a single evaluator's full response
 * for one question in the drill-in view. Read-only; mirrors the field order of
 * the evaluator-facing rubric form so reviewers can read across the two
 * surfaces without cognitive overhead.
 */
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  COGNITIVE_LEVEL_OPTIONS,
  DIFFICULTY_OPTIONS,
  PROBLEM_CATEGORIES,
  RATING_QUESTIONS,
  VERDICT_OPTIONS,
  YES_NO_QUESTIONS,
  type CognitiveLevelCode,
  type DifficultyCode,
  type ProblemCategoryCode,
  type VerdictCode,
} from "@/components/evaluator/rubric";
import { CheckCircle2, XCircle } from "lucide-react";
import type { EvaluationRow } from "./aggregate";
import { useFormatters } from "@/i18n/formatters";

interface EvaluationResponseCardProps {
  row: EvaluationRow;
  evaluatorName: string;
}

function labelFor<T extends string>(
  options: ReadonlyArray<{ code: T; label: string }>,
  code: string | null,
): string {
  if (!code) return "—";
  return options.find((o) => o.code === code)?.label ?? code;
}

const VERDICT_BADGE_VARIANT: Record<VerdictCode, string> = {
  good: "bg-green-500/10 text-green-700 border-green-500/30",
  needs_fixing: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  reject: "bg-red-500/10 text-red-700 border-red-500/30",
};

export function EvaluationResponseCard({
  row,
  evaluatorName,
}: EvaluationResponseCardProps) {
  const { formatDate } = useFormatters();
  const verdict = row.verdict as VerdictCode;
  const verdictClass =
    VERDICT_BADGE_VARIANT[verdict] ??
    "bg-muted text-muted-foreground border-muted-foreground/20";
  const createdAt = formatDate(row.created_at);

  return (
    <Card data-testid={`response-card-${row.id}`}>
      <CardContent className="pt-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium text-sm">{evaluatorName}</div>
          <div className="text-xs text-muted-foreground">{createdAt}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={verdictClass}>
            {labelFor(VERDICT_OPTIONS, verdict)}
          </Badge>
          <Badge variant="outline" className="text-xs">
            Δυσκολία:{" "}
            {labelFor(
              DIFFICULTY_OPTIONS,
              row.difficulty_confirmation as DifficultyCode,
            )}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {YES_NO_QUESTIONS.map((q) => {
            const v = row[q.key];
            return (
              <div
                key={q.key}
                className="flex items-center gap-2 text-sm"
                data-testid={`yesno-${row.id}-${q.key}`}
              >
                {v ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-600 shrink-0" />
                )}
                <span>{q.label}</span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {RATING_QUESTIONS.map((r) => {
            // Specialist ratings are NULL on un-sampled rows (#678). Show a
            // dash so a reader can tell "not rated" apart from a rating of 1.
            const value = row[r.key];
            return (
              <div
                key={r.key}
                className="border rounded-md px-2 py-1.5 flex items-center justify-between gap-2"
                data-testid={`rating-${row.id}-${r.key}`}
              >
                <span className="text-xs text-muted-foreground">{r.label}</span>
                <span className="text-sm font-medium tabular-nums">
                  {value ?? "—"}
                </span>
              </div>
            );
          })}
        </div>

        {row.problem_categories && row.problem_categories.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              Προβλήματα
            </div>
            <div className="flex flex-wrap gap-1">
              {row.problem_categories.map((code) => (
                <Badge
                  key={code}
                  variant="outline"
                  className="text-xs bg-amber-500/5"
                >
                  {labelFor(PROBLEM_CATEGORIES, code as ProblemCategoryCode)}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {row.comment && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              Σχόλιο
            </div>
            <div className="text-sm whitespace-pre-wrap">{row.comment}</div>
          </div>
        )}

        {row.was_sampled && row.cognitive_level && (
          <div className="text-sm">
            <span className="text-xs text-muted-foreground mr-2">
              Γνωστικό επίπεδο:
            </span>
            {labelFor(
              COGNITIVE_LEVEL_OPTIONS,
              row.cognitive_level as CognitiveLevelCode,
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
