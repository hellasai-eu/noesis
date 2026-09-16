import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ClassificationEditModel } from "@/lib/question-editor";

interface ClassificationEditorFormProps {
  model: ClassificationEditModel;
  onChange: (next: ClassificationEditModel) => void;
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${prefix}-${rand}`;
}

/**
 * Classification editor — categories + items, with each item's correct category
 * chosen from a dropdown. The item→category map is held in `assignments` and
 * written to `answer_key` only (never the student-facing `payload`), so the
 * renderer can't leak the answer.
 */
export function ClassificationEditorForm({ model, onChange }: ClassificationEditorFormProps) {
  const setCategoryLabel = (id: string, label: string) =>
    onChange({
      ...model,
      categories: model.categories.map((c) => (c.id === id ? { ...c, label } : c)),
    });

  const addCategory = () =>
    onChange({ ...model, categories: [...model.categories, { id: newId("cat"), label: "" }] });

  const removeCategory = (id: string) => {
    const assignments = { ...model.assignments };
    for (const [itemId, catId] of Object.entries(assignments)) {
      if (catId === id) delete assignments[itemId];
    }
    onChange({
      ...model,
      categories: model.categories.filter((c) => c.id !== id),
      assignments,
    });
  };

  const setItemText = (id: string, text: string) =>
    onChange({ ...model, items: model.items.map((it) => (it.id === id ? { ...it, text } : it)) });

  const setItemCategory = (itemId: string, categoryId: string) =>
    onChange({ ...model, assignments: { ...model.assignments, [itemId]: categoryId } });

  const addItem = () =>
    onChange({ ...model, items: [...model.items, { id: newId("item"), text: "" }] });

  const removeItem = (id: string) => {
    const assignments = { ...model.assignments };
    delete assignments[id];
    onChange({ ...model, items: model.items.filter((it) => it.id !== id), assignments });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="classification-prompt">Prompt</Label>
        <Textarea
          id="classification-prompt"
          value={model.prompt}
          onChange={(e) => onChange({ ...model, prompt: e.target.value })}
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label>Categories</Label>
        {model.categories.map((c) => (
          <div key={c.id} className="flex items-center gap-2" data-testid="classification-category-row">
            <Input
              value={c.label}
              onChange={(e) => setCategoryLabel(c.id, e.target.value)}
              placeholder="Category label"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeCategory(c.id)}
              aria-label={`Remove category ${c.label || "(unnamed)"}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addCategory}>
          <Plus className="mr-1 h-4 w-4" /> Add category
        </Button>
      </div>

      <div className="space-y-2">
        <Label>Items (each assigned to its correct category)</Label>
        {model.items.map((it) => (
          <div key={it.id} className="flex items-center gap-2" data-testid="classification-item-row">
            <Input
              value={it.text}
              onChange={(e) => setItemText(it.id, e.target.value)}
              placeholder="Item text"
            />
            <Select
              value={model.assignments[it.id] ?? ""}
              onValueChange={(v) => setItemCategory(it.id, v)}
            >
              <SelectTrigger className="w-40" aria-label={`Category for ${it.text || "item"}`}>
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {model.categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.label || "(unnamed)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeItem(it.id)}
              aria-label={`Remove item ${it.text || "(empty)"}`}
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
