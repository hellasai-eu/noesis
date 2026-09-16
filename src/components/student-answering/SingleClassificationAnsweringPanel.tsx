import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Lightbulb,
  Undo2,
  RotateCcw,
  FolderTree,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  classificationAssignmentsFromAnswerKey,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationPromptFromPayload,
  questionDiagramFromPayload,
  type ClassificationCategory,
  type ClassificationItem,
} from "@/lib/question-payload";
import { seededShuffle } from "@/lib/seeded-shuffle";
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { AnsweringChrome } from "./AnsweringChrome";
import type { SinglePanelProps } from "./types";
import "katex/dist/katex.min.css";

interface LoadedQuestion {
  id: string;
  prompt: string;
  categories: ClassificationCategory[];
  items: ClassificationItem[];
  canonicalAssignments: Record<string, string>;
  explanation: string;
  difficulty: string;
  diagram?: { source: string; alt?: string } | null;
}

interface SubmittedRecord {
  perItem: Record<string, boolean>;
  allCorrect: boolean;
  submitted: Record<string, string>;
  grade: number;
  hintsUsed: number;
}

interface Placement {
  itemId: string;
  categoryId: string;
}

/**
 * Embeddable single-question classification panel (#755). Fetches one
 * classification question by id and runs the same one-card-at-a-time UX as
 * `StudentClassificationQuestions`: deterministic shuffle of the deck, hint
 * budget, and auto-submit when the last card is placed.
 */
export function SingleClassificationAnsweringPanel({
  questionId,
  courseId,
  onBack,
  onCompleted,
  onStatusChange,
}: SinglePanelProps) {
  const { t } = useTranslation("practice");
  const [question, setQuestion] = useState<LoadedQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [placed, setPlaced] = useState<Placement[]>([]);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [hintCategoryId, setHintCategoryId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

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
          .eq("type", "classification")
          .maybeSingle();
        if (error) throw error;
        if (cancelled || !row) {
          if (!row) toast.error(t("toast.questionNotFound"));
          return;
        }

        const loaded: LoadedQuestion = {
          id: row.id,
          prompt: classificationPromptFromPayload(row.payload),
          categories: classificationCategoriesFromPayload(row.payload),
          items: classificationItemsFromPayload(row.payload),
          canonicalAssignments: classificationAssignmentsFromAnswerKey(row.answer_key),
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
          const submittedMap = (() => {
            try {
              const parsed = JSON.parse(grade.submitted_answer || "{}");
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, string>;
              }
              return {};
            } catch {
              return {} as Record<string, string>;
            }
          })();
          const gr = grade.gap_results as {
            perItem?: Record<string, boolean>;
            allCorrect?: boolean;
            hintsUsed?: number;
          };
          setSubmitted({
            perItem: gr.perItem && typeof gr.perItem === "object" ? gr.perItem : {},
            allCorrect: !!gr.allCorrect,
            submitted: submittedMap,
            grade: grade.grade ?? 0,
            hintsUsed: typeof gr.hintsUsed === "number" ? gr.hintsUsed : 0,
          });
          onStatusChange?.("completed");
        } else {
          onStatusChange?.("not_started");
        }
      } catch (err: any) {
        console.error("Failed to load classification question:", err);
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

  const shuffledItems = useMemo(() => {
    if (!question || !userId) return [];
    return seededShuffle(question.items, `${question.id}::${userId}`);
  }, [question, userId]);

  const initialHints = useMemo(() => {
    if (!question) return 0;
    return Math.max(1, Math.floor(question.items.length / 2));
  }, [question]);

  const hintsRemaining = initialHints - hintsUsed;
  const currentItem = placed.length < shuffledItems.length ? shuffledItems[placed.length] : null;
  const isFinished = placed.length === shuffledItems.length && shuffledItems.length > 0;

  const submitFinal = useCallback(
    async (finalPlacements: Placement[], finalHintsUsed: number) => {
      if (!question || submitting) return;
      setSubmitting(true);
      onStatusChange?.("in_progress");
      try {
        const submittedMap: Record<string, string> = {};
        for (const p of finalPlacements) submittedMap[p.itemId] = p.categoryId;

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
            questionType: "classification",
            submittedAnswer: submittedMap,
            hintsUsed: finalHintsUsed,
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
          perItem?: Record<string, boolean>;
          allCorrect?: boolean;
          hintsUsed?: number;
        };
        const perItem = gr.perItem && typeof gr.perItem === "object" ? gr.perItem : {};
        const allCorrect = !!gr.allCorrect;
        const grade = typeof json.grade === "number" ? json.grade : 0;
        const correctCount = Object.values(perItem).filter(Boolean).length;
        const totalCount = Object.keys(perItem).length;

        setSubmitted({
          perItem,
          allCorrect,
          submitted: submittedMap,
          grade,
          hintsUsed: typeof gr.hintsUsed === "number" ? gr.hintsUsed : finalHintsUsed,
        });
        onStatusChange?.("completed");
        onCompleted?.({ grade, allCorrect });

        if (allCorrect) {
          toast.success(t("classification.allCorrect"));
        } else {
          toast.info(
            t("classification.someCorrect", {
              correct: correctCount,
              total: totalCount,
            }),
          );
        }
      } catch (err: any) {
        console.error("Submit error:", err);
        toast.error(err?.message || t("toast.submitFailed"));
        onStatusChange?.("in_progress");
      } finally {
        setSubmitting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [question, courseId, submitting],
  );

  const handleCategoryClick = (categoryId: string) => {
    if (!currentItem || submitted || submitting) return;
    const nextPlaced = [...placed, { itemId: currentItem.id, categoryId }];
    setPlaced(nextPlaced);
    setHintCategoryId(null);
    if (nextPlaced.length === shuffledItems.length) {
      submitFinal(nextPlaced, hintsUsed);
    }
  };

  const handleHint = () => {
    if (!currentItem || hintsRemaining <= 0 || submitted) return;
    const correctCategoryId = question?.canonicalAssignments[currentItem.id];
    if (!correctCategoryId) return;
    setHintCategoryId(correctCategoryId);
    setHintsUsed((n) => n + 1);
  };

  const handleUndo = () => {
    if (placed.length === 0 || submitted) return;
    setPlaced((prev) => prev.slice(0, -1));
    setHintCategoryId(null);
  };

  const handleRestart = () => {
    if (submitted) return;
    setPlaced([]);
    setHintsUsed(0);
    setHintCategoryId(null);
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
        <AnsweringChrome title={t("classification.title")} onBack={onBack} />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("chrome.unavailable")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const submittedView = submitted !== null;
  const totalItems = shuffledItems.length;
  const currentPosition = Math.min(placed.length + 1, totalItems);

  return (
    <div className="flex flex-col gap-4">
      <AnsweringChrome
        title={t("classification.title")}
        subtitle={
          submittedView
            ? t("classification.subtitleSubmitted")
            : t("classification.subtitle")
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

          {!submittedView ? (
            <>
              <div
                className="flex flex-wrap gap-2 justify-center"
                role="group"
                aria-label={t("classification.categoryBuckets")}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  const buttons = Array.from(
                    e.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button[data-category-button='true']",
                    ),
                  );
                  const current = document.activeElement as HTMLElement | null;
                  const idx = current ? buttons.indexOf(current as HTMLButtonElement) : -1;
                  if (idx < 0) return;
                  e.preventDefault();
                  const delta = e.key === "ArrowRight" ? 1 : -1;
                  const next = buttons[(idx + delta + buttons.length) % buttons.length];
                  next?.focus();
                }}
              >
                {question.categories.map((cat) => {
                  const isHinted = hintCategoryId === cat.id;
                  return (
                    <Button
                      key={cat.id}
                      variant={isHinted ? "default" : "outline"}
                      onClick={() => handleCategoryClick(cat.id)}
                      disabled={!currentItem || submitting}
                      className={`min-w-[120px] h-auto py-3 px-4 gap-2 flex-col items-center ${
                        isHinted
                          ? "ring-2 ring-amber-500 bg-amber-50 hover:bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
                          : ""
                      }`}
                      aria-label={t("classification.placeCard", { category: cat.label })}
                      data-category-button="true"
                    >
                      <FolderTree className="h-5 w-5" />
                      <span
                        className="text-sm font-medium"
                        dangerouslySetInnerHTML={{ __html: processLatexContent(cat.label) }}
                      />
                    </Button>
                  );
                })}
              </div>

              {currentItem ? (
                <Card className="border-2 border-primary/40">
                  <CardContent className="p-6 flex flex-col items-center gap-3">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      ({currentPosition}/{totalItems})
                    </span>
                    <div
                      className="text-lg font-medium text-center prose prose-base dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: processLatexContent(currentItem.text) }}
                    />
                  </CardContent>
                </Card>
              ) : (
                <div className="flex items-center justify-center py-8">
                  {isFinished ? (
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("classification.noCardsLeft")}
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleHint}
                  disabled={!currentItem || hintsRemaining <= 0 || submitting || !!hintCategoryId}
                  className="gap-1.5"
                  aria-label={t("classification.hintAria", { remaining: hintsRemaining })}
                >
                  <Lightbulb className="w-4 h-4" />
                  {t("classification.hint")}
                  <Badge variant="secondary" className="ml-1">
                    {hintsRemaining}
                  </Badge>
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleUndo}
                    disabled={placed.length === 0 || submitting}
                    className="gap-1.5"
                  >
                    <Undo2 className="w-4 h-4" />
                    {t("classification.undo")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRestart}
                    disabled={placed.length === 0 || submitting}
                    className="gap-1.5"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {t("classification.restart")}
                  </Button>
                </div>
              </div>

              {submitting && (
                <div className="flex items-center justify-center pt-2">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">
                    {t("shared.submitting")}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    submitted!.allCorrect
                      ? "bg-green-500/10 text-green-700 border-green-500/20"
                      : "bg-amber-500/10 text-amber-700 border-amber-500/20"
                  }
                >
                  {t("classification.score", {
                    correct: Object.values(submitted!.perItem).filter((v) => v).length,
                    total: Object.keys(submitted!.perItem).length,
                  })}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t("classification.hintsUsed", { count: submitted!.hintsUsed })}
                </span>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">
                  {t("classification.perItemPlacements")}
                </Label>
                <div className="space-y-1.5">
                  {question.items.map((it) => {
                    const submittedCategoryId = submitted!.submitted[it.id];
                    const correctCategoryId = question.canonicalAssignments[it.id];
                    const submittedLabel =
                      question.categories.find((c) => c.id === submittedCategoryId)?.label ?? "—";
                    const correctLabel =
                      question.categories.find((c) => c.id === correctCategoryId)?.label ?? "?";
                    const isCorrect = submitted!.perItem[it.id] === true;
                    return (
                      <div
                        key={it.id}
                        className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                          isCorrect
                            ? "border-green-500/40 bg-green-50/60 dark:bg-green-950/30"
                            : "border-destructive/40 bg-red-50/60 dark:bg-red-950/30"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {isCorrect ? (
                            <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                          ) : (
                            <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                          )}
                          <span
                            className="text-sm truncate"
                            dangerouslySetInnerHTML={{ __html: processLatexContent(it.text) }}
                          />
                        </div>
                        <div className="text-xs text-muted-foreground text-right">
                          <span className={isCorrect ? "text-green-700" : "text-destructive"}>
                            {submittedLabel}
                          </span>
                          {!isCorrect && (
                            <>
                              {" → "}
                              <span className="text-green-700 font-medium">{correctLabel}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

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
                {t("classification.oneSubmissionNote")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default SingleClassificationAnsweringPanel;
