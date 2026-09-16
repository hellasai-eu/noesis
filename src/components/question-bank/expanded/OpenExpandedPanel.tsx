/**
 * Open-question expanded panel. The original OpenQuestionsTable inlined
 * the expansion *within* the question cell rather than as a separate row;
 * for the unified bank we render it as a row-spanning panel for a
 * consistent look across all 5 types.
 */
import { Label } from "@/components/ui/label";
import { formatQuestionText } from "@/lib/latex-utils";
import {
  openModelAnswerFromAnswerKey,
  questionDiagramFromPayload,
  type UnifiedQuestion,
} from "@/lib/unified-question";
import { ExpandedPanelShell } from "./ExpandedPanelShell";

interface OpenExpandedPanelProps {
  question: UnifiedQuestion;
  onClose: () => void;
  isAdmin: boolean;
}

export function OpenExpandedPanel({ question, onClose, isAdmin }: OpenExpandedPanelProps) {
  const stem = question.raw.question || "";
  const modelAnswer = openModelAnswerFromAnswerKey(question.raw.answer_key);

  return (
    <ExpandedPanelShell
      titleHtml={formatQuestionText(stem)}
      onClose={onClose}
      isAdmin={isAdmin}
      explanation={question.raw.explanation}
      generationRationale={question.raw.generation_rationale}
      competencies={question.competencies}
      chapters={question.chapters}
      materials={question.materials}
      generatedFor={question.generatedForGroup?.name ?? null}
      createdAt={question.createdAt}
      upvotes={question.upvotes}
      downvotes={question.downvotes}
      diagram={questionDiagramFromPayload(question.raw.payload)}
    >
      {modelAnswer && (
        <div data-testid="open-model-answer">
          <Label className="text-muted-foreground text-xs">Model Answer</Label>
          <div
            className="mt-1 p-3 bg-muted rounded-md prose prose-sm dark:prose-invert max-w-none text-sm"
            dangerouslySetInnerHTML={{ __html: formatQuestionText(modelAnswer) }}
          />
        </div>
      )}
    </ExpandedPanelShell>
  );
}
