/**
 * #756 — Practice answering dispatcher.
 *
 * Bridges the unified practice list (#754) to the per-type single-question
 * answering panels (#755). Given one `StudentPracticeQuestion` row, this
 * component renders the matching `Single*AnsweringPanel` and surfaces a
 * shared completion footer (Back to list / Next question) so the list can
 * stay focused on selection.
 *
 * Edge cases:
 *  - Unknown/legacy `type` → graceful fallback card (no panel mounted).
 *  - Missing offering (`offeringId === ""`) → warning header before the panel.
 *  - Open in interactive mode never gets here (#753 excludes it), but the
 *    open panel already renders its own unsupported-mode card as a guard.
 */
import { useLayoutEffect, useState } from "react";
import { ArrowRight, ArrowLeft, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  SingleMcqAnsweringPanel,
  SingleOpenAnsweringPanel,
  SingleFillGapsAnsweringPanel,
  SingleOrderingAnsweringPanel,
  SingleClassificationAnsweringPanel,
  type SinglePanelCompletion,
  type SinglePanelStatus,
} from "@/components/student-answering";
import type { StudentPracticeQuestion } from "@/hooks/useStudentPracticeQuestions";
import { Trans, useTranslation } from "react-i18next";

interface Props {
  question: StudentPracticeQuestion;
  courseId: string;
  /** True when there is at least one unanswered question after the current one. */
  hasNext: boolean;
  onBack: () => void;
  onNext: () => void;
  onCompleted?: (result?: SinglePanelCompletion) => void;
  onStatusChange?: (status: SinglePanelStatus) => void;
}

export function PracticeAnsweringDispatcher({
  question,
  courseId,
  hasNext,
  onBack,
  onNext,
  onCompleted,
  onStatusChange,
}: Props) {
  const { t } = useTranslation("practice");
  // Tracked locally so the completion footer only appears for the duration
  // of THIS question. When the parent rotates the dispatcher to a different
  // question (e.g. via the Next CTA) the effect below resets the flag so
  // the new question starts in its pre-completion state.
  const [completed, setCompleted] = useState(false);
  useLayoutEffect(() => {
    setCompleted(false);
  }, [question.id]);

  const handleCompleted = (result?: SinglePanelCompletion) => {
    setCompleted(true);
    onCompleted?.(result);
  };

  // Offering is required for the deterministic-answer write path (RLS uses
  // it to verify enrollment). If the assignment was withdrawn after the list
  // was loaded, surface a friendly warning instead of letting the panel
  // 500 on submit. The panels still mount so the student can read the
  // question and the existing grade (view mode).
  const missingOffering = !question.offeringId;

  const panelProps = {
    questionId: question.id,
    courseId,
    offeringId: question.offeringId || null,
    onBack,
    onCompleted: handleCompleted,
    onStatusChange,
  };

  return (
    <div className="flex flex-col gap-4">
      {missingOffering && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <p>{t("dispatcher.offeringChanged")}</p>
        </div>
      )}

      {/* `key` forces a clean remount when the dispatcher rotates to a
          different question — otherwise the panel's internal `useEffect`
          on `questionId` re-fires but its local form state (selected
          answers, draft, etc.) would briefly carry over. */}
      <PanelForType key={question.id} question={question} panelProps={panelProps} />

      {completed && (
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 pt-2 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            className="w-full sm:w-auto"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t("dispatcher.backToList")}
          </Button>
          {hasNext && (
            <Button
              size="sm"
              onClick={onNext}
              className="w-full sm:w-auto"
              data-testid="next-question"
            >
              {t("dispatcher.nextQuestion")}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PanelForType({
  question,
  panelProps,
}: {
  question: StudentPracticeQuestion;
  panelProps: {
    questionId: string;
    courseId: string;
    offeringId: string | null;
    onBack: () => void;
    onCompleted: (result?: SinglePanelCompletion) => void;
    onStatusChange?: (status: SinglePanelStatus) => void;
  };
}) {
  switch (question.type) {
    case "mcq":
      return <SingleMcqAnsweringPanel {...panelProps} />;
    case "open":
      return <SingleOpenAnsweringPanel {...panelProps} />;
    case "fill_gaps":
      return <SingleFillGapsAnsweringPanel {...panelProps} />;
    case "ordering":
      return <SingleOrderingAnsweringPanel {...panelProps} />;
    case "classification":
      return <SingleClassificationAnsweringPanel {...panelProps} />;
    default:
      return <UnsupportedTypeCard type={question.type} onBack={panelProps.onBack} />;
  }
}

function UnsupportedTypeCard({
  type,
  onBack,
}: {
  type: string;
  onBack: () => void;
}) {
  const { t } = useTranslation("practice");
  // Falls back to the raw type for a type the catalog does not know,
  // which is the same behaviour the English label map had.
  const label = t(`types.${type}`, { defaultValue: type });
  return (
    <Card className="border-dashed">
      <CardContent className="p-6 sm:p-8 text-center space-y-4">
        <AlertCircle className="h-10 w-10 text-muted-foreground/60 mx-auto" />
        <div>
          <h4 className="font-medium mb-1">{t("dispatcher.unsupportedTitle")}</h4>
          <p className="text-sm text-muted-foreground">
            <Trans
              i18nKey="practice:dispatcher.unsupportedBody"
              values={{ type: label }}
              components={{ 1: <span className="font-medium text-foreground" /> }}
            />
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t("dispatcher.backToList")}
        </Button>
      </CardContent>
    </Card>
  );
}
