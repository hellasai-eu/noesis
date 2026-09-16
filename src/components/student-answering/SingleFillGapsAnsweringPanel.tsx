import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, XCircle, Send } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsStemFromPayload,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import { processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { AnsweringChrome } from "./AnsweringChrome";
import type { SinglePanelProps } from "./types";
import "katex/dist/katex.min.css";

interface LoadedQuestion {
  id: string;
  stem: string;
  gaps: { ordinal: number; acceptable: string[] }[];
  explanation: string;
  difficulty: string;
  diagram?: { source: string; alt?: string } | null;
}

interface SubmittedRecord {
  perGap: boolean[];
  allCorrect: boolean;
  submitted: string[];
  grade: number;
}

function splitStem(
  stem: string,
): Array<{ kind: "text"; value: string } | { kind: "gap"; ordinal: number }> {
  const out: Array<{ kind: "text"; value: string } | { kind: "gap"; ordinal: number }> = [];
  const re = /\{\{(\d+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stem)) !== null) {
    out.push({ kind: "text", value: stem.slice(lastIndex, match.index) });
    out.push({ kind: "gap", ordinal: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  out.push({ kind: "text", value: stem.slice(lastIndex) });
  return out;
}

/**
 * Embeddable single-question fill-the-gaps panel (#755). Fetches one
 * fill_gaps question by id, renders the inputs, and submits via the same
 * `grade-deterministic-answer` edge function used by the list-based
 * `StudentFillGapsQuestions`. No list, no selection — owned by the parent.
 */
export function SingleFillGapsAnsweringPanel({
  questionId,
  courseId,
  onBack,
  onCompleted,
  onStatusChange,
}: SinglePanelProps) {
  const { t } = useTranslation("practice");
  const [question, setQuestion] = useState<LoadedQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<SubmittedRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const { data: row, error } = await supabase
          .from("questions")
          .select("id, payload, answer_key, explanation, difficulty, hidden, type")
          .eq("id", questionId)
          .eq("type", "fill_gaps")
          .maybeSingle();
        if (error) throw error;
        if (cancelled || !row) {
          if (!row) toast.error(t("toast.questionNotFound"));
          return;
        }

        const loaded: LoadedQuestion = {
          id: row.id,
          stem: fillGapsStemFromPayload(row.payload),
          gaps: fillGapsAcceptableAnswersFromAnswerKey(row.answer_key),
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
        setInputs(new Array(loaded.gaps.length).fill(""));

        if (grade && grade.gap_results) {
          const submittedArr = (() => {
            try {
              const parsed = JSON.parse(grade.submitted_answer || "[]");
              return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
            } catch {
              return [];
            }
          })();
          const gr = grade.gap_results as { perGap?: boolean[]; allCorrect?: boolean };
          setSubmitted({
            perGap: Array.isArray(gr.perGap) ? gr.perGap : [],
            allCorrect: !!gr.allCorrect,
            submitted: submittedArr,
            grade: grade.grade ?? 0,
          });
          onStatusChange?.("completed");
        } else {
          onStatusChange?.("not_started");
        }
      } catch (err: any) {
        console.error("Failed to load fill-gaps question:", err);
        toast.error(t("toast.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // onStatusChange/onCompleted are intentionally NOT deps — callers will
    // commonly inline arrow functions and we don't want to re-fetch the
    // whole question every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  const handleSubmit = async () => {
    if (!question || submitting) return;
    if (inputs.some((v) => v.trim().length === 0)) {
      toast.error(t("fillGaps.fillEveryBlank"));
      return;
    }
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
          questionType: "fill_gaps",
          submittedAnswer: inputs,
        }),
      });
      const json = await resp.json().catch(() => ({}));

      if (!resp.ok || json.error) {
        if (json.error === "already_submitted") {
          toast.info(json.message || t("toast.alreadySubmitted"));
          // Re-hydrate to surface the persisted grade in the read-only view.
          setSubmitting(false);
          onStatusChange?.("completed");
          onCompleted?.();
          return;
        }
        throw new Error(json.message || json.error || t("toast.submitFailed"));
      }

      const gr = (json.gapResults ?? {}) as { perGap?: boolean[]; allCorrect?: boolean };
      const perGap = Array.isArray(gr.perGap) ? gr.perGap : [];
      const allCorrect = !!gr.allCorrect;
      const correctCount = perGap.filter(Boolean).length;
      const totalCount = perGap.length;
      const grade = typeof json.grade === "number" ? json.grade : 0;

      setSubmitted({ perGap, allCorrect, submitted: [...inputs], grade });
      onStatusChange?.("completed");
      onCompleted?.({ grade, allCorrect });

      if (allCorrect) {
        toast.success(t("fillGaps.allCorrect"));
      } else {
        toast.info(
          t("fillGaps.someCorrect", { correct: correctCount, total: totalCount }),
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
        <AnsweringChrome title={t("fillGaps.title")} onBack={onBack} />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("chrome.unavailable")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const segments = splitStem(question.stem);
  const submittedView = submitted !== null;
  const GAP_INPUT_WIDTH_CH = 15;

  return (
    <div className="flex flex-col gap-4">
      <AnsweringChrome
        title={t("fillGaps.title")}
        subtitle={
          submittedView
            ? t("fillGaps.subtitleSubmitted")
            : t("fillGaps.subtitle")
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
          <div className="flex flex-wrap items-baseline gap-x-1 gap-y-2 text-base leading-relaxed">
            {segments.map((seg, i) => {
              if (seg.kind === "text") {
                return (
                  <span
                    key={`t-${i}`}
                    className="whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{ __html: processLatexContent(seg.value) }}
                  />
                );
              }
              const gapIndex = question.gaps.findIndex((g) => g.ordinal === seg.ordinal);
              if (gapIndex < 0) {
                return (
                  <span key={`g-${i}`} className="text-destructive italic">
                    ___({seg.ordinal})
                  </span>
                );
              }
              const submittedValue = submittedView ? submitted!.submitted[gapIndex] || "" : "";
              const isCorrect = submittedView ? submitted!.perGap[gapIndex] : null;
              return (
                <span key={`g-${i}`} className="inline-flex items-center gap-1">
                  <Input
                    aria-label={t("fillGaps.gapAria", { ordinal: seg.ordinal })}
                    value={submittedView ? submittedValue : inputs[gapIndex] || ""}
                    onChange={(e) => {
                      if (submittedView) return;
                      setInputs((prev) => {
                        const next = [...prev];
                        next[gapIndex] = e.target.value;
                        return next;
                      });
                    }}
                    disabled={submittedView || submitting}
                    style={{ width: `${GAP_INPUT_WIDTH_CH}ch` }}
                    className={`inline h-8 px-2 text-sm align-baseline ${
                      submittedView
                        ? isCorrect
                          ? "border-green-500 bg-green-50 dark:bg-green-950/30"
                          : "border-destructive bg-red-50 dark:bg-red-950/30"
                        : ""
                    }`}
                  />
                  {submittedView && isCorrect === true && (
                    <CheckCircle2 className="w-4 h-4 text-green-600 inline" />
                  )}
                  {submittedView && isCorrect === false && (
                    <XCircle className="w-4 h-4 text-destructive inline" />
                  )}
                </span>
              );
            })}
          </div>

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
                  {t("fillGaps.score", {
                    correct: submitted!.perGap.filter(Boolean).length,
                    total: submitted!.perGap.length,
                  })}
                </Badge>
              </div>
              {!submitted!.allCorrect && (
                <div className="space-y-1">
                  <Label className="text-muted-foreground text-xs">
                    {t("fillGaps.expectedAnswers")}
                  </Label>
                  <ul className="text-sm space-y-1">
                    {question.gaps.map((g, idx) => {
                      if (submitted!.perGap[idx]) return null;
                      return (
                        <li key={g.ordinal} className="flex items-baseline gap-2">
                          <span className="text-xs text-muted-foreground">
                            {t("fillGaps.gapLabel", { ordinal: g.ordinal })}
                          </span>
                          <span className="font-medium">{g.acceptable[0]}</span>
                          {g.acceptable.length > 1 && (
                            <span className="text-xs text-muted-foreground">
                              {t("fillGaps.alsoAccepted", {
                        answers: g.acceptable.slice(1).join(", "),
                      })}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {question.explanation && (
                <div>
                  <Label className="text-muted-foreground text-xs">
                    {t("shared.explanation")}
                  </Label>
                  {/* The ordering and classification panels beside this one
                      render their explanation; fill-gaps printed it raw. */}
                  <div
                    className="mt-1 text-sm"
                    dangerouslySetInnerHTML={{
                      __html: processLatexContent(question.explanation),
                    }}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground italic">
                {t("fillGaps.oneSubmissionNote")}
              </p>
            </div>
          )}

          {!submittedView && (
            <div className="flex justify-end pt-2 border-t">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={submitting || inputs.some((v) => v.trim().length === 0)}
                className="gap-2"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
                {submitting ? t("shared.submitting") : t("shared.submit")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default SingleFillGapsAnsweringPanel;
