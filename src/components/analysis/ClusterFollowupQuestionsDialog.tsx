/**
 * The "Create AI Interactive Question" follow-up: one AI interactive
 * (Socratic) question per just-created group, generated from the source
 * material and targeted at the struggle that formed the group, shown to the
 * instructor to confirm-and-assign or cancel.
 *
 * Two sources, exactly one of which is set:
 *   - `studyGuideId` — the question is written from the guide's theory
 *     (`generate-open-questions` study-guide mode).
 *   - `quizId` — the question is written from the chapters the quiz's
 *     questions came from (quiz_questions → question_chapters, the same
 *     chapter-scope derivation `enqueue-followup-practice` uses).
 *
 * Opened by `AnalysisClustersSection` right after the offering group is
 * written, so every item here already has a real `group_id`. Each item runs
 * the same pipeline the AI Interactive Questions tab uses: call
 * `generate-open-questions` (group-targeted so the model sees the group's
 * description as its audience), insert the returned question with
 * `answering_mode: "interactive"`, then let the instructor confirm — an
 * `offering_questions` row published immediately, exactly what the tab's
 * assign dialog writes. Once every question is assigned the dialog closes
 * itself; cancelling loses nothing — the generated question is already in the
 * bank's AI Chatbots tab, just unassigned.
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
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ExternalLink, Loader2, Sparkles, UsersRound } from "lucide-react";
import { toOpenUnified } from "@/lib/question-payload";

export interface FollowupQuestionItem {
  /** The just-created offering group this question is for. */
  groupId: string;
  /** The group's final (possibly suffixed) name, for display. */
  groupName: string;
  /** The cluster's label/rationale/summary — they steer the prompt. */
  label: string;
  rationale: string;
  summary: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  /** Generation source — exactly one of these is set (see the header). */
  studyGuideId?: string;
  quizId?: string;
  offeringId: string;
  items: FollowupQuestionItem[];
}

type ItemStatus = "generating" | "ready" | "assigning" | "assigned" | "error";

interface ItemState {
  status: ItemStatus;
  question?: { id: string; text: string; difficulty: string };
  error?: string;
}

/** What we need back from `generate-open-questions` per question. */
interface GeneratedOpenQuestion {
  id: string;
  question: string;
  model_answer?: string;
  answer_key?: { model_answer?: string } | null;
  explanation?: string | null;
  difficulty: string;
  hidden?: boolean;
  competency_ids?: string[];
  chapter_ids?: string[];
  generated_for_group_id?: string | null;
  generation_rationale?: string | null;
}

export function ClusterFollowupQuestionsDialog({
  open,
  onOpenChange,
  courseId,
  studyGuideId,
  quizId,
  offeringId,
  items,
}: Props) {
  const [states, setStates] = useState<Record<string, ItemState>>({});
  // Generation must start exactly once per open, not once per effect run —
  // StrictMode re-runs effects, and a duplicate run would bill a second model
  // call and insert a second question per group.
  const startedRef = useRef(false);
  // Quiz mode's chapter scope, resolved once per open and shared across items
  // (and retries) — the quiz's chapters don't change while the dialog is up.
  const chapterIdsPromiseRef = useRef<Promise<string[]> | null>(null);

  const setItemState = useCallback((groupId: string, state: ItemState) => {
    setStates((prev) => ({ ...prev, [groupId]: state }));
  }, []);

  /**
   * Quiz mode: the generation context is the distinct chapters of the quiz's
   * questions — the same chapter-scope derivation `enqueue-followup-practice`
   * performs server-side for whole-class follow-up practice.
   */
  const resolveQuizChapterIds = useCallback((): Promise<string[]> => {
    if (!quizId) return Promise.resolve([]);
    if (!chapterIdsPromiseRef.current) {
      const promise = (async () => {
        const { data: quizQs, error: qqError } = await supabase
          .from("quiz_questions")
          .select("question_id")
          .eq("quiz_id", quizId);
        if (qqError) throw qqError;
        const questionIds = (quizQs ?? []).map((r) => r.question_id).filter(Boolean);
        if (questionIds.length === 0) return [];
        const { data: chapterRows, error: chError } = await supabase
          .from("question_chapters")
          .select("chapter_id")
          .in("question_id", questionIds);
        if (chError) throw chError;
        return [...new Set((chapterRows ?? []).map((r) => r.chapter_id).filter(Boolean))];
      })();
      // A failed resolution must not be cached, or Retry would rethrow the
      // same stale error without ever re-querying.
      promise.catch(() => {
        chapterIdsPromiseRef.current = null;
      });
      chapterIdsPromiseRef.current = promise;
    }
    return chapterIdsPromiseRef.current;
  }, [quizId]);

  /**
   * Generate + persist one interactive question for a group.
   *
   * Mirrors the AI Interactive Questions tab's writer: the edge function only
   * returns question objects, and the caller owns the insert. The row is
   * written with `answering_mode: "interactive"` so it lands on the AI
   * Chatbots surface, and `generated_for_group_id` records its provenance.
   */
  const generateFor = useCallback(
    async (item: FollowupQuestionItem) => {
      setItemState(item.groupId, { status: "generating" });
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        const instructions = [
          `These students share a struggle: "${item.label}".`,
          item.rationale.trim(),
          item.summary.trim(),
          "Write the question to target this struggle directly.",
        ]
          .filter(Boolean)
          .join(" ");

        // The generation source: the guide's theory, or the quiz's chapters.
        let sourceParams: Record<string, unknown>;
        if (studyGuideId) {
          sourceParams = { studyGuideId };
        } else {
          const chapterIds = await resolveQuizChapterIds();
          if (chapterIds.length === 0) {
            throw new Error(
              "This quiz's questions aren't linked to any course chapters, so a follow-up question can't be generated from the material.",
            );
          }
          sourceParams = { chapterIds };
        }

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-open-questions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
            },
            body: JSON.stringify({
              courseId,
              numQuestions: 1,
              difficulty: "mixed",
              ...sourceParams,
              specialInstructions: instructions,
              group_id: item.groupId,
            }),
          },
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to generate the question");
        }
        const functionData = await response.json();
        if (functionData?.error) throw new Error(functionData.error);

        const q: GeneratedOpenQuestion | undefined = functionData.questions?.[0];
        if (!q) throw new Error("No question was generated");

        const { data: { user } } = await supabase.auth.getUser();

        const { error: insertError } = await supabase.from("questions").insert({
          id: q.id,
          course_id: courseId,
          question: q.question,
          explanation: q.explanation ?? "",
          difficulty: q.difficulty,
          hidden: q.hidden ?? false,
          upvotes: 0,
          downvotes: 0,
          is_user_generated: false,
          created_by: user?.id || null,
          competency_id: q.competency_ids?.[0] || null,
          generated_for_group_id: q.generated_for_group_id ?? item.groupId,
          generation_rationale: q.generation_rationale ?? null,
          ...toOpenUnified({
            model_answer: q.model_answer ?? q.answer_key?.model_answer ?? "",
            rubric: null,
            explanation: q.explanation ?? null,
            answering_mode: "interactive",
          }),
        });
        if (insertError) throw insertError;

        // Provenance junctions. Non-fatal: the question row is already
        // committed, and failing the flow here would invite a retry that
        // duplicates it. Not silent either — a question missing its links is
        // invisible to competency/chapter filters, so the instructor is told
        // what failed and that the question itself is safe.
        const failedLinks: string[] = [];
        const competencyLinks = (q.competency_ids ?? []).map((cid) => ({
          question_id: q.id,
          competency_id: cid,
        }));
        if (competencyLinks.length > 0) {
          const { error } = await supabase.from("question_competencies").insert(competencyLinks);
          if (error) {
            console.error("Failed to link competencies:", error);
            failedLinks.push("competencies");
          }
        }
        const chapterLinks = (q.chapter_ids ?? []).map((chId) => ({
          question_id: q.id,
          chapter_id: chId,
        }));
        if (chapterLinks.length > 0) {
          const { error } = await supabase.from("question_chapters").insert(chapterLinks);
          if (error) {
            console.error("Failed to link chapters:", error);
            failedLinks.push("chapters");
          }
        }
        if (failedLinks.length > 0) {
          toast.warning(
            `The question was saved, but linking it to its ${failedLinks.join(" and ")} failed — ` +
              "it may not appear under those filters. You can still assign it, and edit it later in the question bank.",
          );
        }

        setItemState(item.groupId, {
          status: "ready",
          question: { id: q.id, text: q.question, difficulty: q.difficulty },
        });
      } catch (err) {
        console.error("Follow-up question generation failed:", err);
        setItemState(item.groupId, {
          status: "error",
          error: (err as Error)?.message || "Failed to generate the question",
        });
      }
    },
    [courseId, studyGuideId, resolveQuizChapterIds, setItemState],
  );

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      chapterIdsPromiseRef.current = null;
      // Cleared on close, not on reopen: the all-assigned auto-close effect
      // must never see a previous run's states against a new run's items.
      setStates({});
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    for (const item of items) void generateFor(item);
  }, [open, items, generateFor]);

  const handleAssign = async (item: FollowupQuestionItem) => {
    const state = states[item.groupId];
    if (!state?.question || state.status !== "ready") return;
    setItemState(item.groupId, { ...state, status: "assigning" });
    try {
      // Same row the AI Interactive tab's assign dialog writes; published
      // immediately — the instructor just asked for exactly this.
      const { error } = await supabase
        .from("offering_questions" as never)
        .insert([
          {
            offering_id: offeringId,
            question_id: state.question.id,
            group_id: item.groupId,
            published_at: new Date().toISOString(),
          },
        ] as never);
      if (error) throw error;

      setItemState(item.groupId, { ...state, status: "assigned" });
      toast.success(`Question assigned to ${item.groupName}`);
    } catch (err) {
      console.error("Failed to assign the follow-up question:", err);
      toast.error((err as Error)?.message || "Failed to assign the question");
      setItemState(item.groupId, { ...state, status: "ready" });
    }
  };

  // "When all done, close the window" — once every opted-in group has its
  // question assigned there is nothing left to do here.
  useEffect(() => {
    if (!open || items.length === 0) return;
    if (items.every((i) => states[i.groupId]?.status === "assigned")) {
      onOpenChange(false);
    }
  }, [open, items, states, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="cluster-followup-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            AI interactive question follow-up
          </DialogTitle>
          <DialogDescription>
            The group was created. Below is its follow-up: a Socratic question generated from{" "}
            {studyGuideId ? "the study guide" : "the quiz's course material"}, aimed at the
            struggle that formed the group. Confirm to assign it to the group right away, or
            cancel — either way the question stays under{" "}
            <a
              href={`/course/${courseId}?tab=ai-tutoring&sub=ai-chatbots`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            >
              AI Chatbots
              <ExternalLink className="h-3 w-3" />
            </a>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {items.map((item) => {
            const state = states[item.groupId] ?? { status: "generating" as ItemStatus };
            return (
              <div key={item.groupId} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <UsersRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{item.groupName}</p>
                  {state.status === "assigned" && (
                    <Badge variant="secondary" className="shrink-0">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Assigned
                    </Badge>
                  )}
                </div>

                {state.status === "generating" ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating question…
                  </p>
                ) : state.status === "error" ? (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive">{state.error}</p>
                    <Button variant="outline" size="sm" onClick={() => void generateFor(item)}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap rounded bg-muted/40 p-2 text-sm">
                      {state.question?.text}
                    </p>
                    {state.status !== "assigned" && (
                      <Button
                        size="sm"
                        onClick={() => void handleAssign(item)}
                        disabled={state.status === "assigning"}
                        data-testid={`assign-followup-${item.groupId}`}
                      >
                        {state.status === "assigning" ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <UsersRound className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        Confirm & assign to the group
                      </Button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          {/* Cancelling is always safe: the group stays created and the
              generated question is already saved to the AI Chatbots tab, so
              bailing here only skips the assignment shortcut. */}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ClusterFollowupQuestionsDialog;
