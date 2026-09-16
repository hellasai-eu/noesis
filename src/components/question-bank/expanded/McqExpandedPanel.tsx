/**
 * MCQ expanded-row panel. Mirrors the JSX previously inlined in
 * `QuestionsTable.tsx` (lines 1677–1810 prior to #621), now extracted so
 * the unified bank can render it for any MCQ row regardless of which table
 * surfaced it.
 */
import { CheckCircle } from "lucide-react";
import { processLatexContent } from "@/lib/latex-utils";
import {
  mcqCorrectIndicesFromAnswerKey,
  mcqOptionsFromPayload,
  questionDiagramFromPayload,
  type UnifiedQuestion,
} from "@/lib/unified-question";
import { ExpandedPanelShell } from "./ExpandedPanelShell";

interface McqExpandedPanelProps {
  question: UnifiedQuestion;
  onClose: () => void;
  isAdmin: boolean;
}

export function McqExpandedPanel({ question, onClose, isAdmin }: McqExpandedPanelProps) {
  const stem = question.raw.question || "";
  const options = mcqOptionsFromPayload(question.raw.payload);
  const correctIndices = mcqCorrectIndicesFromAnswerKey(question.raw.answer_key);

  return (
    <ExpandedPanelShell
      titleHtml={processLatexContent(stem)}
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
      <div className="grid gap-2">
        {options.map((option, optIndex) => {
          const isCorrect = correctIndices.includes(optIndex);
          return (
            <div
              key={optIndex}
              data-testid="mcq-option"
              className={`flex items-center gap-2 p-2 rounded-md border ${
                isCorrect
                  ? "border-green-500 bg-green-500/10"
                  : "border-border"
              }`}
            >
              <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs font-medium">
                {String.fromCharCode(65 + optIndex)}
              </span>
              <span
                className="flex-1"
                dangerouslySetInnerHTML={{ __html: processLatexContent(option) }}
              />
              {isCorrect && <CheckCircle className="w-4 h-4 text-green-500" />}
            </div>
          );
        })}
      </div>
    </ExpandedPanelShell>
  );
}
