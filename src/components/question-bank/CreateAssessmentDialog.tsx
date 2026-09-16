/**
 * CreateAssessmentDialog — create a quiz (online) or test (printed) directly
 * from a Question Bank selection, without leaving the bank.
 *
 * The inserts mirror the builders exactly so the resulting rows are
 * indistinguishable from ones authored in Assessments:
 *   - quiz: `quizzes` + `quiz_questions` (quiz_id, question_id, order_num) —
 *     see QuizManager.handleSave
 *   - test: `tests` + `test_questions` (test_id, question_id, order_num,
 *     points) with the same difficulty-based default points (easy 1 /
 *     medium 2 / hard 3) as TestBuilder.handleAddQuestion
 *
 * Eligibility mirrors the builders too. The bank shows rows the assessment
 * builders deliberately exclude — hidden questions, student-generated ones
 * (`excludeUserGenerated` in QuizManager/TestBuilder's bank load), and MCQs
 * without a CORRECT validation verdict at confidence > 0.7
 * (AssessmentQuestionBank.isMcqVerified). Those are checked server-side when
 * the dialog opens, flagged in the list, and left out of the created
 * assessment rather than smuggled past the builders' gate.
 *
 * Question order is the selection's table order, passed in by the caller.
 * Fine-tuning (reorder, per-question points, time limits, assignment) stays
 * in the Assessments tab — the dialog says where to find the new item.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { formatQuestionText } from "@/lib/latex-utils";
import { getDifficultyClass } from "@/lib/difficulty-color";
import type { UnifiedQuestion } from "@/lib/unified-question";
import { TypeBadge } from "../UnifiedQuestionsTable";

export type AssessmentKind = "quiz" | "test";

const KIND_COPY: Record<
  AssessmentKind,
  { title: string; noun: string; location: string }
> = {
  quiz: {
    title: "Create Quiz from Selection",
    noun: "Quiz",
    location: "Assessments → Quizzes (Online)",
  },
  test: {
    title: "Create Test from Selection",
    noun: "Test",
    location: "Assessments → Tests (Printed & Take-Home)",
  },
};

/** Same default points TestBuilder assigns when a question is added. */
function defaultTestPoints(difficulty: UnifiedQuestion["difficulty"]): number {
  return difficulty === "easy" ? 1 : difficulty === "medium" ? 2 : 3;
}

/** Why a selected question cannot go into an assessment. `null` = eligible. */
type IneligibleReason =
  | "hidden"
  | "student-created"
  | "unverified MCQ"
  | "not found";

const INELIGIBLE_LABEL: Record<IneligibleReason, string> = {
  hidden: "Hidden",
  "student-created": "Student-created",
  "unverified MCQ": "Unverified MCQ",
  "not found": "No longer exists",
};

interface CreateAssessmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: AssessmentKind;
  courseId: string;
  /** Selected questions in the order they should appear in the assessment. */
  questions: UnifiedQuestion[];
  onCreated?: (kind: AssessmentKind) => void;
}

export function CreateAssessmentDialog({
  open,
  onOpenChange,
  kind,
  courseId,
  questions,
  onCreated,
}: CreateAssessmentDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  // null while the check is in flight; the submit stays disabled until it
  // lands so an eligibility gap can never slip through on a fast click.
  const [ineligibleById, setIneligibleById] = useState<Map<
    string,
    IneligibleReason | null
  > | null>(null);
  const [eligibilityError, setEligibilityError] = useState(false);

  // Fresh form + fresh eligibility check every time the dialog opens. The
  // check reads the authoritative columns server-side rather than trusting
  // the client rows, which may be stale (e.g. a revalidation verdict written
  // after the bank loaded).
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setIneligibleById(null);
    setEligibilityError(false);

    let cancelled = false;
    const ids = questions.map((q) => q.id);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("questions")
          .select("id, type, hidden, is_user_generated, validation_status, validation_confidence")
          .in("id", ids);
        if (error) throw error;

        const byId = new Map(
          (data ?? []).map((row) => [row.id as string, row]),
        );
        const next = new Map<string, IneligibleReason | null>();
        for (const id of ids) {
          const row = byId.get(id);
          if (!row) {
            next.set(id, "not found");
          } else if (row.hidden) {
            next.set(id, "hidden");
          } else if (row.is_user_generated) {
            next.set(id, "student-created");
          } else if (
            row.type === "mcq" &&
            !(
              row.validation_status === "CORRECT" &&
              (row.validation_confidence ?? 0) > 0.7
            )
          ) {
            next.set(id, "unverified MCQ");
          } else {
            next.set(id, null);
          }
        }
        if (!cancelled) setIneligibleById(next);
      } catch (err) {
        console.error("Eligibility check failed", err);
        // Fail closed — with no verdict we cannot create anything, or the
        // gate the builders enforce would be bypassed by a network blip.
        if (!cancelled) setEligibilityError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-check on open only; `questions` is fixed per open
  }, [open]);

  const copy = KIND_COPY[kind];
  const checking = !eligibilityError && ineligibleById === null;
  const eligibleQuestions = useMemo(
    () =>
      ineligibleById === null
        ? []
        : questions.filter((q) => ineligibleById.get(q.id) === null),
    [questions, ineligibleById],
  );
  const ineligibleCount = ineligibleById === null ? 0 : questions.length - eligibleQuestions.length;
  const totalPoints =
    kind === "test"
      ? eligibleQuestions.reduce(
          (sum, q) => sum + defaultTestPoints(q.difficulty),
          0,
        )
      : null;

  const handleCreate = async () => {
    if (!title.trim()) {
      toast.error(`Please enter a ${kind} title`);
      return;
    }
    if (eligibleQuestions.length === 0) {
      toast.error("None of the selected questions can go into an assessment");
      return;
    }

    setSaving(true);
    try {
      const { data: user } = await supabase.auth.getUser();

      if (kind === "quiz") {
        const { data: newQuiz, error: quizError } = await supabase
          .from("quizzes")
          .insert({
            course_id: courseId,
            title: title.trim(),
            description: description.trim() || null,
            is_published: true,
            created_by: user.user?.id,
          })
          .select()
          .single();

        if (quizError) throw quizError;

        const { error: insertError } = await supabase
          .from("quiz_questions")
          .insert(
            eligibleQuestions.map((q, index) => ({
              quiz_id: newQuiz.id,
              question_id: q.id,
              order_num: index,
            })),
          );

        if (insertError) {
          // Don't leave an empty quiz behind — and if the cleanup itself
          // fails, say so, because an empty published quiz IS visible under
          // Assessments and silence would leave it unexplained.
          const { error: cleanupError } = await supabase
            .from("quizzes")
            .delete()
            .eq("id", newQuiz.id);
          if (cleanupError) {
            console.error("Cleanup of empty quiz failed", cleanupError);
            throw new Error(
              `${insertError.message} — an empty quiz "${title.trim()}" may remain under ${copy.location}; delete it there.`,
            );
          }
          throw insertError;
        }
      } else {
        const { data: newTest, error: testError } = await supabase
          .from("tests")
          .insert({
            course_id: courseId,
            title: title.trim(),
            description: description.trim() || null,
            custom_header: null,
            created_by: user.user?.id,
            is_published: true,
          })
          .select()
          .single();

        if (testError) throw testError;

        const { error: insertError } = await supabase
          .from("test_questions")
          .insert(
            eligibleQuestions.map((q, index) => ({
              test_id: newTest.id,
              question_id: q.id,
              order_num: index,
              points: defaultTestPoints(q.difficulty),
            })),
          );

        if (insertError) {
          const { error: cleanupError } = await supabase
            .from("tests")
            .delete()
            .eq("id", newTest.id);
          if (cleanupError) {
            console.error("Cleanup of empty test failed", cleanupError);
            throw new Error(
              `${insertError.message} — an empty test "${title.trim()}" may remain under ${copy.location}; delete it there.`,
            );
          }
          throw insertError;
        }
      }

      toast.success(`${copy.noun} "${title.trim()}" created`, {
        description: `Find it under ${copy.location} to reorder, adjust, or assign it.`,
      });
      onOpenChange(false);
      onCreated?.(kind);
    } catch (err) {
      console.error(`Error creating ${kind} from selection:`, err);
      toast.error(
        err instanceof Error ? err.message : `Failed to create ${kind}`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="create-assessment-dialog"
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription data-testid="create-assessment-summary">
            {checking ? (
              <>Checking {questions.length} selected question{questions.length === 1 ? "" : "s"}…</>
            ) : (
              <>
                {eligibleQuestions.length} of {questions.length} selected
                question{questions.length === 1 ? "" : "s"} will be included
                {totalPoints !== null && <> · {totalPoints} points</>}.
              </>
            )}{" "}
            The {kind} is created here — you can reorder or assign it later
            under {copy.location}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {eligibilityError && (
            <p
              className="text-sm text-destructive"
              data-testid="create-assessment-eligibility-error"
            >
              Could not verify the selected questions — close the dialog and
              try again.
            </p>
          )}
          {!checking && !eligibilityError && ineligibleCount > 0 && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="create-assessment-ineligible-note"
            >
              {ineligibleCount} question{ineligibleCount === 1 ? " is" : "s are"}{" "}
              not available to assessments (hidden, student-created, or an
              unverified MCQ) and will be left out — the same rule the
              assessment builders apply.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="create-assessment-title">Title</Label>
            <Input
              id="create-assessment-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={`${copy.noun} title`}
              data-testid="create-assessment-title"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-assessment-description">
              Description (optional)
            </Label>
            <Textarea
              id="create-assessment-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="create-assessment-description"
            />
          </div>

          <div className="max-h-48 overflow-y-auto rounded-md border">
            <ul className="divide-y">
              {questions.map((q, index) => {
                const reason = ineligibleById?.get(q.id) ?? null;
                return (
                  <li
                    key={q.id}
                    className={`flex items-start gap-2 px-3 py-2 text-sm ${
                      reason ? "opacity-50" : ""
                    }`}
                    data-testid={`create-assessment-row-${q.id}`}
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {index + 1}.
                    </span>
                    <span
                      className="flex-1 line-clamp-2"
                      dangerouslySetInnerHTML={{
                        __html: formatQuestionText(q.preview),
                      }}
                    />
                    <span className="flex shrink-0 items-center gap-1">
                      {reason && (
                        <Badge
                          variant="outline"
                          className="text-xs text-destructive border-destructive/40"
                          data-testid={`create-assessment-excluded-${q.id}`}
                        >
                          {INELIGIBLE_LABEL[reason]}
                        </Badge>
                      )}
                      <TypeBadge type={q.type} />
                      <Badge
                        variant="outline"
                        className={`text-xs capitalize ${getDifficultyClass(q.difficulty)}`}
                      >
                        {q.difficulty}
                      </Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={
              saving ||
              checking ||
              eligibilityError ||
              eligibleQuestions.length === 0
            }
            data-testid="create-assessment-submit"
          >
            {saving || checking ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {saving ? "Creating…" : "Checking…"}
              </>
            ) : (
              `Create ${copy.noun}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
