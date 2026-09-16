import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import type { McqEditModel } from "@/lib/question-editor";

interface McqEditorFormProps {
  model: McqEditModel;
  onChange: (next: McqEditModel) => void;
}

/**
 * MCQ editor — stem + N options, each with a "correct" checkbox so multi-correct
 * (#592) is editable. Removing an option re-indexes the correct set so the
 * answer key never dangles.
 */
export function McqEditorForm({ model, onChange }: McqEditorFormProps) {
  const setOption = (i: number, value: string) => {
    const options = [...model.options];
    options[i] = value;
    onChange({ ...model, options });
  };

  const toggleCorrect = (i: number) => {
    const set = new Set(model.correctIndices);
    if (set.has(i)) set.delete(i);
    else set.add(i);
    onChange({ ...model, correctIndices: [...set].sort((a, b) => a - b) });
  };

  const addOption = () => onChange({ ...model, options: [...model.options, ""] });

  const removeOption = (i: number) => {
    const options = model.options.filter((_, idx) => idx !== i);
    const correctIndices = model.correctIndices
      .filter((ci) => ci !== i)
      .map((ci) => (ci > i ? ci - 1 : ci));
    onChange({ ...model, options, correctIndices });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="mcq-stem">Question</Label>
        <Textarea
          id="mcq-stem"
          value={model.stem}
          onChange={(e) => onChange({ ...model, stem: e.target.value })}
          rows={3}
        />
      </div>

      <div className="space-y-2">
        <Label>Options (check every correct answer)</Label>
        {model.options.map((opt, i) => (
          <div key={i} className="flex items-center gap-2" data-testid="mcq-option-row">
            <Checkbox
              checked={model.correctIndices.includes(i)}
              onCheckedChange={() => toggleCorrect(i)}
              aria-label={`Option ${i + 1} is correct`}
            />
            <Input
              value={opt}
              onChange={(e) => setOption(i, e.target.value)}
              placeholder={`Option ${String.fromCharCode(65 + i)}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeOption(i)}
              aria-label={`Remove option ${i + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addOption}>
          <Plus className="mr-1 h-4 w-4" /> Add option
        </Button>
      </div>
    </div>
  );
}
