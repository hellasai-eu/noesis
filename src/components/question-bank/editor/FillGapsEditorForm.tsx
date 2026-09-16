import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FillGapsEditModel, FillGapEntry } from "@/lib/question-editor";

interface FillGapsEditorFormProps {
  model: FillGapsEditModel;
  onChange: (next: FillGapsEditModel) => void;
}

/**
 * Fill-the-gaps editor — a cloze stem with numbered `{{1}}`, `{{2}}` … blanks
 * and one row of acceptable answers per blank. Gap ordinals are always the
 * row position (1..N, contiguous), which is the exact invariant
 * validateFillGapsQuestion enforces against the stem's placeholders.
 */
export function FillGapsEditorForm({ model, onChange }: FillGapsEditorFormProps) {
  const renumber = (gaps: FillGapEntry[]): FillGapEntry[] =>
    gaps.map((g, i) => ({ ...g, ordinal: i + 1 }));

  const setGaps = (gaps: FillGapEntry[]) => onChange({ ...model, gaps: renumber(gaps) });

  const setAcceptable = (gapIdx: number, accIdx: number, value: string) => {
    const gaps = model.gaps.map((g, i) => {
      if (i !== gapIdx) return g;
      const acceptable = [...g.acceptable];
      acceptable[accIdx] = value;
      return { ...g, acceptable };
    });
    onChange({ ...model, gaps });
  };

  const addAcceptable = (gapIdx: number) =>
    onChange({
      ...model,
      gaps: model.gaps.map((g, i) =>
        i === gapIdx ? { ...g, acceptable: [...g.acceptable, ""] } : g,
      ),
    });

  const removeAcceptable = (gapIdx: number, accIdx: number) =>
    onChange({
      ...model,
      gaps: model.gaps.map((g, i) =>
        i === gapIdx ? { ...g, acceptable: g.acceptable.filter((_, k) => k !== accIdx) } : g,
      ),
    });

  const addGap = () => setGaps([...model.gaps, { ordinal: 0, acceptable: [""] }]);
  const removeGap = (gapIdx: number) => setGaps(model.gaps.filter((_, i) => i !== gapIdx));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="fill-gaps-stem">Sentence</Label>
        <Textarea
          id="fill-gaps-stem"
          value={model.stem}
          onChange={(e) => onChange({ ...model, stem: e.target.value })}
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Mark each blank with {"{{1}}"}, {"{{2}}"}, … numbered from 1 with no gaps.
        </p>
      </div>

      <div className="space-y-3">
        <Label>Gaps</Label>
        {model.gaps.map((gap, gapIdx) => (
          <div key={gapIdx} className="rounded-md border p-3 space-y-2" data-testid="fill-gap-editor">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Gap {gap.ordinal}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeGap(gapIdx)}
                aria-label={`Remove gap ${gap.ordinal}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {gap.acceptable.map((acc, accIdx) => (
              <div key={accIdx} className="flex items-center gap-2">
                <Input
                  value={acc}
                  onChange={(e) => setAcceptable(gapIdx, accIdx, e.target.value)}
                  placeholder="Acceptable answer"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeAcceptable(gapIdx, accIdx)}
                  aria-label={`Remove acceptable answer ${accIdx + 1} for gap ${gap.ordinal}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => addAcceptable(gapIdx)}>
              <Plus className="mr-1 h-4 w-4" /> Add acceptable answer
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addGap}>
          <Plus className="mr-1 h-4 w-4" /> Add gap
        </Button>
      </div>
    </div>
  );
}
