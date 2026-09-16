/**
 * One student's submitted study-guide answers (#981) — and, for open
 * questions, the place the instructor grades them.
 *
 * Shaped after `quiz/StudentAnswerDrillDown` — same dialog, same option
 * colouring, same at-a-glance tallies. Three things differ because a study
 * guide is not a quiz:
 *
 *   1. Answers are grouped by PIECE, in sequence order, and pieces the student
 *      has not reached are shown as such rather than as unanswered questions.
 *      "Not there yet" and "got it wrong" are different facts about a learner.
 *   2. Deterministic answers carry their grade from submit; OPEN answers are
 *      recorded ungraded and held for instructor review — the AI never
 *      grades. This dialog is where the instructor sets the grade and the
 *      feedback the student sees, with the AI's manager-only review draft
 *      shown as an aid.
 *   3. The quiz drill-down has only correctness to show.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import { Check, CircleDot, Loader2, Lock, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { processLatexContent } from "@/lib/latex-utils";
import { toast } from "sonner";
import { mcqCorrectIndicesFromAnswerKey, mcqOptionsFromPayload } from "@/lib/question-payload";
import { renderQuestionStem } from "@/lib/question-stem";
import type { Json } from "@/integrations/supabase/types";
import type { QuestionType } from "@/types/question";
import { readPlayerAnswer } from "@/lib/study-guide-player";
import { answerCountsAsCorrect, answerIsPendingReview } from "@/lib/study-guide-analytics";

interface Props {
  studyGuideId: string;
  offeringId: string;
  userId: string;
  studentName: string;
  guideTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface DrillQuestion {
  questionId: string;
  type: QuestionType;
  text: string;
  options: string[];
  correctIndices: number[];
  selectedIndices: number[];
  openText: string | null;
  hasAnswer: boolean;
  isCorrect: boolean | null;
  grade: number | null;
  feedback: string | null;
  strengths: string[] | null;
  areasForImprovement: string[] | null;
  explanation: string | null;
  /** AI review draft (manager-only) for a pending open answer, if any. */
  draftFeedback: string | null;
}

interface DrillPiece {
  pieceId: string;
  position: number;
  title: string;
  /** True when the student's progress has not reached this piece. */
  notReached: boolean;
  questions: DrillQuestion[];
}

export function StudyGuideAnswerDrillDown({
  studyGuideId,
  offeringId,
  userId,
  studentName,
  guideTitle,
  open,
  onOpenChange,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [pieces, setPieces] = useState<DrillPiece[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const fetchAnswers = async () => {
      setLoading(true);
      try {
        const { data: pieceRows, error: pieceError } = await supabase
          .from("study_guide_pieces")
          .select("id, position, title")
          .eq("study_guide_id", studyGuideId)
          .order("position", { ascending: true });
        if (pieceError) throw pieceError;
        const pieceList = pieceRows ?? [];

        const { data: linkRows, error: linkError } = pieceList.length
          ? await supabase
              .from("study_guide_piece_questions")
              .select(
                "piece_id, position, question_id, questions(id, type, question, payload, answer_key, explanation)",
              )
              .in("piece_id", pieceList.map((p) => p.id))
              .order("position", { ascending: true })
          : { data: [], error: null };
        if (linkError) throw linkError;

        const { data: answerRows, error: answerError } = await supabase
          .from("study_guide_answers")
          .select(
            "question_id, piece_id, submission, is_correct, grade, feedback, strengths, areas_for_improvement",
          )
          .eq("study_guide_id", studyGuideId)
          .eq("offering_id", offeringId)
          .eq("user_id", userId);
        if (answerError) throw answerError;

        // AI review drafts for this student's open answers — manager-only
        // aid; the student never sees these.
        const questionIds = (linkRows ?? []).map(
          (r) => (r as { question_id: string }).question_id,
        );
        const { data: draftRows } = questionIds.length
          ? await supabase
              .from("open_answer_ai_drafts")
              .select("question_id, feedback")
              .eq("user_id", userId)
              // Scoped to this surface and offering — a draft about the same
              // question answered elsewhere describes a different answer.
              .eq("source", "study_guide")
              .eq("offering_id", offeringId)
              .in("question_id", questionIds)
          : { data: [] };
        const draftByQuestion = new Map(
          (draftRows ?? []).map((d) => [d.question_id, d.feedback]),
        );

        const { data: progressRow } = await supabase
          .from("study_guide_progress")
          .select("current_piece_position")
          .eq("study_guide_id", studyGuideId)
          .eq("offering_id", offeringId)
          .eq("user_id", userId)
          .maybeSingle();
        const currentPosition = progressRow?.current_piece_position ?? 0;

        const answerByQuestion = new Map(
          (answerRows ?? []).map((a) => [a.question_id, a]),
        );

        const byPiece = new Map<string, DrillQuestion[]>();
        for (const row of linkRows ?? []) {
          const link = row as unknown as {
            piece_id: string;
            question_id: string;
            questions: {
              id: string;
              type: string;
              question: string | null;
              payload: Json | null;
              answer_key: Json | null;
              explanation: string | null;
            };
          };
          const q = link.questions;
          const type = (q?.type ?? "mcq") as QuestionType;
          const answer = answerByQuestion.get(link.question_id);
          // Only the MCQ and open branches are rendered below, and neither
          // needs the per-type extras on AnswerableQuestion (ordering's
          // canonical order, classification's items, …) — so id + type is
          // enough to reconstruct what this view shows.
          const parsed = answer
            ? readPlayerAnswer(
                { id: link.question_id, type },
                { submission: answer.submission },
                userId,
              )
            : null;
          const entry: DrillQuestion = {
            questionId: link.question_id,
            type,
            text: q?.question ?? "",
            options: mcqOptionsFromPayload(q?.payload ?? null),
            correctIndices: mcqCorrectIndicesFromAnswerKey(q?.answer_key ?? null),
            selectedIndices: parsed?.kind === "mcq" ? parsed.selected : [],
            openText: parsed?.kind === "open" ? parsed.text : null,
            hasAnswer: !!answer,
            isCorrect: answer?.is_correct ?? null,
            grade: answer?.grade ?? null,
            feedback: answer?.feedback ?? null,
            strengths: answer?.strengths ?? null,
            areasForImprovement: answer?.areas_for_improvement ?? null,
            explanation: q?.explanation ?? null,
            draftFeedback: draftByQuestion.get(link.question_id) ?? null,
          };
          const list = byPiece.get(link.piece_id);
          if (list) list.push(entry);
          else byPiece.set(link.piece_id, [entry]);
        }

        const composed: DrillPiece[] = pieceList.map((p) => ({
          pieceId: p.id,
          position: p.position,
          title: p.title,
          notReached: p.position > currentPosition,
          questions: byPiece.get(p.id) ?? [],
        }));

        if (!cancelled) setPieces(composed);
      } catch (error) {
        console.error("Error loading study guide answers:", error);
        if (!cancelled) toast.error("Failed to load this student's answers");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchAnswers();
    return () => {
      cancelled = true;
    };
  }, [open, studyGuideId, offeringId, userId]);

  const answered = pieces.flatMap((p) => p.questions).filter((q) => q.hasAnswer);
  // Pending open answers count as neither correct nor incorrect.
  const gradable = answered.filter(
    (q) => !answerIsPendingReview({
      userId,
      questionId: q.questionId,
      pieceId: "",
      selectedIndices: q.selectedIndices,
      isCorrect: q.isCorrect,
      grade: q.grade,
    }),
  );
  const correct = gradable.filter((q) =>
    answerCountsAsCorrect({
      userId,
      questionId: q.questionId,
      pieceId: "",
      selectedIndices: q.selectedIndices,
      isCorrect: q.isCorrect,
      grade: q.grade,
    }),
  ).length;
  const grades = answered.map((q) => q.grade).filter((g): g is number => typeof g === "number");
  const meanScore =
    grades.length > 0 ? Math.round(grades.reduce((s, g) => s + g, 0) / grades.length) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle>{studentName}'s answers</DialogTitle>
          <DialogDescription>
            {guideTitle} — read-only view of every piece and this student's responses
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : pieces.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            This study guide has no pieces.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 py-2">
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-xl font-bold">
                  {correct}/{gradable.length}
                </p>
                <p className="text-xs text-muted-foreground">Correct</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-xl font-bold">
                  {meanScore === null ? "—" : `${meanScore}%`}
                </p>
                <p className="text-xs text-muted-foreground">Mean score</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-xl font-bold">
                  {pieces.filter((p) => !p.notReached).length}/{pieces.length}
                </p>
                <p className="text-xs text-muted-foreground">Pieces reached</p>
              </div>
            </div>

            <ScrollableDialogBody className="rounded-lg border">
              <ol className="divide-y">
                {pieces.map((piece, pieceIdx) => (
                  <li key={piece.pieceId} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{pieceIdx + 1}</Badge>
                      <span className="text-sm font-semibold">{piece.title}</span>
                      {piece.notReached && (
                        <Badge variant="secondary" className="gap-1">
                          <Lock className="h-3 w-3" /> Not reached yet
                        </Badge>
                      )}
                    </div>

                    {piece.notReached ? (
                      <p className="text-xs text-muted-foreground">
                        The student has not unlocked this piece, so there is nothing to show.
                      </p>
                    ) : piece.questions.length === 0 ? (
                      <p className="text-xs italic text-muted-foreground">
                        This piece has no questions.
                      </p>
                    ) : (
                      <ol className="space-y-4">
                        {piece.questions.map((q, idx) => (
                          <QuestionBlock
                            key={q.questionId}
                            question={q}
                            index={idx}
                            gradeKeys={{ studyGuideId, offeringId, userId }}
                            onGraded={(questionId, grade, feedback) =>
                              setPieces((prev) =>
                                prev.map((pp) => ({
                                  ...pp,
                                  questions: pp.questions.map((qq) =>
                                    qq.questionId === questionId
                                      ? { ...qq, grade, feedback }
                                      : qq,
                                  ),
                                })),
                              )
                            }
                          />
                        ))}
                      </ol>
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
}

function QuestionBlock({
  question,
  index,
  gradeKeys,
  onGraded,
}: {
  question: DrillQuestion;
  index: number;
  gradeKeys: { studyGuideId: string; offeringId: string; userId: string };
  onGraded: (questionId: string, grade: number, feedback: string | null) => void;
}) {
  const isPendingOpen =
    question.type === "open" && question.hasAnswer && typeof question.grade !== "number";
  const [gradeInput, setGradeInput] = useState<string>("");
  const [feedbackInput, setFeedbackInput] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const saveGrade = async () => {
    const parsed = Number(gradeInput);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      toast.error("Enter a grade between 0 and 100");
      return;
    }
    setSaving(true);
    try {
      const trimmedFeedback = feedbackInput.trim() || null;
      // The manager UPDATE policy on study_guide_answers exists precisely for
      // this write; only the grading columns are ever touched.
      const { error } = await supabase
        .from("study_guide_answers")
        .update({
          grade: parsed,
          feedback: trimmedFeedback,
          graded_at: new Date().toISOString(),
        })
        .eq("study_guide_id", gradeKeys.studyGuideId)
        .eq("offering_id", gradeKeys.offeringId)
        .eq("user_id", gradeKeys.userId)
        .eq("question_id", question.questionId);
      if (error) throw error;
      onGraded(question.questionId, parsed, trimmedFeedback);
      toast.success("Grade saved");
    } catch (error) {
      console.error("Error saving grade:", error);
      toast.error("Failed to save the grade");
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="space-y-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold text-muted-foreground">Q{index + 1}</span>
        {!question.hasAnswer ? (
          <Badge variant="secondary">No answer</Badge>
        ) : question.isCorrect === true ? (
          <Badge className="bg-green-600 hover:bg-green-600">Correct</Badge>
        ) : question.isCorrect === false ? (
          <Badge variant="destructive">Incorrect</Badge>
        ) : typeof question.grade === "number" ? (
          <Badge variant="outline">Grade: {question.grade}/100</Badge>
        ) : question.type === "open" ? (
          <Badge variant="outline" className="bg-amber-500/10 text-amber-700 border-amber-500/20">
            Pending review
          </Badge>
        ) : null}
      </div>

      <p
        className="whitespace-pre-wrap text-sm font-medium"
        dangerouslySetInnerHTML={{
          __html: processLatexContent(
            renderQuestionStem(question.text, question.correctIndices.length > 1),
          ),
        }}
      />

      {question.type === "mcq" && question.options.length > 0 && (
        <ul className="space-y-1">
          {question.options.map((option, optIdx) => {
            const isStudent = question.selectedIndices.includes(optIdx);
            const isCorrect = question.correctIndices.includes(optIdx);
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
                <span className="flex shrink-0 gap-1">
                  {isStudent && (
                    <Badge variant="outline" className="text-xs">
                      Student
                    </Badge>
                  )}
                  {isCorrect && (
                    <Badge variant="outline" className="border-green-600 text-xs text-green-700">
                      Correct
                    </Badge>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {question.type === "open" && question.hasAnswer && (
        <p className="whitespace-pre-wrap rounded border bg-background p-2 text-sm">
          {question.openText || <span className="italic text-muted-foreground">(blank)</span>}
        </p>
      )}

      {/* Non-MCQ objective types (ordering, classification, fill-the-gaps) have
          no single canonical read-only rendering here; their grade and the
          grader's feedback below carry the information the instructor needs. */}
      {question.hasAnswer && question.type !== "mcq" && question.type !== "open" && (
        <p className="text-xs text-muted-foreground">
          {typeof question.grade === "number"
            ? `Answered — graded ${question.grade}/100.`
            : "Answered."}
        </p>
      )}

      {/* Instructor grading for a pending open answer. The AI draft (when
          one exists) is an aid the instructor can adopt, edit, or ignore —
          the student sees only what is saved here. */}
      {isPendingOpen && (
        <div className="space-y-2 rounded border border-amber-500/30 bg-amber-500/5 p-3">
          {question.draftFeedback && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-blue-700 dark:text-blue-300">
                AI review draft (not visible to the student)
              </p>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {question.draftFeedback}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFeedbackInput(question.draftFeedback!)}
              >
                Use draft as feedback
              </Button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="w-24">
              <Label htmlFor={`grade-${question.questionId}`} className="text-xs">
                Grade (0-100)
              </Label>
              <Input
                id={`grade-${question.questionId}`}
                type="number"
                min={0}
                max={100}
                value={gradeInput}
                onChange={(e) => setGradeInput(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={saveGrade} disabled={saving || gradeInput === ""}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save grade"}
            </Button>
          </div>
          <div>
            <Label htmlFor={`feedback-${question.questionId}`} className="text-xs">
              Feedback for the student (optional)
            </Label>
            <Textarea
              id={`feedback-${question.questionId}`}
              rows={2}
              value={feedbackInput}
              onChange={(e) => setFeedbackInput(e.target.value)}
            />
          </div>
        </div>
      )}

      {(question.feedback ||
        (question.strengths?.length ?? 0) > 0 ||
        (question.areasForImprovement?.length ?? 0) > 0) && (
        <div className="space-y-1.5 rounded bg-muted/40 p-2 text-xs">
          {question.feedback && (
            <div>
              <span className="font-medium">Feedback: </span>
              {/* `question.explanation` below is rendered; the grader's prose
                  about the same maths answer was not. */}
              <span
                dangerouslySetInnerHTML={{ __html: processLatexContent(question.feedback) }}
              />
            </div>
          )}
          {(question.strengths?.length ?? 0) > 0 && (
            <div>
              <p className="font-medium text-muted-foreground">Strengths</p>
              <ul className="list-inside list-disc">
                {question.strengths!.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {(question.areasForImprovement?.length ?? 0) > 0 && (
            <div>
              <p className="font-medium text-muted-foreground">Areas for improvement</p>
              <ul className="list-inside list-disc">
                {question.areasForImprovement!.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {question.explanation && (
        <div className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">
          <span className="font-medium">Explanation: </span>
          <span
            dangerouslySetInnerHTML={{ __html: processLatexContent(question.explanation) }}
          />
        </div>
      )}
    </li>
  );
}

export default StudyGuideAnswerDrillDown;
