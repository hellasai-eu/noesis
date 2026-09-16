/**
 * End-of-session summary dialog (#668, smarter-summary refresh #683). One-time
 * per session — writes `ended_at`, `overall_quality`, `recurring_problems`,
 * and `would_use` onto the parent `question_evaluation_sessions` row.
 *
 * #683 splits the dialog into two steps so the evaluator can review what they
 * flagged this session before the irreversible finish:
 *   1. **Review** — the questions flagged needs_fixing/reject in this session,
 *      with their problem categories. An "auto-fill from flags" button
 *      populates the recurring_problems textarea from the most-frequent
 *      categories, which the evaluator can then edit or wipe.
 *   2. **Finalize** — overall_quality + would_use. `would_use` is still
 *      required to enable submit (preserves the original AC).
 * A "Πίσω" button on the finalize step lets them go back to the review step
 * without committing, so the finish is never an accident.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import {
  PROBLEM_CATEGORIES,
  VERDICT_OPTIONS,
  WOULD_USE_OPTIONS,
  type ProblemCategoryCode,
  type WouldUseCode,
} from "./rubric";

export interface FlaggedQuestion {
  questionId: string;
  preview: string;
  verdict: "needs_fixing" | "reject";
  problemCategories: ProblemCategoryCode[];
}

interface EvaluationSessionSummaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  /**
   * Questions the evaluator flagged in *this* session (verdict needs_fixing
   * or reject). Empty array is fine — the review step renders a benign
   * "nothing flagged" message and the finalize step still requires would_use.
   */
  flaggedQuestions?: FlaggedQuestion[];
  onFinished: () => void;
}

type Step = "review" | "finalize";

const PROBLEM_CATEGORY_LABELS: Record<ProblemCategoryCode, string> = Object.fromEntries(
  PROBLEM_CATEGORIES.map((c) => [c.code, c.label]),
) as Record<ProblemCategoryCode, string>;

const VERDICT_LABELS: Record<"needs_fixing" | "reject", string> = {
  needs_fixing: VERDICT_OPTIONS.find((o) => o.code === "needs_fixing")?.label ?? "needs_fixing",
  reject: VERDICT_OPTIONS.find((o) => o.code === "reject")?.label ?? "reject",
};

/**
 * Tally problem-category occurrences across all flagged questions, return
 * an array sorted by count desc, then by stable category order so equal
 * tallies don't shuffle between renders.
 */
function tallyCategories(
  flagged: FlaggedQuestion[],
): Array<{ code: ProblemCategoryCode; label: string; count: number }> {
  const counts = new Map<ProblemCategoryCode, number>();
  for (const f of flagged) {
    for (const c of f.problemCategories) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return PROBLEM_CATEGORIES.map((opt) => ({
    code: opt.code,
    label: opt.label,
    count: counts.get(opt.code) ?? 0,
  }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

export function EvaluationSessionSummaryDialog({
  open,
  onOpenChange,
  sessionId,
  flaggedQuestions = [],
  onFinished,
}: EvaluationSessionSummaryDialogProps) {
  const [step, setStep] = useState<Step>("review");
  const [overallQuality, setOverallQuality] = useState(3);
  const [recurringProblems, setRecurringProblems] = useState("");
  const [wouldUse, setWouldUse] = useState<WouldUseCode | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the dialog state every time it transitions from closed → open.
  // Without this, a user who cancels mid-flow and re-opens would still be on
  // the finalize step with stale answers from the previous open.
  useEffect(() => {
    if (open) {
      setStep("review");
      setOverallQuality(3);
      setRecurringProblems("");
      setWouldUse(null);
    }
  }, [open]);

  const tallied = useMemo(() => tallyCategories(flaggedQuestions), [flaggedQuestions]);

  const canSubmit = wouldUse !== null;

  const handleAutoFill = () => {
    if (tallied.length === 0) return;
    const text = tallied
      .map((c) => `${c.label} (×${c.count})`)
      .join(" · ");
    setRecurringProblems((prev) =>
      prev.trim().length > 0 ? `${prev.trim()} · ${text}` : text
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("question_evaluation_sessions")
        .update({
          overall_quality: overallQuality,
          recurring_problems: recurringProblems.trim() || null,
          would_use: wouldUse,
          ended_at: new Date().toISOString(),
        })
        .eq("id", sessionId);
      if (error) throw error;
      toast.success("Η σύνοψη αποθηκεύτηκε");
      onFinished();
    } catch (err) {
      console.error("Failed to save session summary", err);
      toast.error("Αποτυχία αποθήκευσης");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[90vh] flex flex-col"
        data-testid="session-summary-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {step === "review"
              ? "Σύνοψη — Επισκόπηση επισημάνσεων"
              : "Σύνοψη — Ολοκλήρωση"}
          </DialogTitle>
          <DialogDescription>
            {step === "review"
              ? "Ελέγξτε τις ερωτήσεις που επισημάνατε σε αυτή τη συνεδρία πριν ολοκληρώσετε."
              : "Καταχωρίστε τη συνολική σας κρίση και ολοκληρώστε τη συνεδρία."}
          </DialogDescription>
        </DialogHeader>

        {step === "review" ? (
          <ReviewStep
            flagged={flaggedQuestions}
            tallied={tallied}
            recurringProblems={recurringProblems}
            onRecurringProblemsChange={setRecurringProblems}
            onAutoFill={handleAutoFill}
          />
        ) : (
          <FinalizeStep
            overallQuality={overallQuality}
            onOverallQualityChange={setOverallQuality}
            wouldUse={wouldUse}
            onWouldUseChange={setWouldUse}
          />
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {step === "review" ? (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={saving}
                data-testid="cancel-summary"
              >
                Ακύρωση
              </Button>
              <Button
                onClick={() => setStep("finalize")}
                data-testid="continue-summary"
              >
                Συνέχεια
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => setStep("review")}
                disabled={saving}
                data-testid="back-summary"
              >
                <ArrowLeft className="w-4 h-4 mr-1.5" />
                Πίσω
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!canSubmit || saving}
                data-testid="submit-summary"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Αποθήκευση…
                  </>
                ) : (
                  "Ολοκλήρωση"
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewStep({
  flagged,
  tallied,
  recurringProblems,
  onRecurringProblemsChange,
  onAutoFill,
}: {
  flagged: FlaggedQuestion[];
  tallied: ReturnType<typeof tallyCategories>;
  recurringProblems: string;
  onRecurringProblemsChange: (next: string) => void;
  onAutoFill: () => void;
}) {
  return (
    <div className="space-y-4 py-2 overflow-hidden flex-1 flex flex-col">
      {flagged.length === 0 ? (
        <div
          className="rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground text-center"
          data-testid="flagged-empty"
        >
          Δεν επισημάνατε ερωτήσεις σε αυτή τη συνεδρία.
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label className="text-sm font-medium">
                Επισημάνσεις αυτής της συνεδρίας
              </Label>
              <span
                className="text-xs text-muted-foreground tabular-nums"
                data-testid="flagged-count"
              >
                {flagged.length}{" "}
                {flagged.length === 1 ? "ερώτηση" : "ερωτήσεις"}
              </span>
            </div>
            {tallied.length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="flagged-tally">
                {tallied.map((c) => (
                  <Badge
                    key={c.code}
                    variant="secondary"
                    className="text-[11px]"
                    data-testid={`flagged-tally-${c.code}`}
                  >
                    {c.label} ×{c.count}
                  </Badge>
                ))}
              </div>
            )}
            <ScrollArea className="max-h-48 rounded-md border">
              <ul className="divide-y" data-testid="flagged-list">
                {flagged.map((f) => (
                  <li
                    key={f.questionId}
                    className="px-3 py-2 text-sm space-y-1"
                    data-testid={`flagged-item-${f.questionId}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex-1 line-clamp-2 text-foreground break-words">
                        {f.preview}
                      </span>
                      <Badge
                        variant={f.verdict === "reject" ? "destructive" : "outline"}
                        className="text-[10px] shrink-0"
                        data-testid={`flagged-verdict-${f.questionId}`}
                      >
                        {VERDICT_LABELS[f.verdict]}
                      </Badge>
                    </div>
                    {f.problemCategories.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {f.problemCategories.map((code) => (
                          <span
                            key={code}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                          >
                            {PROBLEM_CATEGORY_LABELS[code] ?? code}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
        </>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-sm font-medium">Επαναλαμβανόμενα προβλήματα</Label>
          {tallied.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAutoFill}
              className="h-7 text-xs"
              data-testid="autofill-recurring-problems"
            >
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              Συμπλήρωση από επισημάνσεις
            </Button>
          )}
        </div>
        <Textarea
          value={recurringProblems}
          onChange={(e) => onRecurringProblemsChange(e.target.value)}
          rows={3}
          placeholder="Επιβεβαιώστε ή επεξεργαστείτε τη σύνοψη. Αφήστε κενό αν δεν υπάρχουν."
          data-testid="recurring-problems"
        />
      </div>
    </div>
  );
}

function FinalizeStep({
  overallQuality,
  onOverallQualityChange,
  wouldUse,
  onWouldUseChange,
}: {
  overallQuality: number;
  onOverallQualityChange: (next: number) => void;
  wouldUse: WouldUseCode | null;
  onWouldUseChange: (next: WouldUseCode) => void;
}) {
  return (
    <div className="space-y-5 py-2">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Συνολική ποιότητα (1–5)</Label>
        <div className="flex items-center gap-3" data-testid="overall-quality">
          <Slider
            value={[overallQuality]}
            onValueChange={([next]) => onOverallQualityChange(next)}
            min={1}
            max={5}
            step={1}
            aria-label="Συνολική ποιότητα"
            className="max-w-md"
          />
          <span
            className="text-sm font-medium tabular-nums w-6 text-right"
            data-testid="overall-quality-value"
          >
            {overallQuality}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Θα τις χρησιμοποιούσατε;</Label>
        <RadioGroup
          value={wouldUse ?? ""}
          onValueChange={(v) => onWouldUseChange(v as WouldUseCode)}
          data-testid="would-use-group"
        >
          {WOULD_USE_OPTIONS.map((opt) => (
            <div key={opt.code} className="flex items-center gap-2">
              <RadioGroupItem id={`would-${opt.code}`} value={opt.code} />
              <Label htmlFor={`would-${opt.code}`} className="cursor-pointer">
                {opt.label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}
