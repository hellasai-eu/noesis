/**
 * Fill the Gaps expanded panel. Mirrors FillGapsTable's expanded row
 * (lines 699–807 prior to #621): renders the stem with placeholders, the
 * numbered list of gaps with their acceptable answers, plus the shared
 * explanation / rationale / competencies / chapters footer.
 */
import { Badge } from "@/components/ui/badge";
import { formatQuestionText } from "@/lib/latex-utils";
import {
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsStemFromPayload,
  questionDiagramFromPayload,
  type UnifiedQuestion,
} from "@/lib/unified-question";
import { ExpandedPanelShell } from "./ExpandedPanelShell";

interface FillGapsExpandedPanelProps {
  question: UnifiedQuestion;
  onClose: () => void;
  isAdmin: boolean;
}

/** Match FillGapsTable's preview style: `{{N}}` → `‗‗‗(N)` (U+2017). */
function renderStemPreview(stem: string): string {
  return stem.replace(/\{\{(\d+)\}\}/g, "‗‗‗($1)");
}

export function FillGapsExpandedPanel({ question, onClose, isAdmin }: FillGapsExpandedPanelProps) {
  const stem = fillGapsStemFromPayload(question.raw.payload);
  const gaps = fillGapsAcceptableAnswersFromAnswerKey(question.raw.answer_key);

  return (
    <ExpandedPanelShell
      titleHtml={formatQuestionText(renderStemPreview(stem))}
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
          Gaps ({gaps.length})
        </p>
        <ol className="space-y-2 list-none">
          {gaps.map((gap) => (
            <li
              key={`${question.id}-gap-${gap.ordinal}`}
              data-testid="fill-gap-item"
              className="flex items-start gap-3 p-2 rounded-md border border-border bg-background"
            >
              <span className="w-6 h-6 rounded-full border bg-muted/50 flex items-center justify-center text-xs font-medium shrink-0">
                {gap.ordinal}
              </span>
              <div className="flex-1 flex flex-wrap gap-1">
                {gap.acceptable.map((ans, idx) => (
                  <Badge
                    key={`${gap.ordinal}-${idx}`}
                    variant={idx === 0 ? "default" : "secondary"}
                    className="text-xs font-normal"
                  >
                    {ans}
                  </Badge>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </ExpandedPanelShell>
  );
}
