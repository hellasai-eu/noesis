/**
 * #776 — Serial random-run host for the unified practice list.
 *
 * Walks the student through a pre-selected sequence of practice questions
 * (built by `pickRandomRun`), one at a time, via `PracticeAnsweringDispatcher`.
 * Shows progress at the top, lets the student exit early, and ends with a
 * summary card listing per-question outcomes.
 */
import { useCallback, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, XCircle, Circle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatQuestionText } from "@/lib/latex-utils";
import type { QuestionType } from "@/types/question";
import type {
  StudentPracticeQuestion,
  StudentPracticeStatus,
} from "@/hooks/useStudentPracticeQuestions";
import {
  PracticeAnsweringDispatcher,
} from "./PracticeAnsweringDispatcher";
import type {
  SinglePanelCompletion,
} from "@/components/student-answering";
import "katex/dist/katex.min.css";

interface Props {
  courseId: string;
  questionsInRun: StudentPracticeQuestion[];
  onExit: () => void;
  onQuestionStatusChange?: (
    question: StudentPracticeQuestion,
    status: StudentPracticeStatus,
  ) => void;
  onRunComplete?: () => void;
}

interface RunResult {
  questionId: string;
  completion: SinglePanelCompletion;
}

// Same palette as the list — keep summary rows visually aligned with the list rows.
const TYPE_BADGE_CLASS: Record<QuestionType, string> = {
  mcq: "bg-violet-500/15 text-violet-700 border-transparent hover:bg-violet-500/15",
  open: "bg-indigo-500/15 text-indigo-700 border-transparent hover:bg-indigo-500/15",
  fill_gaps:
    "bg-amber-500/15 text-amber-800 border-transparent hover:bg-amber-500/15",
  ordering: "bg-sky-500/15 text-sky-700 border-transparent hover:bg-sky-500/15",
  classification:
    "bg-fuchsia-500/15 text-fuchsia-700 border-transparent hover:bg-fuchsia-500/15",
};

export function PracticeRandomRun({
  courseId,
  questionsInRun,
  onExit,
  onQuestionStatusChange,
  onRunComplete,
}: Props) {
  const { t } = useTranslation("practice");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState<Map<string, SinglePanelCompletion>>(
    () => new Map(),
  );
  const [showSummary, setShowSummary] = useState(false);

  const total = questionsInRun.length;
  const currentQuestion = questionsInRun[currentIndex];
  const isLast = currentIndex >= total - 1;
  const completedInRun = results.size;

  const handleStatusChange = useCallback(
    (status: StudentPracticeStatus) => {
      if (!currentQuestion) return;
      onQuestionStatusChange?.(currentQuestion, status);
    },
    [currentQuestion, onQuestionStatusChange],
  );

  const handleCompleted = useCallback(
    (result?: SinglePanelCompletion) => {
      if (!currentQuestion) return;
      setResults((prev) => {
        const next = new Map(prev);
        next.set(currentQuestion.id, result ?? {});
        return next;
      });
    },
    [currentQuestion],
  );

  const advanceOrFinish = useCallback(() => {
    if (isLast) {
      setShowSummary(true);
      onRunComplete?.();
      return;
    }
    setCurrentIndex((idx) => idx + 1);
  }, [isLast, onRunComplete]);

  const handleFinishEarly = useCallback(() => {
    setShowSummary(true);
  }, []);

  // The dispatcher's "Next question" button is repurposed here to advance
  // within the run rather than scan the global list. `hasNext` is true while
  // there are more questions ahead OR the run can still be finished.
  const dispatcherHasNext = currentIndex < total - 1;

  if (showSummary || total === 0) {
    return (
      <RunSummary
        run={questionsInRun}
        results={results}
        completedInRun={completedInRun}
        onExit={onExit}
      />
    );
  }

  if (!currentQuestion) {
    // Should be unreachable given the guards above — render a safe fallback.
    return (
      <RunSummary
        run={questionsInRun}
        results={results}
        completedInRun={completedInRun}
        onExit={onExit}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b pb-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span data-testid="run-progress">
            {t("run.progress", { current: currentIndex + 1, total })}
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleFinishEarly}
          className="w-full sm:w-auto"
          data-testid="run-exit"
        >
          {t("run.exit")}
        </Button>
      </div>

      <PracticeAnsweringDispatcher
        key={currentQuestion.id}
        question={currentQuestion}
        courseId={courseId}
        hasNext={dispatcherHasNext}
        onBack={handleFinishEarly}
        onNext={advanceOrFinish}
        onCompleted={handleCompleted}
        onStatusChange={handleStatusChange}
      />

      {/* When the student finishes the last question, the dispatcher's
          "Next question" button is hidden (hasNext=false). Surface a
          "Finish run" CTA in that case so they can reach the summary
          even if they don't want to use the dispatcher's footer. */}
      {!dispatcherHasNext && results.has(currentQuestion.id) && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={advanceOrFinish}
            data-testid="run-finish"
          >
            {t("run.finish")}
          </Button>
        </div>
      )}
    </div>
  );
}

function RunSummary({
  run,
  results,
  completedInRun,
  onExit,
}: {
  run: StudentPracticeQuestion[];
  results: Map<string, SinglePanelCompletion>;
  completedInRun: number;
  onExit: () => void;
}) {
  const { t } = useTranslation("practice");

  return (
    <Card data-testid="run-summary">
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div>
          <h2 className="text-lg sm:text-xl font-display font-bold">
            {t("run.complete")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("run.answered", { answered: completedInRun, count: run.length })}
          </p>
        </div>

        <ul className="space-y-2" data-testid="run-summary-list">
          {run.map((q, idx) => (
            <li key={q.id}>
              <SummaryRow index={idx} question={q} result={results.get(q.id)} />
            </li>
          ))}
        </ul>

        <div className="flex justify-end pt-2 border-t">
          <Button
            size="sm"
            onClick={onExit}
            data-testid="run-back-to-list"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("run.backToList")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({
  index,
  question,
  result,
}: {
  index: number;
  question: StudentPracticeQuestion;
  result: SinglePanelCompletion | undefined;
}) {
  const { t } = useTranslation("practice");
  const previewHtml = useMemo(
    () => formatQuestionText(question.stemPreview || ""),
    [question.stemPreview],
  );
  const outcome = describeOutcome(result);

  return (
    <div className="flex items-start gap-3 rounded-md border p-3">
      <div className="flex-shrink-0 pt-0.5">
        <OutcomeIcon kind={outcome.kind} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
          <span className="text-xs text-muted-foreground font-medium">
            #{index + 1}
          </span>
          <Badge
            variant="secondary"
            className={`text-[10px] sm:text-xs px-1.5 ${TYPE_BADGE_CLASS[question.type]}`}
          >
            {t(`types.${question.type}`)}
          </Badge>
          <span
            className={`text-xs font-medium ${outcome.kind === "correct" ? "text-green-700" : outcome.kind === "incorrect" ? "text-red-700" : "text-muted-foreground"}`}
            data-testid={`summary-outcome-${question.id}`}
          >
            {t(outcome.key, outcome.values)}
          </span>
        </div>
        {question.stemPreview ? (
          <div
            className="text-sm text-foreground line-clamp-2 break-words"
            // formatQuestionText returns sanitized HTML (DOMPurify) — safe to inject.
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {t("run.contentUnavailable")}
          </p>
        )}
      </div>
    </div>
  );
}

type OutcomeKind = "correct" | "incorrect" | "graded" | "skipped";

/**
 * A plain function, so it cannot hold a translation hook. It returns the
 * catalog key and its values instead of a finished string, and `SummaryRow`
 * renders it -- the same split as `pickNextUp` in #1210.
 *
 * Numeric grades are deliberately not surfaced here: practice is formative,
 * so the summary sticks to correct / incorrect / submitted.
 */
function describeOutcome(
  result: SinglePanelCompletion | undefined,
): { kind: OutcomeKind; key: string; values?: Record<string, unknown> } {
  if (!result) return { kind: "skipped", key: "run.resultNotCompleted" };
  if (result.allCorrect === true) return { kind: "correct", key: "run.resultCorrect" };
  if (result.allCorrect === false) return { kind: "incorrect", key: "run.resultIncorrect" };
  return { kind: "graded", key: "run.resultSubmitted" };
}

function OutcomeIcon({ kind }: { kind: OutcomeKind }) {
  if (kind === "correct") {
    return <CheckCircle className="h-4 w-4 text-green-600" aria-hidden />;
  }
  if (kind === "incorrect") {
    return <XCircle className="h-4 w-4 text-red-600" aria-hidden />;
  }
  if (kind === "graded") {
    return <CheckCircle className="h-4 w-4 text-amber-600" aria-hidden />;
  }
  return <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />;
}
