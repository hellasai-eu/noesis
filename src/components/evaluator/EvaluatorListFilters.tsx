/**
 * EvaluatorListFilters (#683) — triage controls that live above the question
 * list on the evaluator review surface. Rendered twice (mobile sheet + desktop
 * rail) with shared parent state, so the same instance shape can drive both.
 *
 * Filters are page-local (not URL-synced): they're a triage view over the
 * existing in-memory `questions` array and don't need to survive a refresh —
 * the resumed-question + draft state already does that work (#680, #682).
 */
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Search, X } from "lucide-react";
import type { QuestionType } from "@/types/question";
import { ALL_QUESTION_TYPES, QUESTION_TYPE_LABELS } from "@/lib/unified-question";

export type DifficultyFilter = "all" | "easy" | "medium" | "hard";

interface EvaluatorListFiltersProps {
  searchTerm: string;
  onSearchTermChange: (next: string) => void;
  unevaluatedOnly: boolean;
  onUnevaluatedOnlyChange: (next: boolean) => void;
  typeFilter: Set<QuestionType>;
  onTypeFilterChange: (next: Set<QuestionType>) => void;
  difficultyFilter: DifficultyFilter;
  onDifficultyFilterChange: (next: DifficultyFilter) => void;
  visibleCount: number;
  totalCount: number;
  /** Variant suffix appended to test ids so the mobile + desktop instances are addressable independently. */
  variant: "mobile" | "desktop";
}

/**
 * Order is fixed here; the visible labels come from the `common:difficulty.*`
 * catalog, because a module-level constant is evaluated once at import time and
 * would freeze the labels to whatever locale was active on first load.
 */
const DIFFICULTY_OPTIONS: readonly DifficultyFilter[] = [
  "all",
  "easy",
  "medium",
  "hard",
];

export function EvaluatorListFilters({
  searchTerm,
  onSearchTermChange,
  unevaluatedOnly,
  onUnevaluatedOnlyChange,
  typeFilter,
  onTypeFilterChange,
  difficultyFilter,
  onDifficultyFilterChange,
  visibleCount,
  totalCount,
  variant,
}: EvaluatorListFiltersProps) {
  const { t } = useTranslation(["evaluator", "common"]);
  const switchId = `evaluator-unevaluated-only-${variant}`;
  const allFiltersDefault =
    searchTerm === "" &&
    !unevaluatedOnly &&
    typeFilter.size === 0 &&
    difficultyFilter === "all";

  const resetAll = () => {
    onSearchTermChange("");
    onUnevaluatedOnlyChange(false);
    onTypeFilterChange(new Set());
    onDifficultyFilterChange("all");
  };

  return (
    <div
      className="space-y-2.5 px-2 pt-2 pb-2 border-b"
      data-testid={`evaluator-list-filters-${variant}`}
    >
      <div className="relative">
        <Search
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={searchTerm}
          onChange={(e) => onSearchTermChange(e.target.value)}
          placeholder={t("filters.searchPlaceholder")}
          aria-label={t("filters.searchAria")}
          className="h-8 pl-8 pr-7 text-xs"
          data-testid={`evaluator-list-search-${variant}`}
        />
        {searchTerm && (
          <button
            type="button"
            onClick={() => onSearchTermChange("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted-foreground hover:text-foreground"
            aria-label={t("filters.clearSearch")}
            data-testid={`evaluator-list-search-clear-${variant}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor={switchId}
          className="text-xs font-normal cursor-pointer text-foreground"
        >
          {t("filters.unevaluatedOnly")}
        </Label>
        <Switch
          id={switchId}
          checked={unevaluatedOnly}
          onCheckedChange={onUnevaluatedOnlyChange}
          className="scale-90"
          data-testid={`evaluator-list-unevaluated-${variant}`}
        />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          {t("filters.type")}
        </div>
        <ToggleGroup
          type="multiple"
          value={Array.from(typeFilter)}
          onValueChange={(vals) =>
            onTypeFilterChange(new Set(vals as QuestionType[]))
          }
          variant="outline"
          size="sm"
          className="flex flex-wrap justify-start gap-1"
          aria-label={t("filters.typeAria")}
          data-testid={`evaluator-list-type-filter-${variant}`}
        >
          {/* `type`, not `t` — the old parameter name now shadows the
              translation function in this scope. */}
          {ALL_QUESTION_TYPES.map((type) => (
            <ToggleGroupItem
              key={type}
              value={type}
              size="sm"
              variant="outline"
              className="text-[11px] h-6 px-2"
              data-testid={`evaluator-list-type-chip-${type}-${variant}`}
            >
              {QUESTION_TYPE_LABELS[type]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
          {t("filters.difficulty")}
        </div>
        <ToggleGroup
          type="single"
          value={difficultyFilter}
          onValueChange={(v) => {
            if (!v) return;
            onDifficultyFilterChange(v as DifficultyFilter);
          }}
          variant="outline"
          size="sm"
          className="flex justify-start gap-1"
          aria-label={t("filters.difficultyAria")}
          data-testid={`evaluator-list-difficulty-filter-${variant}`}
        >
          {DIFFICULTY_OPTIONS.map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              size="sm"
              variant="outline"
              className="text-[11px] h-6 px-2"
              data-testid={`evaluator-list-difficulty-${value}-${variant}`}
            >
              {t(`common:difficulty.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
        <span
          className="tabular-nums"
          data-testid={`evaluator-list-visible-count-${variant}`}
        >
          {t("filters.visibleCount", { visible: visibleCount, total: totalCount })}
        </span>
        {!allFiltersDefault && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetAll}
            className="h-6 px-2 text-[11px]"
            data-testid={`evaluator-list-clear-filters-${variant}`}
          >
            {t("common:actions.clear")}
          </Button>
        )}
      </div>
    </div>
  );
}
