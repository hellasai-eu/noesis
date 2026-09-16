/**
 * Ordering expanded panel. Mirrors OrderingTable's expanded row (lines
 * 756–867 prior to #621): renders the prompt and the numbered list of
 * items in canonical order.
 */
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import {
  orderingItemsFromPayload,
  orderingPromptFromPayload,
  questionDiagramFromPayload,
  type UnifiedQuestion,
} from "@/lib/unified-question";
import { ExpandedPanelShell } from "./ExpandedPanelShell";

interface OrderingExpandedPanelProps {
  question: UnifiedQuestion;
  onClose: () => void;
  isAdmin: boolean;
}

export function OrderingExpandedPanel({ question, onClose, isAdmin }: OrderingExpandedPanelProps) {
  const prompt = orderingPromptFromPayload(question.raw.payload);
  const items = orderingItemsFromPayload(question.raw.payload);

  return (
    <ExpandedPanelShell
      titleHtml={formatQuestionText(prompt)}
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
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Correct order ({items.length} items)
        </p>
        <ol className="space-y-2 list-none">
          {items.map((item, idx) => (
            <li
              key={`${question.id}-item-${idx}`}
              data-testid="ordering-item"
              className="flex items-start gap-3 p-2 rounded-md border border-border bg-background"
            >
              <span className="w-6 h-6 rounded-full border bg-muted/50 flex items-center justify-center text-xs font-medium shrink-0">
                {idx + 1}
              </span>
              <span
                className="flex-1 text-sm"
                dangerouslySetInnerHTML={{ __html: processLatexContent(item) }}
              />
            </li>
          ))}
        </ol>
      </div>
    </ExpandedPanelShell>
  );
}
