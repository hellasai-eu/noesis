import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { OpenEditModel } from "@/lib/question-editor";

interface OpenEditorFormProps {
  model: OpenEditModel;
  onChange: (next: OpenEditModel) => void;
}

/**
 * Open-question editor — stem + model answer. `answering_mode` and any rubric
 * are round-tripped untouched (see PreservedFields in question-editor.ts), so
 * editing the model answer never flips a question out of its Socratic /
 * single-shot mode.
 */
export function OpenEditorForm({ model, onChange }: OpenEditorFormProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="open-stem">Question</Label>
        <Textarea
          id="open-stem"
          value={model.stem}
          onChange={(e) => onChange({ ...model, stem: e.target.value })}
          rows={3}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="open-model-answer">Model answer</Label>
        <Textarea
          id="open-model-answer"
          value={model.modelAnswer}
          onChange={(e) => onChange({ ...model, modelAnswer: e.target.value })}
          rows={5}
        />
      </div>
    </div>
  );
}
