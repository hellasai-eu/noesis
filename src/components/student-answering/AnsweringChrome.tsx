import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getDifficultyClass } from "@/lib/difficulty-color";

interface AnsweringChromeProps {
  title: string;
  subtitle?: ReactNode;
  difficulty?: string;
  onBack: () => void;
  backLabel?: string;
  rightSlot?: ReactNode;
}

/**
 * Shared header for the per-type single-question answering panels (#755).
 * Each panel previously duplicated this row (back arrow + title/subtitle +
 * difficulty badge); factoring it keeps the new embeddable variants visually
 * aligned without forcing their bodies into a single layout.
 */
export function AnsweringChrome({
  title,
  subtitle,
  difficulty,
  onBack,
  backLabel,
  rightSlot,
}: AnsweringChromeProps) {
  const { t } = useTranslation("practice");

  return (
    <div className="flex items-center justify-between border-b pb-3">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label={backLabel ?? t("chrome.back")}
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {rightSlot}
        {difficulty && (
          <Badge className={getDifficultyClass(difficulty)}>{difficulty}</Badge>
        )}
      </div>
    </div>
  );
}
