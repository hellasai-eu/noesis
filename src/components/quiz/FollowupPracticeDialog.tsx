/**
 * Follow-up practice generation dialog (issue #839).
 *
 * Launched from the quiz-analysis panel for a specific cluster or for the
 * whole class. The instructor picks question types, a short count per type,
 * and difficulty; the dialog shows the weak areas the set will target. On
 * Create it POSTs to `enqueue-followup-practice`, which persists the cluster
 * as an offering group (cluster only), creates a published (never draft) quiz
 * + an unpublished `offering_quizzes` row, and enqueues a background
 * generation job. The dialog then polls the job for a lightweight progress →
 * done state and points the instructor at the surface that can release it.
 *
 * That surface is the quiz row's Track & manage dialog — reached by clicking
 * the row's **Draft** badge — not the assign dialog: the assignment row already exists, so
 * QuizManager's "assign to class" action refuses it as a duplicate, while the
 * manage dialog's Publish button stamps `published_at` on the row that is
 * there (and refuses while generation is still in flight).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, Loader2, Sparkles, Users } from "lucide-react";
import type { QuestionType } from "@/types/question";
import { QUESTION_TYPE_LABELS } from "@/lib/unified-question";

/** Types offered for follow-up sets. Kept to the material-based generators. */
const FOLLOWUP_TYPES: QuestionType[] = ["mcq", "open", "fill_gaps", "ordering", "classification"];
const DEFAULT_TYPES: QuestionType[] = ["mcq", "open"];
const MAX_COUNT_PER_TYPE = 3;
const DEFAULT_COUNT = 2;

/**
 * Weak areas come back from the analysis as whole sentences, so the badge has to
 * behave like a paragraph: wrap inside the panel rather than stretch it. Without
 * `max-w-full` + wrapping, a single long phrase sets the grid track's min-content
 * width and pushes the whole dialog into a horizontal scroll (#1177 fixed the
 * vertical equivalent).
 */
const WEAK_AREA_BADGE =
  "max-w-full whitespace-normal break-words text-left text-xs font-normal leading-snug";

export type FollowupTarget =
  | { kind: "cluster"; label: string; memberUserIds: string[]; summary?: string }
  | { kind: "whole_class"; studentCount: number };

export interface FollowupWeakAreas {
  misconceptions: string[];
  gaps: string[];
}

interface FollowupPracticeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quizId: string;
  offeringId: string;
  quizTitle: string;
  target: FollowupTarget | null;
  weakAreas: FollowupWeakAreas;
  /**
   * Fired on close, once a set has actually been enqueued. The enclosing
   * Assigned Quizzes board loaded its assignments before the new draft
   * existed, so without this the instructor closes the dialog, follows it to
   * the Drafts group, and finds nothing there until they reload.
   */
  onAssignmentsChanged?: () => void;
}

type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

const TERMINAL: ReadonlySet<JobStatus> = new Set([
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);

export function FollowupPracticeDialog({
  open,
  onOpenChange,
  quizId,
  offeringId,
  quizTitle,
  target,
  weakAreas,
  onAssignmentsChanged,
}: FollowupPracticeDialogProps) {
  const [selectedTypes, setSelectedTypes] = useState<Set<QuestionType>>(
    () => new Set(DEFAULT_TYPES),
  );
  const [countPerType, setCountPerType] = useState(String(DEFAULT_COUNT));
  const [difficulty, setDifficulty] = useState<string>("mixed");
  const [submitting, setSubmitting] = useState(false);
  // Once enqueued: the created quiz + live job progress.
  const [enqueued, setEnqueued] = useState<{ jobId: string; draftQuizId: string } | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [createdCount, setCreatedCount] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Reset everything each time the dialog opens fresh.
  useEffect(() => {
    if (!open) return;
    setSelectedTypes(new Set(DEFAULT_TYPES));
    setCountPerType(String(DEFAULT_COUNT));
    setDifficulty("mixed");
    setSubmitting(false);
    setEnqueued(null);
    setJobStatus(null);
    setCreatedCount(0);
  }, [open]);

  useEffect(() => () => clearPoll(), [clearPoll]);

  // Poll the job for progress once enqueued, until it reaches a terminal state.
  // Stops as soon as the dialog closes, even though `enqueued` itself isn't
  // reset until the dialog reopens (see the reset effect above).
  useEffect(() => {
    if (!open || !enqueued) return;
    let active = true;
    const tick = async () => {
      const { data, error } = await supabase
        .from("jobs" as any)
        .select("status, progress")
        .eq("id", enqueued.jobId)
        .maybeSingle();
      if (!active || error || !data) return;
      const status = (data as any).status as JobStatus;
      const created = (data as any).progress?.created_total;
      setJobStatus(status);
      if (typeof created === "number") setCreatedCount(created);
      if (TERMINAL.has(status)) clearPoll();
    };
    tick();
    pollRef.current = setInterval(tick, 2500);
    return () => {
      active = false;
      clearPoll();
    };
  }, [open, enqueued, clearPoll]);

  const toggleType = (t: QuestionType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const targetName =
    target?.kind === "cluster"
      ? target.label
      : target?.kind === "whole_class"
        ? "the whole class"
        : "";
  const targetCount =
    target?.kind === "cluster"
      ? target.memberUserIds.length
      : target?.kind === "whole_class"
        ? target.studentCount
        : 0;

  const countNum = Math.max(
    1,
    Math.min(MAX_COUNT_PER_TYPE, Number.parseInt(countPerType, 10) || DEFAULT_COUNT),
  );

  const canSubmit = !submitting && !enqueued && selectedTypes.size > 0 && !!target;

  const handleSubmit = async () => {
    if (!canSubmit || !target) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        quiz_id: quizId,
        offering_id: offeringId,
        types: Array.from(selectedTypes),
        count_per_type: countNum,
        difficulty: difficulty === "mixed" ? undefined : difficulty,
        cluster:
          target.kind === "cluster"
            ? { label: target.label, member_user_ids: target.memberUserIds }
            : null,
      };
      const { data, error } = await supabase.functions.invoke("enqueue-followup-practice", {
        body,
      });
      if (error) {
        // FunctionsHttpError stashes the raw Response on `.context`; recover
        // the handler's real message instead of the generic non-2xx text.
        let message = error.message ?? "Failed to create follow-up practice";
        const ctx = (error as any).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const b = await ctx.json();
            if (b?.error) message = b.error;
          } catch {
            /* keep default */
          }
        }
        throw new Error(message);
      }
      if (data?.error) throw new Error(data.error);
      const jobId = data?.jobId as string | undefined;
      const draftQuizId = data?.draftQuizId as string | undefined;
      if (!jobId || !draftQuizId) throw new Error("Enqueue returned no job");
      toast.success("Follow-up practice quiz created — generating questions in the background.");
      setEnqueued({ jobId, draftQuizId });
      setJobStatus("pending");
    } catch (err: any) {
      console.error("Follow-up enqueue failed:", err);
      toast.error(err?.message || "Failed to create follow-up practice");
    } finally {
      setSubmitting(false);
    }
  };

  const done = jobStatus != null && TERMINAL.has(jobStatus);

  // Both close paths funnel through here: the footer button and the dialog's
  // own dismiss. Announce on the way out rather than at enqueue time, so the
  // board refetches once, with whatever questions generation had finished by
  // then, instead of re-rendering underneath an open progress view.
  const handleOpenChange = (next: boolean) => {
    if (!next && enqueued) onAssignmentsChanged?.();
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (submitting) return;
        handleOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Create follow-up practice
          </DialogTitle>
          <DialogDescription>
            A short, targeted practice set from <span className="font-medium">{quizTitle}</span>,
            added to your quizzes as a draft assignment for you to review and publish.
          </DialogDescription>
        </DialogHeader>

        {!enqueued ? (
          <div className="min-w-0 space-y-4">
            {/* Target */}
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
              <Users className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">
                  {target?.kind === "cluster" ? target.label : "Whole class"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {targetCount} {targetCount === 1 ? "student" : "students"}
                  {target?.kind === "cluster" ? " (saved as a group)" : ""}
                </p>
              </div>
            </div>

            {/* Weak areas being targeted */}
            {(weakAreas.misconceptions.length > 0 || weakAreas.gaps.length > 0) && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Targets these weak areas</Label>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {weakAreas.misconceptions.slice(0, 5).map((m, i) => (
                    <Badge key={`m-${i}`} variant="secondary" className={WEAK_AREA_BADGE}>
                      {m}
                    </Badge>
                  ))}
                  {weakAreas.gaps.slice(0, 5).map((g, i) => (
                    <Badge key={`g-${i}`} variant="outline" className={WEAK_AREA_BADGE}>
                      {g}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Types */}
            <div>
              <Label className="mb-2 block">Question types</Label>
              <div className="flex min-w-0 flex-wrap gap-2" data-testid="followup-types">
                {FOLLOWUP_TYPES.map((t) => {
                  const active = selectedTypes.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleType(t)}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition ${
                        active
                          ? "border-primary bg-primary/10"
                          : "border-border opacity-60 hover:opacity-100"
                      }`}
                      aria-pressed={active}
                      data-testid={`followup-type-${t}`}
                    >
                      <Checkbox checked={active} onCheckedChange={() => toggleType(t)} />
                      <span>{QUESTION_TYPE_LABELS[t]}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Questions per type</Label>
                <Select value={countPerType} onValueChange={setCountPerType}>
                  <SelectTrigger data-testid="followup-count">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: MAX_COUNT_PER_TYPE }, (_, i) => i + 1).map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Difficulty</Label>
                <Select value={difficulty} onValueChange={setDifficulty}>
                  <SelectTrigger data-testid="followup-difficulty">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">Easy</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="hard">Hard</SelectItem>
                    <SelectItem value="mixed">Mixed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Generation runs in the background. The quiz is created ready to use, but its
              assignment stays unpublished — no student sees it until you publish it by
              clicking the quiz row's Draft badge.
            </p>
          </div>
        ) : (
          <div
            className="flex min-w-0 flex-col items-center gap-3 py-8 text-center"
            data-testid="followup-progress"
          >
            {done ? (
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            ) : (
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            )}
            <div>
              <p className="text-sm font-medium">
                {done
                  ? jobStatus === "failed"
                    ? "Generation failed"
                    : "Ready to review"
                  : "Generating questions…"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {jobStatus === "failed"
                  ? "No questions could be generated. You can delete the empty quiz or try again."
                  : createdCount > 0
                    ? `${createdCount} question${createdCount === 1 ? "" : "s"} added so far.`
                    : "This can take a minute."}
              </p>
            </div>
            <p className="max-w-sm break-words text-xs text-muted-foreground">
              Find <span className="font-medium">“{targetName ? `Follow-up: ${targetName}` : quizTitle}”</span>{" "}
              in the quiz table (Assessments → Quizzes) — its Classes cell shows a{" "}
              <span className="font-medium">Draft</span> badge. Click the badge to review the
              draft and publish it to students.
            </p>
          </div>
        )}

        <DialogFooter>
          {!enqueued ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit} data-testid="followup-create">
                {submitting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 mr-2" />
                )}
                Create quiz
              </Button>
            </>
          ) : (
            <Button onClick={() => handleOpenChange(false)} data-testid="followup-close">
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default FollowupPracticeDialog;
