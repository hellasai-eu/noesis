import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import { supabase } from "@/integrations/supabase/client";
import {
  QUESTION_TYPES,
  type QuestionType,
} from "@/types/question";
import { QUESTION_TYPE_LABELS, type UnifiedQuestionRaw } from "@/lib/unified-question";
import {
  parseEditModel,
  buildAndValidate,
  DIFFICULTIES,
  type QuestionEditModel,
  type QuestionColumns,
  type Difficulty,
  type EditError,
} from "@/lib/question-editor";

import { McqEditorForm } from "./McqEditorForm";
import { OpenEditorForm } from "./OpenEditorForm";
import { FillGapsEditorForm } from "./FillGapsEditorForm";
import { OrderingEditorForm } from "./OrderingEditorForm";
import { ClassificationEditorForm } from "./ClassificationEditorForm";

export interface SavedQuestion {
  id: string;
  type: QuestionType;
  columns: QuestionColumns;
}

interface QuestionEditorDialogProps {
  questionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (saved: SavedQuestion) => void;
}

function isQuestionType(v: string): v is QuestionType {
  return (QUESTION_TYPES as readonly string[]).includes(v);
}

/**
 * The one dialog that edits any of the five question types (#1001). Self-loads
 * the target row so it can be mounted from anywhere with just an id (the
 * Question Bank and the study-guide piece editor both use it). Validation lives
 * in `buildAndValidate`; persistence goes through the `update_question_content`
 * SECURITY DEFINER RPC, which refuses the edit when a student has already
 * answered the question.
 */
export function QuestionEditorDialog({
  questionId,
  open,
  onOpenChange,
  onSaved,
}: QuestionEditorDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [model, setModel] = useState<QuestionEditModel | null>(null);
  const [type, setType] = useState<QuestionType | null>(null);
  const [errors, setErrors] = useState<EditError[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !questionId) return;
    let cancelled = false;
    setLoading(true);
    setErrors([]);
    setLoadError(null);
    setModel(null);
    (async () => {
      const { data, error } = await supabase
        .from("questions")
        .select("id, type, question, payload, answer_key, explanation, difficulty")
        .eq("id", questionId)
        .single();
      if (cancelled) return;
      if (error || !data) {
        setLoadError(error?.message ?? "Question not found.");
        setLoading(false);
        return;
      }
      if (!isQuestionType(data.type)) {
        setLoadError(`Unsupported question type "${data.type}".`);
        setLoading(false);
        return;
      }
      const raw: UnifiedQuestionRaw = {
        question: data.question ?? null,
        payload: data.payload ?? null,
        answer_key: data.answer_key ?? null,
        explanation: data.explanation ?? null,
        generation_rationale: null,
      };
      setType(data.type);
      setModel(parseEditModel(data.type, raw, data.difficulty));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, questionId]);

  const handleSave = useCallback(async () => {
    if (!model || !questionId || !type) return;
    const result = buildAndValidate(model);
    // `result.ok === false`, not `!result.ok`: this project compiles with
    // `strict: false`, under which the negation does not narrow the
    // discriminated union and `result.errors` below is a type error.
    if (result.ok === false) {
      setErrors(result.errors);
      toast.error("Please fix the highlighted problems before saving.");
      return;
    }
    setErrors([]);
    setSaving(true);
    const { columns } = result;
    const { error } = await supabase.rpc("update_question_content", {
      _question_id: questionId,
      _question: columns.question ?? "",
      _payload: columns.payload,
      _answer_key: columns.answer_key,
      _explanation: columns.explanation,
      _difficulty: columns.difficulty,
    });
    setSaving(false);
    if (error) {
      if (/cannot be edited/i.test(error.message)) {
        toast.error("This question has already been answered by a student and can no longer be edited.");
      } else {
        toast.error(`Could not save the question: ${error.message}`);
      }
      return;
    }
    toast.success("Question updated.");
    onSaved({ id: questionId, type, columns });
    onOpenChange(false);
  }, [model, questionId, type, onSaved, onOpenChange]);

  const setTyped = useCallback(
    (typed: QuestionEditModel["typed"]) =>
      setModel((prev) => (prev ? { ...prev, typed } : prev)),
    [],
  );

  const setDifficulty = (difficulty: Difficulty) =>
    setModel((prev) => (prev ? { ...prev, shared: { ...prev.shared, difficulty } } : prev));

  const setExplanation = (explanation: string) =>
    setModel((prev) => (prev ? { ...prev, shared: { ...prev.shared, explanation } } : prev));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit question{type ? ` — ${QUESTION_TYPE_LABELS[type]}` : ""}</DialogTitle>
          <DialogDescription>
            Fix the content in place. Changing the question type is not supported here.
          </DialogDescription>
        </DialogHeader>

        <ScrollableDialogBody className="space-y-4 pr-1">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}

          {loadError && !loading && (
            <p className="py-8 text-sm text-destructive" role="alert">
              {loadError}
            </p>
          )}

          {model && !loading && (
            <>
              {model.typed.kind === "mcq" && (
                <McqEditorForm model={model.typed} onChange={setTyped} />
              )}
              {model.typed.kind === "open" && (
                <OpenEditorForm model={model.typed} onChange={setTyped} />
              )}
              {model.typed.kind === "fill_gaps" && (
                <FillGapsEditorForm model={model.typed} onChange={setTyped} />
              )}
              {model.typed.kind === "ordering" && (
                <OrderingEditorForm model={model.typed} onChange={setTyped} />
              )}
              {model.typed.kind === "classification" && (
                <ClassificationEditorForm model={model.typed} onChange={setTyped} />
              )}

              <div className="space-y-2">
                <Label htmlFor="question-explanation">Explanation (optional)</Label>
                <Textarea
                  id="question-explanation"
                  value={model.shared.explanation}
                  onChange={(e) => setExplanation(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="question-difficulty">Difficulty</Label>
                <Select
                  value={model.shared.difficulty}
                  onValueChange={(v) => setDifficulty(v as Difficulty)}
                >
                  <SelectTrigger id="question-difficulty" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIFFICULTIES.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d.charAt(0).toUpperCase() + d.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {errors.length > 0 && (
                <div
                  className="rounded-md border border-destructive/50 bg-destructive/10 p-3"
                  data-testid="editor-errors"
                  role="alert"
                >
                  <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
                    {errors.map((err, i) => (
                      <li key={i}>{err.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </ScrollableDialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || loading || !model}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
