/**
 * QuestionTypePreview — instructor-facing read-only preview of a single
 * question across all 5 non-interactive types (#653). Used inside the quiz
 * and test builder preview dialogs so instructors can verify what they
 * picked before saving.
 *
 * Not a student runner. The student-facing flows live in
 * `StudentQuiz` / the student renderers; this component only renders the
 * stem + per-type body + (optional) correct answer.
 */
import { CheckCircle2 } from "lucide-react";
import { processLatexContent } from "@/lib/latex-utils";
import { renderQuestionStem } from "@/lib/question-stem";
import {
  mcqOptionsFromPayload,
  mcqCorrectIndicesFromAnswerKey,
  openModelAnswerFromAnswerKey,
  fillGapsStemFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  orderingPromptFromPayload,
  orderingItemsFromPayload,
  classificationPromptFromPayload,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationAssignmentsFromAnswerKey,
} from "@/lib/question-payload";
import type { UnifiedQuestion } from "@/lib/unified-question";

interface QuestionTypePreviewProps {
  question: UnifiedQuestion;
  showAnswer: boolean;
}

export function QuestionTypePreview({
  question,
  showAnswer,
}: QuestionTypePreviewProps) {
  const { type, raw } = question;

  if (type === "mcq") {
    const options = mcqOptionsFromPayload(raw.payload);
    const correctIndices = mcqCorrectIndicesFromAnswerKey(raw.answer_key);
    const stem = renderQuestionStem(raw.question || "", correctIndices.length > 1);
    return (
      <>
        <div className="p-4 bg-muted/50 rounded-lg">
          <p
            className="font-medium text-lg leading-relaxed"
            dangerouslySetInnerHTML={{ __html: processLatexContent(stem) }}
          />
        </div>
        <div className="space-y-2">
          {options.map((option, idx) => {
            const isCorrect = correctIndices.includes(idx);
            return (
              <div
                key={idx}
                className={`p-3 rounded-lg border transition-colors ${
                  showAnswer
                    ? isCorrect
                      ? "bg-green-50 border-green-500 dark:bg-green-950/30"
                      : "bg-muted/30 border-border"
                    : "bg-background border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                    {String.fromCharCode(65 + idx)}
                  </span>
                  <span
                    className="flex-1"
                    dangerouslySetInnerHTML={{
                      __html: processLatexContent(option),
                    }}
                  />
                  {showAnswer && isCorrect && (
                    <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  if (type === "open") {
    const model = openModelAnswerFromAnswerKey(raw.answer_key);
    return (
      <>
        <div className="p-4 bg-muted/50 rounded-lg">
          <p
            className="font-medium text-lg leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(raw.question || ""),
            }}
          />
        </div>
        {showAnswer && model && (
          <div className="p-4 bg-green-50 dark:bg-green-950/30 border border-green-500 rounded-lg">
            <p className="text-xs font-semibold text-green-700 dark:text-green-300 mb-1">
              Model answer
            </p>
            <p
              className="text-sm whitespace-pre-wrap"
              dangerouslySetInnerHTML={{
                __html: processLatexContent(model),
              }}
            />
          </div>
        )}
      </>
    );
  }

  if (type === "fill_gaps") {
    const stem = fillGapsStemFromPayload(raw.payload);
    const gaps = fillGapsAcceptableAnswersFromAnswerKey(raw.answer_key);
    // Replace `{{N}}` placeholders with a visible cloze marker — uses
    // U+2017 (double low line) to match the bank preview's unicode choice
    // and avoid colliding with markdown `__bold__`.
    const stemRendered = stem.replace(/\{\{(\d+)\}\}/g, (_m, n) => `(${n}) ‗‗‗‗`);
    return (
      <>
        <div className="p-4 bg-muted/50 rounded-lg">
          <p
            className="font-medium text-lg leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(stemRendered),
            }}
          />
        </div>
        {showAnswer && gaps.length > 0 && (
          <div className="space-y-2">
            {gaps.map((g) => (
              <div
                key={g.ordinal}
                className="p-3 rounded-lg border border-green-500 bg-green-50 dark:bg-green-950/30"
              >
                <p className="text-xs font-semibold text-green-700 dark:text-green-300 mb-1">
                  Gap {g.ordinal}
                </p>
                <p className="text-sm">
                  {g.acceptable.join(" / ")}
                </p>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  if (type === "ordering") {
    const prompt = orderingPromptFromPayload(raw.payload);
    const items = orderingItemsFromPayload(raw.payload);
    return (
      <>
        <div className="p-4 bg-muted/50 rounded-lg">
          <p
            className="font-medium text-lg leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(prompt),
            }}
          />
        </div>
        <div className="space-y-2">
          {items.map((item, idx) => (
            <div
              key={idx}
              className={`p-3 rounded-lg border ${
                showAnswer
                  ? "bg-green-50 border-green-500 dark:bg-green-950/30"
                  : "bg-background border-border"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                  {showAnswer ? idx + 1 : "?"}
                </span>
                <span
                  className="flex-1"
                  dangerouslySetInnerHTML={{
                    __html: processLatexContent(item),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  // classification
  const prompt = classificationPromptFromPayload(raw.payload);
  const categories = classificationCategoriesFromPayload(raw.payload);
  const items = classificationItemsFromPayload(raw.payload);
  const assignments = classificationAssignmentsFromAnswerKey(raw.answer_key);
  return (
    <>
      <div className="p-4 bg-muted/50 rounded-lg">
        <p
          className="font-medium text-lg leading-relaxed"
          dangerouslySetInnerHTML={{
            __html: processLatexContent(prompt),
          }}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {categories.map((cat) => {
          const inThisCat = items.filter((it) => assignments[it.id] === cat.id);
          return (
            <div
              key={cat.id}
              className={`p-3 rounded-lg border ${
                showAnswer
                  ? "bg-green-50 border-green-500 dark:bg-green-950/30"
                  : "bg-background border-border"
              }`}
            >
              <p className="font-semibold mb-2">{cat.label}</p>
              {showAnswer ? (
                <ul className="text-sm space-y-1 pl-4 list-disc">
                  {inThisCat.map((it) => (
                    <li key={it.id}>{it.text}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Show answer to reveal assignment
                </p>
              )}
            </div>
          );
        })}
      </div>
      {!showAnswer && items.length > 0 && (
        <div className="p-3 rounded-lg border bg-secondary/50">
          <p className="text-xs uppercase text-muted-foreground mb-2">Items</p>
          <div className="flex flex-wrap gap-2">
            {items.map((it) => (
              <span
                key={it.id}
                className="px-2 py-1 rounded bg-background border text-sm"
              >
                {it.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
