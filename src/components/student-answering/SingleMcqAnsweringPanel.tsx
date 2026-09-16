import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  CheckCircle,
  XCircle,
  ArrowRight,
  BookOpen,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatExplanation } from "@/lib/utils";
import { processLatexContent } from "@/lib/latex-utils";
import {
  mcqOptionsFromPayload,
  mcqCorrectIndicesFromAnswerKey,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import { submitQuizAnswers } from "@/lib/submit-quiz-answers";
import { renderQuestionStem } from "@/lib/question-stem";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { AnsweringChrome } from "./AnsweringChrome";
import type { SinglePanelProps } from "./types";
import "katex/dist/katex.min.css";

interface LoadedQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndices: number[];
  explanation: string;
  difficulty: string;
  isUserGenerated: boolean;
  diagram?: { source: string; alt?: string } | null;
}

/**
 * Embeddable single-question MCQ practice panel (#755). Persists an attempt
 * via `quiz_answers` with `quiz_id: null` — the practice-mode shape — so the
 * unified `useStudentPracticeQuestions` hook (#753) picks up the result via
 * its existing MCQ status reconciliation (completed when any attempt is
 * correct, in_progress when there are attempts but none correct).
 *
 * The attempt goes through `submitQuizAnswers`, which grades it server-side
 * (#1094); the panel sends `submission.selected_indices` per the #592 contract
 * and the legacy `selected_answer` is derived there.
 */
export function SingleMcqAnsweringPanel({
  questionId,
  courseId,
  offeringId,
  onBack,
  onCompleted,
  onStatusChange,
}: SinglePanelProps) {
  const { t } = useTranslation("practice");
  const { user } = useAuth();
  const [question, setQuestion] = useState<LoadedQuestion | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [lastAttemptCorrect, setLastAttemptCorrect] = useState<boolean | null>(null);
  const [hasPriorCorrect, setHasPriorCorrect] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [userVote, setUserVote] = useState<"up" | "down" | null>(null);
  const [voting, setVoting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: row, error } = await supabase
          .from("questions")
          .select(
            "id, question, payload, answer_key, explanation, difficulty, is_user_generated, hidden, type",
          )
          .eq("id", questionId)
          .eq("type", "mcq")
          .maybeSingle();
        if (error) throw error;
        if (cancelled || !row) {
          if (!row) toast.error(t("toast.questionNotFound"));
          return;
        }

        const loaded: LoadedQuestion = {
          id: row.id,
          question: row.question ?? "",
          options: mcqOptionsFromPayload(row.payload),
          correctIndices: mcqCorrectIndicesFromAnswerKey(row.answer_key),
          explanation: row.explanation || "",
          difficulty: row.difficulty,
          isUserGenerated: !!row.is_user_generated,
          diagram: questionDiagramFromPayload(row.payload),
        };

        if (cancelled) return;
        setQuestion(loaded);

        if (user) {
          // Check practice-mode attempts only (quiz_id IS NULL) so timed-quiz
          // attempts don't surface as completion in the practice surface.
          const { data: priorRows } = await supabase
            .from("quiz_answers")
            .select("is_correct")
            .eq("user_id", user.id)
            .eq("question_id", questionId)
            .is("quiz_id", null);
          const rows = priorRows ?? [];
          const anyCorrect = rows.some((r) => !!r.is_correct);
          if (!cancelled) {
            setHasPriorCorrect(anyCorrect);
            if (anyCorrect) onStatusChange?.("completed");
            else if (rows.length > 0) onStatusChange?.("in_progress");
            else onStatusChange?.("not_started");
          }

          const { data: vote } = await supabase
            .from("question_votes")
            .select("vote_type")
            .eq("user_id", user.id)
            .eq("question_id", questionId)
            .maybeSingle();
          if (!cancelled && vote?.vote_type) {
            setUserVote(vote.vote_type as "up" | "down");
          }
        }
      } catch (err: any) {
        console.error("Failed to load MCQ question:", err);
        toast.error(t("toast.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, user?.id]);

  const handleSelect = (index: number) => {
    if (submitting || showResult) return;
    setSelectedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return [...next].sort((a, b) => a - b);
    });
  };

  const handleSubmit = async () => {
    if (!question || !user || selectedAnswers.length === 0 || submitting) return;
    setSubmitting(true);
    onStatusChange?.("in_progress");
    try {
      // The verdict is the server's (#1094) — this panel sends the picks and
      // reads back what was recorded.
      const result = await submitQuizAnswers({
        courseId,
        offeringId: offeringId ?? null,
        quizId: null,
        sessionId: crypto.randomUUID(),
        answers: [
          { questionId: question.id, submission: { selected_indices: selectedAnswers } },
        ],
      });
      const isCorrect = result.results[0]?.isCorrect ?? false;

      setLastAttemptCorrect(isCorrect);
      setShowResult(true);
      if (isCorrect) {
        setHasPriorCorrect(true);
        onStatusChange?.("completed");
        onCompleted?.({ grade: 100, allCorrect: true });
      } else {
        onStatusChange?.("in_progress");
      }
    } catch (err: any) {
      console.error("Failed to save MCQ answer:", err);
      toast.error(t("toast.saveAnswerFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleTryAgain = () => {
    setSelectedAnswers([]);
    setShowResult(false);
    setLastAttemptCorrect(null);
  };

  const handleVote = async (voteType: "up" | "down") => {
    if (!user || !question || voting) return;
    setVoting(true);
    try {
      if (userVote === voteType) {
        await supabase
          .from("question_votes")
          .delete()
          .eq("user_id", user.id)
          .eq("question_id", question.id);
        setUserVote(null);
        toast.success(t("toast.voteRemoved"));
      } else {
        await supabase
          .from("question_votes")
          .upsert(
            { user_id: user.id, question_id: question.id, vote_type: voteType },
            { onConflict: "user_id,question_id" },
          );
        setUserVote(voteType);
        toast.success(t("toast.voteThanks"));
      }
    } catch (err: any) {
      console.error("Vote error:", err);
      toast.error(t("toast.voteFailed"));
    } finally {
      setVoting(false);
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
        <AnsweringChrome title={t("chrome.questionFallbackTitle")} onBack={onBack} />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {t("chrome.unavailable")}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AnsweringChrome
        title={t("mcq.title")}
        subtitle={
          hasPriorCorrect
            ? t("mcq.subtitlePriorCorrect")
            : t("mcq.subtitle")
        }
        difficulty={question.difficulty}
        onBack={onBack}
        rightSlot={
          question.isUserGenerated ? (
            <Badge
              variant="secondary"
              className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-xs"
            >
              {t("shared.peer")}
            </Badge>
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          {question.diagram?.source && (
            <QuestionDiagram
              source={question.diagram.source}
              alt={question.diagram.alt ?? null}
            />
          )}
          <CardTitle
            className="text-xl leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: processLatexContent(
                renderQuestionStem(question.question, question.correctIndices.length > 1),
              ),
            }}
          />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            {question.options.map((option, index) => {
              const isSelected = selectedAnswers.includes(index);
              const isCorrect = question.correctIndices.includes(index);
              let optionClass =
                "border rounded-xl p-4 cursor-pointer transition-all flex items-center gap-4";
              if (showResult) {
                if (isCorrect) optionClass += " border-green-500 bg-green-500/10";
                else if (isSelected) optionClass += " border-red-500 bg-red-500/10";
                else optionClass += " border-border opacity-50";
              } else if (isSelected) {
                optionClass += " border-primary bg-primary/5 ring-2 ring-primary/20";
              } else {
                optionClass += " border-border hover:border-primary/50 hover:bg-secondary/50";
              }
              return (
                <div
                  key={index}
                  role="checkbox"
                  aria-checked={isSelected}
                  className={optionClass}
                  onClick={() => handleSelect(index)}
                >
                  <span
                    className={`w-6 h-6 rounded-md border-2 flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                      isSelected
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/30"
                    }`}
                    aria-hidden="true"
                  >
                    {isSelected && <CheckCircle className="w-4 h-4" />}
                  </span>
                  <span className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-sm font-medium flex-shrink-0">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span
                    className="flex-1 text-left"
                    dangerouslySetInnerHTML={{ __html: processLatexContent(option) }}
                  />
                  {showResult && isCorrect && (
                    <CheckCircle className="w-6 h-6 text-green-500" />
                  )}
                  {showResult && isSelected && !isCorrect && (
                    <XCircle className="w-6 h-6 text-red-500" />
                  )}
                </div>
              );
            })}
          </div>

          {showResult && question.explanation && (
            <div className="mt-6 p-4 rounded-xl bg-muted/50 border">
              <div className="flex items-center gap-2 mb-3">
                <BookOpen className="w-4 h-4 text-primary" />
                <span className="font-medium text-sm">{t("shared.explanation")}</span>
              </div>
              <div
                className="text-sm text-muted-foreground leading-relaxed prose prose-sm max-w-none [&_p]:mb-3 [&_strong]:text-foreground [&_strong]:font-semibold"
                dangerouslySetInnerHTML={{
                  __html: processLatexContent(formatExplanation(question.explanation)),
                }}
              />
            </div>
          )}

          {showResult && (
            <div className="mt-2 flex items-center justify-between p-3 rounded-lg bg-muted/30 border">
              <span className="text-sm text-muted-foreground">{t("vote.prompt")}</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleVote("up")}
                  disabled={voting}
                  className={`gap-1 ${userVote === "up" ? "text-green-600 bg-green-500/10" : ""}`}
                >
                  <ThumbsUp className="w-4 h-4" />
                  <span className="text-xs">{t("vote.helpful")}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleVote("down")}
                  disabled={voting}
                  className={`gap-1 ${userVote === "down" ? "text-red-600 bg-red-500/10" : ""}`}
                >
                  <ThumbsDown className="w-4 h-4" />
                  <span className="text-xs">{t("vote.issue")}</span>
                </Button>
              </div>
            </div>
          )}

          <div className="flex justify-end pt-2 border-t">
            {!showResult ? (
              <Button
                onClick={handleSubmit}
                disabled={selectedAnswers.length === 0 || submitting}
                className="min-w-[140px]"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  t("shared.submitAnswer")
                )}
              </Button>
            ) : (
              <div className="flex items-center gap-3">
                <Badge
                  variant="outline"
                  className={
                    lastAttemptCorrect
                      ? "bg-green-500/10 text-green-700 border-green-500/20"
                      : "bg-red-500/10 text-red-700 border-red-500/20"
                  }
                >
                  {lastAttemptCorrect ? t("shared.correct") : t("shared.incorrect")}
                </Badge>
                {!lastAttemptCorrect && (
                  <Button variant="outline" onClick={handleTryAgain}>
                    {t("shared.tryAgain")}
                  </Button>
                )}
                <Button onClick={onBack} className="min-w-[140px]">
                  {t("shared.done")}
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default SingleMcqAnsweringPanel;
