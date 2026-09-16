import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import { Check, Loader2, X, CircleDot } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { processLatexContent } from "@/lib/latex-utils";
import { toast } from "sonner";
import {
  mcqCorrectIndicesFromAnswerKey,
  mcqOptionsFromPayload,
} from "@/lib/question-payload";
import { renderQuestionStem } from "@/lib/question-stem";

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
  answeredAt: string | null;
  explanation: string | null;
}

interface StudentAnswerDrillDownProps {
  quizId: string;
  userId: string;
  offeringId: string | null;
  studentName: string;
  quizTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const StudentAnswerDrillDown = ({
  quizId,
  userId,
  offeringId,
  studentName,
  quizTitle,
  open,
  onOpenChange,
}: StudentAnswerDrillDownProps) => {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<QuestionAnswer[]>([]);

  useEffect(() => {
    if (!open) return;

    const fetchAnswers = async () => {
      setLoading(true);
      try {
        const { data: quizQs, error: qqError } = await supabase
          .from("quiz_questions")
          .select(
            "order_num, question_id, questions(id, question, payload, answer_key, explanation)",
          )
          .eq("quiz_id", quizId)
          .order("order_num", { ascending: true });

        if (qqError) throw qqError;

        let answersQuery = supabase
          .from("quiz_answers")
          .select("question_id, selected_answer, submission, is_correct, answered_at")
          .eq("quiz_id", quizId)
          .eq("user_id", userId);

        if (offeringId) {
          answersQuery = answersQuery.eq("offering_id", offeringId);
        }

        const { data: answers, error: answersError } = await answersQuery;
        if (answersError) throw answersError;

        const answerMap = new Map<
          string,
          { selected: number[]; isCorrect: boolean; answeredAt: string }
        >();
        (answers || []).forEach((a: any) => {
          const existing = answerMap.get(a.question_id);
          if (!existing || a.answered_at > existing.answeredAt) {
            const selected: number[] = (() => {
              const s = a.submission;
              if (s && typeof s === "object" && Array.isArray(s.selected_indices)) {
                return (s.selected_indices as unknown[]).filter(
                  (v): v is number => typeof v === "number",
                );
              }
              return typeof a.selected_answer === "number" ? [a.selected_answer] : [];
            })();
            answerMap.set(a.question_id, {
              selected,
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
            answeredAt: answer ? answer.answeredAt : null,
            explanation: q?.explanation ?? null,
          };
        });

        setItems(composed);
      } catch (error: any) {
        console.error("Error loading student answers:", error);
        toast.error("Failed to load student answers");
      } finally {
        setLoading(false);
      }
    };

    fetchAnswers();
  }, [open, quizId, userId, offeringId]);

  const answeredCount = items.filter((i) => i.hasAnswer).length;
  const correctCount = items.filter((i) => i.isCorrect === true).length;
  const percentage =
    answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{studentName}'s Answers</DialogTitle>
          <DialogDescription>
            {quizTitle} — read-only view of each question and the student's response
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            No questions found for this quiz.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 py-2">
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">
                  {correctCount}/{answeredCount}
                </p>
                <p className="text-xs text-muted-foreground">Correct</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">{percentage}%</p>
                <p className="text-xs text-muted-foreground">Score</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">{items.length}</p>
                <p className="text-xs text-muted-foreground">Questions</p>
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
                            Q{idx + 1}
                          </span>
                          {!item.hasAnswer ? (
                            <Badge variant="secondary">No answer</Badge>
                          ) : item.isCorrect ? (
                            <Badge className="bg-green-600 hover:bg-green-600">
                              Correct
                            </Badge>
                          ) : (
                            <Badge variant="destructive">Incorrect</Badge>
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
                        const isStudent = item.selectedIndices.includes(optIdx);
                        const isCorrect = item.correctIndices.includes(optIdx);
                        let style = "border-border bg-background";
                        if (isCorrect) style = "border-green-600 bg-green-50 dark:bg-green-950/30";
                        if (isStudent && !isCorrect) style = "border-red-600 bg-red-50 dark:bg-red-950/30";
                        if (isStudent && isCorrect) style = "border-green-700 bg-green-100 dark:bg-green-950/40";

                        return (
                          <li
                            key={optIdx}
                            className={`flex items-start gap-2 rounded border p-2 text-sm ${style}`}
                          >
                            <span className="mt-0.5 flex h-5 w-5 items-center justify-center">
                              {isCorrect ? (
                                <Check className="h-4 w-4 text-green-700" />
                              ) : isStudent ? (
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
                              {isStudent && (
                                <Badge variant="outline" className="text-xs">
                                  Student
                                </Badge>
                              )}
                              {isCorrect && (
                                <Badge variant="outline" className="text-xs border-green-600 text-green-700">
                                  Correct
                                </Badge>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    {item.explanation && (
                      <div className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">
                        <span className="font-medium">Explanation: </span>
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

export default StudentAnswerDrillDown;
