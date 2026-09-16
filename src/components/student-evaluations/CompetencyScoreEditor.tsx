import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface CompetencyGridEntry {
  competencyId: string;
  title: string;
  score: number | null;
  rationale: string | null;
  status: "scored" | "insufficient" | "missing";
  isManual: boolean;
}

interface CompetencyScoreEditorProps {
  entry: CompetencyGridEntry;
  evaluationId: string | null;
  canEdit: boolean;
  hasEvaluation: boolean;
  onSaved: (updated: CompetencyGridEntry) => void;
}

const scoreBadgeProps = (
  score: number,
): { variant: "outline" | "destructive"; className: string } => {
  if (score >= 70)
    return {
      variant: "outline",
      className:
        "border-green-500 text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950",
    };
  if (score >= 40)
    return {
      variant: "outline",
      className:
        "border-amber-500 text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950",
    };
  return { variant: "destructive", className: "" };
};

const ScoreBadge = ({ entry }: { entry: CompetencyGridEntry }) => {
  if (entry.status === "scored" && entry.score !== null) {
    const props = scoreBadgeProps(entry.score);
    return (
      <Badge
        variant={props.variant}
        className={`shrink-0 tabular-nums ${props.className}`.trim()}
      >
        {entry.score}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0 text-muted-foreground">
      N/A
    </Badge>
  );
};

const ReadOnlyRow = ({
  entry,
  hasEvaluation,
}: {
  entry: CompetencyGridEntry;
  hasEvaluation: boolean;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <div className="flex items-center gap-2 p-2 rounded-md bg-secondary/30 cursor-help min-w-0">
        <span className="text-sm truncate flex-1" title={entry.title}>
          {entry.title}
        </span>
        {entry.isManual && (
          <Pencil
            className="w-3 h-3 shrink-0 text-muted-foreground"
            aria-label="Manually edited"
          />
        )}
        <ScoreBadge entry={entry} />
      </div>
    </TooltipTrigger>
    <TooltipContent side="top" className="max-w-xs">
      <div className="space-y-1">
        <div className="font-medium text-xs">{entry.title}</div>
        {entry.status === "scored" && (
          <p className="text-xs">
            {entry.rationale || "No rationale provided."}
          </p>
        )}
        {entry.status === "insufficient" && (
          <p className="text-xs text-muted-foreground">
            {entry.rationale || "Not enough data to score this competency."}
          </p>
        )}
        {entry.status === "missing" && (
          <p className="text-xs text-muted-foreground">
            {hasEvaluation
              ? "This competency was not assessed in the latest evaluation."
              : "No evaluation has been generated yet."}
          </p>
        )}
      </div>
    </TooltipContent>
  </Tooltip>
);

export const CompetencyScoreEditor = ({
  entry,
  evaluationId,
  canEdit,
  hasEvaluation,
  onSaved,
}: CompetencyScoreEditorProps) => {
  const [open, setOpen] = useState(false);
  const [scoreInput, setScoreInput] = useState<string>(
    entry.score !== null ? String(entry.score) : "",
  );
  const [rationaleInput, setRationaleInput] = useState<string>(
    entry.rationale ?? "",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setScoreInput(entry.score !== null ? String(entry.score) : "");
      setRationaleInput(entry.rationale ?? "");
    }
  }, [open, entry.score, entry.rationale]);

  const editable = canEdit && !!evaluationId;

  if (!editable) {
    return <ReadOnlyRow entry={entry} hasEvaluation={hasEvaluation} />;
  }

  const parsedScore = Number(scoreInput);
  const scoreValid =
    scoreInput.trim() !== "" &&
    Number.isFinite(parsedScore) &&
    parsedScore >= 0 &&
    parsedScore <= 100;

  const handleSave = async () => {
    if (!scoreValid || !evaluationId) return;

    const previous = entry;
    const trimmedRationale = rationaleInput.trim();
    const optimistic: CompetencyGridEntry = {
      ...entry,
      score: parsedScore,
      rationale: trimmedRationale || null,
      status: "scored",
      isManual: true,
    };

    setSaving(true);
    onSaved(optimistic);

    const { error } = await supabase
      .from("evaluation_competency_scores")
      .upsert(
        {
          evaluation_id: evaluationId,
          competency_id: entry.competencyId,
          score: parsedScore,
          rationale: trimmedRationale || null,
          is_manual: true,
        },
        { onConflict: "evaluation_id,competency_id" },
      );

    setSaving(false);

    if (error) {
      onSaved(previous);
      toast.error(`Failed to save score: ${error.message}`);
      return;
    }

    toast.success("Competency score updated");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit score for ${entry.title}`}
          className="flex items-center gap-2 p-2 rounded-md bg-secondary/30 hover:bg-secondary/60 transition-colors min-w-0 w-full text-left"
        >
          <span className="text-sm truncate flex-1" title={entry.title}>
            {entry.title}
          </span>
          {entry.isManual && (
            <Pencil
              className="w-3 h-3 shrink-0 text-muted-foreground"
              aria-label="Manually edited"
            />
          )}
          <ScoreBadge entry={entry} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h4 className="font-medium text-sm">{entry.title}</h4>
            <p className="text-xs text-muted-foreground">
              Edit the score and rationale. Changes are marked as manually
              edited.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`score-${entry.competencyId}`} className="text-xs">
              Score (0–100)
            </Label>
            <Input
              id={`score-${entry.competencyId}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              value={scoreInput}
              onChange={(e) => setScoreInput(e.target.value)}
              disabled={saving}
            />
            {!scoreValid && scoreInput.trim() !== "" && (
              <p className="text-xs text-destructive">
                Score must be a number between 0 and 100.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label
              htmlFor={`rationale-${entry.competencyId}`}
              className="text-xs"
            >
              Rationale
            </Label>
            <Textarea
              id={`rationale-${entry.competencyId}`}
              rows={3}
              value={rationaleInput}
              onChange={(e) => setRationaleInput(e.target.value)}
              placeholder="Why this score?"
              disabled={saving}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={!scoreValid || saving}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default CompetencyScoreEditor;
