/**
 * EvaluatorNavBar (#680) — per-question navigation strip rendered above the
 * evaluation form. Houses Prev / Next, "next unevaluated", a position
 * indicator, the auto-advance toggle, and the keyboard-shortcuts legend.
 *
 * Logic-free: it just renders state + dispatches callbacks. The parent
 * (`EvaluatorReviewSession`) owns selection and the global keyboard handler.
 *
 * #681 will likely re-house Save/Prev/Next inside a sticky bottom action bar
 * on mobile; this bar stays as the desktop discoverability surface.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  ChevronLeft,
  ChevronRight,
  Keyboard,
  SkipForward,
} from "lucide-react";

interface EvaluatorNavBarProps {
  currentIndex: number;
  total: number;
  hasUnevaluated: boolean;
  autoAdvance: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJumpUnevaluated: () => void;
  onToggleAutoAdvance: (next: boolean) => void;
}

export function EvaluatorNavBar({
  currentIndex,
  total,
  hasUnevaluated,
  autoAdvance,
  onPrev,
  onNext,
  onJumpUnevaluated,
  onToggleAutoAdvance,
}: EvaluatorNavBarProps) {
  const { t } = useTranslation("evaluator");

  const positionLabel =
    total > 0
      ? t("nav.position", { current: currentIndex + 1, total })
      : t("nav.noQuestions");
  const prevDisabled = currentIndex <= 0 || total === 0;
  const nextDisabled = currentIndex >= total - 1 || total === 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="evaluator-nav-bar"
    >
      <Button
        variant="outline"
        size="sm"
        onClick={onPrev}
        disabled={prevDisabled}
        data-testid="nav-prev"
        aria-label={t("nav.prevAria")}
      >
        <ChevronLeft className="w-4 h-4 mr-1" />
        {t("nav.prev")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onNext}
        disabled={nextDisabled}
        data-testid="nav-next"
        aria-label={t("nav.nextAria")}
      >
        {t("nav.next")}
        <ChevronRight className="w-4 h-4 ml-1" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onJumpUnevaluated}
        disabled={!hasUnevaluated}
        data-testid="nav-jump-unevaluated"
        aria-label={t("nav.jumpUnevaluatedAria")}
      >
        <SkipForward className="w-4 h-4 mr-1" />
        {t("nav.jumpUnevaluated")}
      </Button>
      <span
        className="text-xs text-muted-foreground ml-1 tabular-nums"
        data-testid="nav-position"
      >
        {positionLabel}
      </span>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="auto-advance"
            checked={autoAdvance}
            onCheckedChange={onToggleAutoAdvance}
            data-testid="nav-auto-advance"
          />
          <Label
            htmlFor="auto-advance"
            className="text-xs text-muted-foreground cursor-pointer"
          >
            {t("nav.autoAdvance")}
          </Label>
        </div>
        <KeyboardLegend />
      </div>
    </div>
  );
}

function KeyboardLegend() {
  const { t } = useTranslation("evaluator");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("shortcuts.trigger")}
          data-testid="keyboard-legend-trigger"
        >
          <Keyboard className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72"
        data-testid="keyboard-legend"
      >
        <p className="text-sm font-semibold mb-2">{t("shortcuts.title")}</p>
        <ul className="space-y-1.5 text-xs">
          <ShortcutRow
            keys={["J", "→"]}
            label={t("shortcuts.nextQuestion")}
          />
          <ShortcutRow
            keys={["K", "←"]}
            label={t("shortcuts.prevQuestion")}
          />
          <ShortcutRow keys={["U"]} label={t("shortcuts.nextUnevaluated")} />
          <ShortcutRow
            keys={["⌘/Ctrl", "Enter"]}
            label={t("shortcuts.save")}
          />
          <ShortcutRow keys={["1"]} label={t("shortcuts.verdictGood")} />
          <ShortcutRow keys={["2"]} label={t("shortcuts.verdictNeedsFixing")} />
          <ShortcutRow keys={["3"]} label={t("shortcuts.verdictReject")} />
        </ul>
        <p className="text-[11px] text-muted-foreground mt-3">
          {t("shortcuts.note")}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono text-foreground shadow-sm"
          >
            {k}
          </kbd>
        ))}
      </span>
    </li>
  );
}
