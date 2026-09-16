import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2, X, CircleDot, BookOpen } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { processLatexContent } from "@/lib/latex-utils";
import {
  mcqOptionsFromPayload,
  mcqCorrectIndicesFromAnswerKey,
} from "@/lib/question-payload";
import { renderQuestionStem } from "@/lib/question-stem";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

interface QuestionAnswer {
  questionId: string;
  orderNum: number;
  questionText: string;
  options: string[];
  // Multi-correct (#592). Single-correct items hold a 1-element array.
  correctIndices: number[];
  selectedIndices: number[];
  hasAnswer: boolean;
  isCorrect: boolean | null;
  explanation: string | null;
}

interface StudentQuizReviewProps {
  quizId: string;
  sessionId: string;
  userId: string;
  quizTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const StudentQuizReview = ({
  quizId,
  sessionId,
  userId,
  quizTitle,
  open,
  onOpenChange,
}: StudentQuizReviewProps) => {
  const { t } = useTranslation("student");
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<QuestionAnswer[]>([]);

  useEffect(() => {
    if (!open) return;

    const fetchAnswers = async () => {
      setLoading(true);
      try {
        // Reads the unified `payload` / `answer_key` jsonb columns (#582).
        const { data: quizQs, error: qqError } = await supabase
          .from("quiz_questions")
          .select(
            "order_num, question_id, questions(id, question, payload, answer_key, explanation)",
          )
          .eq("quiz_id", quizId)
          .order("order_num", { ascending: true });

        if (qqError) throw qqError;

        // Prefer answers for this exact session; fall back to quiz-level answers
        // for older rows where session_id may be null.
        const { data: sessionAnswers, error: saError } = await supabase
          .from("quiz_answers")
          .select("question_id, selected_answer, submission, is_correct, answered_at")
          .eq("quiz_id", quizId)
          .eq("user_id", userId)
          .eq("session_id", sessionId);
        if (saError) throw saError;

        let answerRows = sessionAnswers || [];
        if (answerRows.length === 0) {
          const { data: fallbackAnswers, error: faError } = await supabase
            .from("quiz_answers")
            .select("question_id, selected_answer, submission, is_correct, answered_at")
            .eq("quiz_id", quizId)
            .eq("user_id", userId)
            .is("session_id", null);
          if (faError) throw faError;
          answerRows = fallbackAnswers || [];
        }

        const answerMap = new Map<
          string,
          { selected: number[]; isCorrect: boolean; answeredAt: string }
        >();
        answerRows.forEach((a: any) => {
          const existing = answerMap.get(a.question_id);
          if (!existing || a.answered_at > existing.answeredAt) {
            const submissionIndices = (() => {
              const s = a.submission;
              if (s && typeof s === "object" && Array.isArray(s.selected_indices)) {
                return (s.selected_indices as unknown[]).filter(
                  (v): v is number => typeof v === "number",
                );
              }
              return typeof a.selected_answer === "number" ? [a.selected_answer] : [];
            })();
            answerMap.set(a.question_id, {
              selected: submissionIndices,
              isCorrect: a.is_correct,
              answeredAt: a.answered_at,
            });
          }
        });

        const composed: QuestionAnswer[] = (quizQs || []).map((row: any) => {
          const q = row.questions;
          const answer = answerMap.get(row.question_id);
          return {
            questionId: row.question_id,
            orderNum: row.order_num ?? 0,
            questionText: q?.question || "",
            options: mcqOptionsFromPayload(q?.payload ?? null),
            correctIndices: mcqCorrectIndicesFromAnswerKey(q?.answer_key ?? null),
            selectedIndices: answer ? answer.selected : [],
            hasAnswer: !!answer,
            isCorrect: answer ? answer.isCorrect : null,
            explanation: q?.explanation ?? null,
          };
        });

        setItems(composed);
      } catch (error) {
        console.error("Error loading quiz review:", error);
        toast.error(t("quizReview.loadFailed"));
      } finally {
        setLoading(false);
      }
    };

    fetchAnswers();
  }, [open, quizId, userId, sessionId]);

  const correctCount = items.filter((i) => i.isCorrect === true).length;
  const percentage =
    items.length > 0 ? Math.round((correctCount / items.length) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("quizReview.title")}</DialogTitle>
          <DialogDescription>
            {t("quizReview.subtitle", { title: quizTitle })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            {t("quizReview.noQuestions")}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 py-2">
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">
                  {correctCount}/{items.length}
                </p>
                <p className="text-xs text-muted-foreground">{t("quizReview.statCorrect")}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">{percentage}%</p>
                <p className="text-xs text-muted-foreground">{t("quizReview.statScore")}</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">{items.length}</p>
                <p className="text-xs text-muted-foreground">{t("quizReview.statQuestions")}</p>
              </div>
            </div>

            <ScrollableDialogBody className="border rounded-lg">
              <ol className="divide-y">
                {items.map((item, idx) => (
                  <li key={item.questionId} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-muted-foreground">
                            {t("quizReview.questionNumber", { number: idx + 1 })}
                          </span>
                          {!item.hasAnswer ? (
                            <Badge variant="secondary">{t("quizReview.noAnswer")}</Badge>
                          ) : item.isCorrect ? (
                            <Badge className="bg-green-600 hover:bg-green-600">
                              {t("quizReview.correct")}
                            </Badge>
                          ) : (
                            <Badge variant="destructive">{t("quizReview.incorrect")}</Badge>
                          )}
                        </div>
                        <p
                          className="text-sm font-medium whitespace-pre-wrap"
                          dangerouslySetInnerHTML={{
                            __html: processLatexContent(
                              renderQuestionStem(item.questionText, item.correctIndices.length > 1),
                            ),
                          }}
                        />
                      </div>
                    </div>

                    <ul className="space-y-1">
                      {item.options.map((option, optIdx) => {
                        const isSelected = item.selectedIndices.includes(optIdx);
                        const isCorrect = item.correctIndices.includes(optIdx);
                        let style = "border-border bg-background";
                        if (isCorrect) style = "border-green-600 bg-green-50 dark:bg-green-950/30";
                        if (isSelected && !isCorrect) style = "border-red-600 bg-red-50 dark:bg-red-950/30";
                        if (isSelected && isCorrect) style = "border-green-700 bg-green-100 dark:bg-green-950/40";

                        return (
                          <li
                            key={optIdx}
                            className={`flex items-start gap-2 rounded border p-2 text-sm ${style}`}
                          >
                            <span className="mt-0.5 flex h-5 w-5 items-center justify-center">
                              {isCorrect ? (
                                <Check className="h-4 w-4 text-green-700" />
                              ) : isSelected ? (
                                <X className="h-4 w-4 text-red-700" />
                              ) : (
                                <CircleDot className="h-3 w-3 text-muted-foreground" />
                              )}
                            </span>
                            <span
                              className="flex-1"
                              dangerouslySetInnerHTML={{ __html: processLatexContent(option) }}
                            />
                            <span className="flex gap-1 shrink-0">
                              {isSelected && (
                                <Badge variant="outline" className="text-xs">
                                  {t("quizReview.yourAnswer")}
                                </Badge>
                              )}
                              {isCorrect && (
                                <Badge variant="outline" className="text-xs border-green-600 text-green-700">
                                  {t("quizReview.correctAnswer")}
                                </Badge>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    {item.explanation && (
                      <div className="rounded bg-muted/40 p-3 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <BookOpen className="h-3.5 w-3.5" />
                          <span className="font-medium">{t("quizReview.explanation")}</span>
                        </div>
                        <span
                          dangerouslySetInnerHTML={{ __html: processLatexContent(item.explanation) }}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </ScrollableDialogBody>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default StudentQuizReview;
