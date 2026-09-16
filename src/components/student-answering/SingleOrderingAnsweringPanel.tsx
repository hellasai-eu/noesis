import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, XCircle, Send, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  orderingItemsFromPayload,
  orderingPromptFromPayload,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { seededShuffle } from "@/lib/seeded-shuffle";
import { AnsweringChrome } from "./AnsweringChrome";
import type { SinglePanelProps } from "./types";
import "katex/dist/katex.min.css";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface LoadedQuestion {
  id: string;
  prompt: string;
  canonicalItems: string[];
  explanation: string;
  difficulty: string;
  diagram?: { source: string; alt?: string } | null;
}

interface SubmittedRecord {
  perPosition: boolean[];
  allCorrect: boolean;
  submitted: string[];
  grade: number;
}

interface SortableRowProps {
  uid: string;
  text: string;
  index: number;
  disabled: boolean;
  submittedView: boolean;
  isCorrect: boolean | null;
}

function SortableRow({ uid, text, index, disabled, submittedView, isCorrect }: SortableRowProps) {
  const { t } = useTranslation("practice");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: uid,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-md border p-3 bg-background ${
        submittedView
          ? isCorrect
            ? "border-green-500 bg-green-50 dark:bg-green-950/30"
            : "border-destructive bg-red-50 dark:bg-red-950/30"
          : ""
      }`}
    >
      <button
        type="button"
        className={`text-muted-foreground ${
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-grab hover:text-foreground active:cursor-grabbing"
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded`}
        aria-label={t("ordering.dragItem", { position: index + 1 })}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-5 w-5" />
      </button>
      <span className="text-xs text-muted-foreground w-6 text-right tabular-nums">
        {index + 1}.
      </span>
      <span
        className="flex-1 text-sm"
        dangerouslySetInnerHTML={{ __html: processLatexContent(text) }}
      />
      {submittedView && isCorrect === true && (
        <CheckCircle2 className="w-4 h-4 text-green-600" />
      )}
      {submittedView && isCorrect === false && (
        <XCircle className="w-4 h-4 text-destructive" />
      )}
    </div>
  );
}

/**
 * Embeddable single-question ordering panel (#755). Fetches one ordering
 * question by id, renders the DnD list seeded per (question, user) so the
 * shuffled order is stable across re-renders, and submits via
 * `grade-deterministic-answer`.
 */
export function SingleOrderingAnsweringPanel({
  questionId,
  courseId,
  onBack,
  onCompleted,
  onStatusChange,
}: SinglePanelProps) {
  const { t } = useTranslation("practice");
  const [question, setQuestion] = useState<LoadedQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentOrder, setCurrentOrder] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<SubmittedRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        if (!cancelled) setUserId(user.id);

        const { data: row, error } = await supabase
          .from("questions")
          .select("id, payload, answer_key, explanation, difficulty, hidden, type")
          .eq("id", questionId)
          .eq("type", "ordering")
          .maybeSingle();
        if (error) throw error;
        if (cancelled || !row) {
          if (!row) toast.error(t("toast.questionNotFound"));
          return;
        }

        const loaded: LoadedQuestion = {
          id: row.id,
          prompt: orderingPromptFromPayload(row.payload),
          canonicalItems: orderingItemsFromPayload(row.payload),
          explanation: row.explanation || "",
          difficulty: row.difficulty,
          diagram: questionDiagramFromPayload(row.payload),
        };

        const { data: grade } = await supabase
          .from("open_question_grades")
          .select("grade, submitted_answer, gap_results")
          .eq("open_question_id", questionId)
          .eq("user_id", user.id)
          .maybeSingle();

        if (cancelled) return;
        setQuestion(loaded);

        if (grade && grade.gap_results) {
          const submittedArr = (() => {
            try {
              const parsed = JSON.parse(grade.submitted_answer || "[]");
              return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
            } catch {
              return [];
            }
          })();
          const gr = grade.gap_results as { perPosition?: boolean[]; allCorrect?: boolean };
          setSubmitted({
            perPosition: Array.isArray(gr.perPosition) ? gr.perPosition : [],
            allCorrect: !!gr.allCorrect,
            submitted: submittedArr,
            grade: grade.grade ?? 0,
          });
          setCurrentOrder(submittedArr);
          onStatusChange?.("completed");
        } else {
          onStatusChange?.("not_started");
        }
      } catch (err: any) {
        console.error("Failed to load ordering question:", err);
        toast.error(t("toast.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  // Stable per-(question, user) shuffle. Identical seed key to the list-based
  // component so a student dropping in via the unified surface sees the same
  // order they would have via the standalone list.
  const initialShuffledItems = useMemo(() => {
    if (!question || !userId) return [];
    return seededShuffle(question.canonicalItems, `${question.id}::${userId}`);
  }, [question, userId]);

  useEffect(() => {
    if (question && !submitted && currentOrder.length === 0 && initialShuffledItems.length > 0) {
      setCurrentOrder(initialShuffledItems);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialShuffledItems, question]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (submitted) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setCurrentOrder((prev) => {
      const oldIndex = prev.indexOf(String(active.id));
      const newIndex = prev.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleSubmit = async () => {
    if (!question || submitting) return;
    setSubmitting(true);
    onStatusChange?.("in_progress");
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error(t("toast.notAuthenticated"));
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/grade-deterministic-answer`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          questionId: question.id,
          courseId,
          questionType: "ordering",
          submittedAnswer: currentOrder,
        }),
      });
      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || json.error) {
        if (json.error === "already_submitted") {
          toast.info(json.message || t("toast.alreadySubmitted"));
          setSubmitting(false);
          onStatusChange?.("completed");
          onCompleted?.();
          return;
        }
        throw new Error(json.message || json.error || t("toast.submitFailed"));
      }

      const gr = (json.gapResults ?? {}) as {
        perPosition?: boolean[];
        allCorrect?: boolean;
      };
      const perPosition = Array.isArray(gr.perPosition) ? gr.perPosition : [];
      const allCorrect = !!gr.allCorrect;
      const correctCount = perPosition.filter(Boolean).length;
      const totalCount = perPosition.length;
      const grade = typeof json.grade === "number" ? json.grade : 0;

      setSubmitted({
        perPosition,
        allCorrect,
        submitted: [...currentOrder],
        grade,
      });
      onStatusChange?.("completed");
      onCompleted?.({ grade, allCorrect });

      if (allCorrect) {
        toast.success(t("ordering.allCorrect"));
      } else {
        toast.info(
          t("ordering.someCorrect", { correct: correctCount, total: totalCount }),
        );
      }
    } catch (err: any) {
      console.error("Submit error:", err);
      toast.error(err?.message || t("toast.submitFailed"));
      onStatusChange?.("in_progress");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!question) {
    return (
      <div className="flex flex-col gap-4">
        <AnsweringChrome title={t("ordering.title")} onBack={onBack} />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("chrome.unavailable")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const submittedView = submitted !== null;

  return (
    <div className="flex flex-col gap-4">
      <AnsweringChrome
        title={t("ordering.title")}
        subtitle={
          submittedView
            ? t("ordering.subtitleSubmitted")
            : t("ordering.subtitle")
        }
        difficulty={question.difficulty}
        onBack={onBack}
      />

      <Card>
        <CardContent className="p-4 space-y-4">
          {question.diagram?.source && (
            <QuestionDiagram
              source={question.diagram.source}
              alt={question.diagram.alt ?? null}
            />
          )}
          <div
            className="text-base font-medium prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: formatQuestionText(question.prompt) }}
          />

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={currentOrder} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {currentOrder.map((item, idx) => {
                  const isCorrect = submittedView ? submitted!.perPosition[idx] ?? false : null;
                  return (
                    <SortableRow
                      key={item}
                      uid={item}
                      text={item}
                      index={idx}
                      disabled={submittedView || submitting}
                      submittedView={submittedView}
                      isCorrect={isCorrect}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>

          {submittedView && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    submitted!.allCorrect
                      ? "bg-green-500/10 text-green-700 border-green-500/20"
                      : "bg-amber-500/10 text-amber-700 border-amber-500/20"
                  }
                >
                  {t("ordering.score", {
                    correct: submitted!.perPosition.filter(Boolean).length,
                    total: submitted!.perPosition.length,
                  })}
                </Badge>
              </div>
              {!submitted!.allCorrect && (
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">
                    {t("ordering.correctOrder")}
                  </Label>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    {question.canonicalItems.map((item) => (
                      <li key={item} className="font-medium">
                        <span dangerouslySetInnerHTML={{ __html: processLatexContent(item) }} />
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {question.explanation && (
                <div>
                  <Label className="text-muted-foreground text-xs">
                    {t("shared.explanation")}
                  </Label>
                  <div
                    className="mt-1 text-sm prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: formatQuestionText(question.explanation) }}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground italic">
                {t("ordering.oneSubmissionNote")}
              </p>
            </div>
          )}

          {!submittedView && (
            <div className="flex justify-end pt-2 border-t">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || currentOrder.length === 0}
                className="gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {submitting ? t("shared.submitting") : t("shared.submit")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default SingleOrderingAnsweringPanel;
