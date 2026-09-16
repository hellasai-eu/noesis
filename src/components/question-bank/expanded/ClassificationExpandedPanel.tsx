/**
 * Classification expanded panel. Mirrors ClassificationTable's expanded
 * row (lines 738–858 prior to #621): a 2-column grid of categories where
 * each category lists the items assigned to it via `answer_key.assignments`.
 */
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import {
  classificationAssignmentsFromAnswerKey,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationPromptFromPayload,
  questionDiagramFromPayload,
  type UnifiedQuestion,
} from "@/lib/unified-question";
import { ExpandedPanelShell } from "./ExpandedPanelShell";

interface ClassificationExpandedPanelProps {
  question: UnifiedQuestion;
  onClose: () => void;
  isAdmin: boolean;
}

export function ClassificationExpandedPanel({
  question,
  onClose,
  isAdmin,
}: ClassificationExpandedPanelProps) {
  const prompt = classificationPromptFromPayload(question.raw.payload);
  const categories = classificationCategoriesFromPayload(question.raw.payload);
  const items = classificationItemsFromPayload(question.raw.payload);
  const assignments = classificationAssignmentsFromAnswerKey(question.raw.answer_key);

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
          Categories &amp; items ({items.length} items across {categories.length} categories)
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {categories.map((category) => {
            const itemsInCategory = items.filter(
              (item) => assignments[item.id] === category.id,
            );
            return (
              <div
                key={category.id}
                data-testid="classification-category"
                className="rounded-md border border-border bg-background p-3 space-y-2"
              >
                <div
                  className="text-sm font-semibold prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: processLatexContent(category.label) }}
                />
                {itemsInCategory.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No items</p>
                ) : (
                  <ul className="space-y-1 list-disc list-inside text-sm">
                    {itemsInCategory.map((item) => (
                      <li
                        key={item.id}
                        data-testid="classification-item"
                        dangerouslySetInnerHTML={{ __html: processLatexContent(item.text) }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </ExpandedPanelShell>
  );
}
