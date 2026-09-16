/**
 * Generic multi-select popover used by the Question Bank Author / Book /
 * Chapter filters (#623). Empty selection means "no narrowing" (all).
 *
 * Kept dumb — the consumer owns the selected set and the URL state.
 */
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Check, ChevronDown, X } from "lucide-react";

export interface MultiSelectOption {
  value: string;
  label: string;
  count?: number;
}

interface MultiSelectFilterProps {
  label: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  testId?: string;
  emptyHint?: string;
  /**
   * When set, the control is inert: the popover can't open and the selection
   * clear affordance is hidden. Used to gate Chapter on a Book being picked
   * first (#858).
   */
  disabled?: boolean;
  /** Text shown in place of the summary while `disabled` (e.g. a prompt). */
  disabledHint?: string;
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  testId,
  emptyHint,
  disabled = false,
  disabledHint,
}: MultiSelectFilterProps) {
  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };
  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(new Set());
  };
  const summary = disabled
    ? disabledHint ?? `All ${label.toLowerCase()}`
    : selected.size === 0
      ? `All ${label.toLowerCase()}`
      : `${selected.size} selected`;
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
              {label}
            </span>
            <span className="text-sm">{summary}</span>
            {!disabled && selected.size > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {selected.size}
              </Badge>
            )}
          </span>
          <span className="flex items-center gap-1">
            {!disabled && selected.size > 0 && (
              <X
                className="w-3 h-3 text-muted-foreground hover:text-foreground"
                onClick={clear}
                aria-label={`Clear ${label} filter`}
                role="button"
              />
            )}
            <ChevronDown className="w-3 h-3 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto min-w-[16rem] max-w-[30rem] p-2" align="start">
        {options.length === 0 ? (
          <div className="text-xs text-muted-foreground p-2">
            {emptyHint ?? "No options available"}
          </div>
        ) : (
          <TooltipProvider delayDuration={300}>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {options.map((opt) => {
                const checked = selected.has(opt.value);
                return (
                  // Tooltip trigger wraps the whole row (not the text span)
                  // so it shows on hover of the row and on focus of the
                  // Checkbox — the label's only native tab stop — instead
                  // of adding a second, non-actionable tab stop (#864).
                  <Tooltip key={opt.value}>
                    <TooltipTrigger asChild>
                      <label
                        className="flex items-center gap-2 p-1.5 rounded hover:bg-secondary transition-colors cursor-pointer"
                        data-testid={
                          testId ? `${testId}-option-${opt.value}` : undefined
                        }
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggle(opt.value)}
                        />
                        <span className="text-sm flex-1 truncate">
                          {opt.label}
                        </span>
                        {typeof opt.count === "number" && (
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {opt.count}
                          </span>
                        )}
                        {checked && <Check className="w-3 h-3 text-primary" />}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm break-words">
                      {opt.label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>
        )}
      </PopoverContent>
    </Popover>
  );
}
