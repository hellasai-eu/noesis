/**
 * EvaluatorMobileActionBar (#681) — sticky bottom bar with Prev / Next / Save
 * for phone-and-tablet widths. Desktop keeps the inline form Save button + the
 * `EvaluatorNavBar` strip; this is purely additive for `< lg`.
 *
 * Logic-free like `EvaluatorNavBar`: the page owns selection and the form
 * imperative handle. Save just calls the same handle the ⌘/Ctrl+Enter shortcut
 * uses, so validation, toasts, and auto-advance flow through one path.
 *
 * The bar respects the iOS home-indicator inset via `safe-area-inset-bottom`.
 */
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2, Save } from "lucide-react";

interface EvaluatorMobileActionBarProps {
  currentIndex: number;
  total: number;
  saving: boolean;
  onPrev: () => void;
  onNext: () => void;
  onSave: () => void;
}

export function EvaluatorMobileActionBar({
  currentIndex,
  total,
  saving,
  onPrev,
  onNext,
  onSave,
}: EvaluatorMobileActionBarProps) {
  const { t } = useTranslation(["evaluator", "common"]);
  const prevDisabled = currentIndex <= 0 || total === 0;
  const nextDisabled = currentIndex >= total - 1 || total === 0;
  return (
    <div
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      data-testid="evaluator-mobile-action-bar"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-11 px-3"
          onClick={onPrev}
          disabled={prevDisabled}
          aria-label={t("nav.prevAria")}
          data-testid="mobile-action-prev"
        >
          <ChevronLeft className="w-5 h-5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-11 px-3"
          onClick={onNext}
          disabled={nextDisabled}
          aria-label={t("nav.nextAria")}
          data-testid="mobile-action-next"
        >
          <ChevronRight className="w-5 h-5" />
        </Button>
        <Button
          type="button"
          size="lg"
          className="h-11 flex-1"
          onClick={onSave}
          disabled={saving || total === 0}
          data-testid="mobile-action-save"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t("common:actions.saving")}
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              {t("common:actions.save")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
