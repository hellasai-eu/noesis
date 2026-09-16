import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OrderingEditModel } from "@/lib/question-editor";

interface OrderingEditorFormProps {
  model: OrderingEditModel;
  onChange: (next: OrderingEditModel) => void;
}

/**
 * Ordering editor — a prompt and the items in their CANONICAL (correct)
 * sequence. The stored order *is* the answer key (the player shuffles at render
 * time), so the up/down controls are how the instructor sets the answer.
 */
export function OrderingEditorForm({ model, onChange }: OrderingEditorFormProps) {
  const setItem = (i: number, value: string) => {
    const items = [...model.items];
    items[i] = value;
    onChange({ ...model, items });
  };

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= model.items.length) return;
    const items = [...model.items];
    [items[i], items[j]] = [items[j], items[i]];
    onChange({ ...model, items });
  };

  const addItem = () => onChange({ ...model, items: [...model.items, ""] });
  const removeItem = (i: number) =>
    onChange({ ...model, items: model.items.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ordering-prompt">Prompt</Label>
        <Textarea
          id="ordering-prompt"
          value={model.prompt}
          onChange={(e) => onChange({ ...model, prompt: e.target.value })}
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label>Items (top-to-bottom is the correct order)</Label>
        {model.items.map((item, i) => (
          <div key={i} className="flex items-center gap-2" data-testid="ordering-item-row">
            <span className="w-5 text-right text-sm text-muted-foreground">{i + 1}</span>
            <Input value={item} onChange={(e) => setItem(i, e.target.value)} placeholder="Item" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label={`Move item ${i + 1} up`}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => move(i, 1)}
              disabled={i === model.items.length - 1}
              aria-label={`Move item ${i + 1} down`}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeItem(i)}
              aria-label={`Remove item ${i + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addItem}>
          <Plus className="mr-1 h-4 w-4" /> Add item
        </Button>
      </div>
    </div>
  );
}
