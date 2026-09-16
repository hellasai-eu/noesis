/**
 * "Exclude quiz" filter for the Question Bank. Unlike the sibling
 * `MultiSelectFilter` (whose checked options narrow TO matches), checked
 * entries here REMOVE matching questions:
 *
 *   - "In any quiz"    — drop questions that belong to at least one quiz.
 *   - specific quizzes — drop questions that belong to any checked quiz.
 *     Inert while "In any quiz" is on, since "any" subsumes them.
 *
 * Exclusion semantics are the point: "everything except quiz X" is not
 * expressible with an include-style multi-select.
 *
 * Kept dumb — the consumer owns the state and the URL params.
 */
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronDown, X } from "lucide-react";

export interface ExcludeQuizOption {
  value: string;
  label: string;
  count?: number;
}

/** `"any"` = exclude membership in any quiz; a set = only the checked quizzes. */
export type ExcludeQuizSelection = "any" | Set<string>;

interface ExcludeQuizFilterProps {
  quizzes: ExcludeQuizOption[];
  selection: ExcludeQuizSelection;
  onChange: (next: ExcludeQuizSelection) => void;
  testId?: string;
  /**
   * When set, the control is inert: the popover can't open and the clear
   * affordance is hidden. Used when quiz membership failed to load — an
   * empty-but-failed membership map would let the filter look active while
   * excluding nothing.
   */
  disabled?: boolean;
  /** Text shown in place of the summary while `disabled`. */
  disabledHint?: string;
}

export function ExcludeQuizFilter({
  quizzes,
  selection,
  onChange,
  testId,
  disabled = false,
  disabledHint,
}: ExcludeQuizFilterProps) {
  const anyQuiz = selection === "any";
  const quizSet = selection === "any" ? new Set<string>() : selection;
  const activeCount = anyQuiz ? 1 : quizSet.size;

  const toggleQuiz = (id: string) => {
    const next = new Set(quizSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(new Set());
  };
  const summary = disabled
    ? disabledHint ?? "None"
    : activeCount === 0
      ? "None"
      : anyQuiz
        ? "Any quiz"
        : `${quizSet.size} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="justify-between min-w-[140px] gap-2"
          data-testid={testId}
          disabled={disabled}
        >
          <span className="flex items-center gap-2 truncate">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Exclude quiz
            </span>
            <span className="text-sm">{summary}</span>
            {!disabled && activeCount > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {activeCount}
              </Badge>
            )}
          </span>
          <span className="flex items-center gap-1">
            {!disabled && activeCount > 0 && (
              <X
                className="w-3 h-3 text-muted-foreground hover:text-foreground"
                onClick={clear}
                aria-label="Clear Exclude quiz filter"
                role="button"
              />
            )}
            <ChevronDown className="w-3 h-3 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto min-w-[16rem] max-w-[30rem] p-2"
        align="start"
      >
        <div className="space-y-1">
          <label
            className="flex items-center gap-2 p-1.5 rounded hover:bg-secondary transition-colors cursor-pointer"
            data-testid={testId ? `${testId}-any` : undefined}
          >
            <Checkbox
              checked={anyQuiz}
              onCheckedChange={(v) =>
                onChange(v === true ? "any" : new Set())
              }
            />
            <span className="text-sm flex-1">In any quiz</span>
          </label>

          {quizzes.length === 0 ? (
            <div className="px-1.5 pb-1 text-xs text-muted-foreground">
              No quizzes in this course yet
            </div>
          ) : (
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {quizzes.map((quiz) => {
                const checked = anyQuiz || quizSet.has(quiz.value);
                return (
                  <label
                    key={quiz.value}
                    className={`flex items-center gap-2 p-1.5 pl-6 rounded transition-colors ${
                      anyQuiz
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:bg-secondary cursor-pointer"
                    }`}
                    data-testid={
                      testId ? `${testId}-option-${quiz.value}` : undefined
                    }
                  >
                    <Checkbox
                      checked={checked}
                      disabled={anyQuiz}
                      onCheckedChange={() => toggleQuiz(quiz.value)}
                    />
                    <span className="text-sm flex-1 truncate">{quiz.label}</span>
                    {typeof quiz.count === "number" && (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {quiz.count}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}

          {/* Keyboard-operable clear — the trigger's X is pointer-only
              (it cannot take focus inside the trigger button). */}
          {activeCount > 0 && (
            <div className="border-t mt-1 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs"
                onClick={() => onChange(new Set())}
                data-testid={testId ? `${testId}-clear` : undefined}
              >
                <X className="w-3 h-3 mr-1" />
                Clear exclusions
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
