import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatQuestionText } from "@/lib/latex-utils";
import {
  GitCompare,
  Loader2,
  AlertTriangle,
  Trash2,
  EyeOff,
  CheckCircle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { TypeBadge } from "./UnifiedQuestionsTable";
import { QUESTION_TYPE_LABELS } from "@/lib/unified-question";
import type { QuestionType } from "@/types/question";

interface SimilarQuestion {
  id: string;
  type: QuestionType;
  text: string;
  similarityScore: number;
  reason: string;
}

interface SimilarityResult {
  questionId: string;
  questionType: QuestionType;
  questionText: string;
  similarTo: SimilarQuestion[];
}

interface SimilarityCheckDialogProps {
  courseId: string;
  onQuestionAction: (questionId: string, action: "delete" | "hide") => void;
  /**
   * Optional controlled open state. When provided, the internal trigger is
   * hidden and the host (e.g. the Question Bank overflow menu) drives the
   * dialog. Leaving these unset preserves the original self-triggering usage.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in "Find Similar Questions" trigger button. */
  hideTrigger?: boolean;
}

const TYPE_ORDER: QuestionType[] = [
  "mcq",
  "open",
  "fill_gaps",
  "ordering",
  "classification",
];

export const SimilarityCheckDialog = ({
  courseId,
  onQuestionAction,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  hideTrigger,
}: SimilarityCheckDialogProps) => {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) controlledOnOpenChange?.(next);
    else setInternalOpen(next);
  };
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SimilarityResult[]>([]);
  const [hasChecked, setHasChecked] = useState(false);

  const groupedByType = useMemo(() => {
    const groups: Record<QuestionType, SimilarityResult[]> = {
      mcq: [],
      open: [],
      fill_gaps: [],
      ordering: [],
      classification: [],
    };
    for (const r of results) groups[r.questionType]?.push(r);
    return groups;
  }, [results]);

  const runSimilarityCheck = async () => {
    setLoading(true);
    setResults([]);

    try {
      const { data, error } = await supabase.functions.invoke(
        "check-question-similarity",
        { body: { courseId } },
      );

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // The cross-type response (#621) attaches `questionType` / `type` to
      // every entry. Pre-#621 responses (MCQ-only) had no type field — default
      // those entries to `mcq` so an unrolled deploy still renders cleanly.
      const incoming: SimilarityResult[] = (data?.similarQuestions ?? []).map(
        (r: SimilarityResult): SimilarityResult => ({
          ...r,
          questionType: r.questionType ?? "mcq",
          similarTo: (r.similarTo ?? []).map((s: SimilarQuestion) => ({
            ...s,
            type: s.type ?? "mcq",
          })),
        }),
      );

      setResults(incoming);
      setHasChecked(true);

      if (incoming.length === 0) {
        toast.success("No similar questions found");
      } else {
        toast.info(`Found ${incoming.length} question(s) with similarities`);
      }
    } catch (error) {
      console.error("Similarity check error:", error);
      const msg = error instanceof Error ? error.message : "Failed to check";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (questionId: string) => {
    try {
      const { error } = await supabase.from("questions").delete().eq("id", questionId);
      if (error) throw error;

      setResults((prev) =>
        prev
          .filter((r) => r.questionId !== questionId)
          .map((r) => ({
            ...r,
            similarTo: r.similarTo.filter((s) => s.id !== questionId),
          }))
          .filter((r) => r.similarTo.length > 0),
      );

      onQuestionAction(questionId, "delete");
      toast.success("Question deleted");
    } catch (err) {
      console.error("Delete failed", err);
      toast.error("Failed to delete question");
    }
  };

  const handleHide = async (questionId: string) => {
    try {
      const { error } = await supabase
        .from("questions")
        .update({ hidden: true })
        .eq("id", questionId);
      if (error) throw error;
      onQuestionAction(questionId, "hide");
      toast.success("Question hidden");
    } catch (err) {
      console.error("Hide failed", err);
      toast.error("Failed to hide question");
    }
  };

  const getSimilarityColor = (score: number) => {
    if (score >= 90) return "bg-red-500/10 text-red-600 border-red-500/20";
    if (score >= 80) return "bg-amber-500/10 text-amber-600 border-amber-500/20";
    return "bg-yellow-500/10 text-yellow-600 border-yellow-500/20";
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <GitCompare className="w-4 h-4 mr-2" />
            Find Similar Questions
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="w-5 h-5" />
            Question Similarity Check
          </DialogTitle>
          <DialogDescription>
            AI-powered analysis to find similar or duplicate questions across
            every type in the bank.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!hasChecked && !loading && (
            <div className="text-center py-8">
              <GitCompare className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-4">
                Run an AI analysis to identify similar or duplicate questions in
                this course.
              </p>
              <Button onClick={runSimilarityCheck}>
                <GitCompare className="w-4 h-4 mr-2" />
                Find Similar Questions
              </Button>
            </div>
          )}

          {loading && (
            <div className="text-center py-8">
              <Loader2 className="w-8 h-8 animate-spin mx-auto text-primary mb-4" />
              <p className="text-muted-foreground">
                Analyzing questions for similarity…
              </p>
            </div>
          )}

          {hasChecked && !loading && results.length === 0 && (
            <div className="text-center py-8">
              <CheckCircle className="w-12 h-12 mx-auto text-green-500 mb-4" />
              <p className="text-muted-foreground">
                No similar questions found. Your question bank looks good!
              </p>
              <Button
                variant="outline"
                onClick={runSimilarityCheck}
                className="mt-4"
              >
                Run Again
              </Button>
            </div>
          )}

          {hasChecked && !loading && results.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Found {results.length} question(s) with similarities
                </p>
                <Button variant="outline" size="sm" onClick={runSimilarityCheck}>
                  Recheck
                </Button>
              </div>

              <ScrollArea className="h-[400px] rounded-md border p-4">
                <div className="space-y-6">
                  {TYPE_ORDER.flatMap((qt) => {
                    const group = groupedByType[qt];
                    if (!group || group.length === 0) return [];
                    return [
                      <div key={`group-${qt}`} className="space-y-3">
                        <div
                          className="flex items-center gap-2 pb-1 border-b"
                          data-testid={`similarity-group-${qt}`}
                        >
                          <TypeBadge type={qt} />
                          <span className="text-xs text-muted-foreground">
                            {group.length} {QUESTION_TYPE_LABELS[qt]} question
                            {group.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        {group.map((result) => (
                          <div
                            key={result.questionId}
                            className="space-y-3 pb-4 border-b last:border-b-0"
                          >
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 text-amber-500 mt-1 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                {/* Question text carries LaTeX, and this was
                                    the last place it was shown unrendered — an
                                    instructor comparing a new question against
                                    a similar one was reading its source. */}
                                <div
                                  className="text-sm font-medium line-clamp-2"
                                  dangerouslySetInnerHTML={{
                                    __html: formatQuestionText(result.questionText),
                                  }}
                                />
                                <div className="flex gap-2 mt-2">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-destructive hover:text-destructive"
                                    onClick={() => handleDelete(result.questionId)}
                                  >
                                    <Trash2 className="w-3 h-3 mr-1" />
                                    Delete
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7"
                                    onClick={() => handleHide(result.questionId)}
                                  >
                                    <EyeOff className="w-3 h-3 mr-1" />
                                    Hide
                                  </Button>
                                </div>
                              </div>
                            </div>

                            <div className="pl-6 space-y-2">
                              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                                Similar to:
                              </p>
                              {result.similarTo.map((similar) => (
                                <div
                                  key={similar.id}
                                  className="bg-muted/50 rounded-md p-3 space-y-2"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex-1 min-w-0">
                                      <div className="mb-1">
                                        <TypeBadge type={similar.type} />
                                      </div>
                                      <p className="text-sm line-clamp-2">
                                        {similar.text}
                                      </p>
                                    </div>
                                    <Badge
                                      variant="outline"
                                      className={getSimilarityColor(
                                        similar.similarityScore,
                                      )}
                                    >
                                      {similar.similarityScore}%
                                    </Badge>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {similar.reason}
                                  </p>
                                  <div className="flex gap-2">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 text-xs text-destructive hover:text-destructive"
                                      onClick={() => handleDelete(similar.id)}
                                    >
                                      <Trash2 className="w-3 h-3 mr-1" />
                                      Delete
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 text-xs"
                                      onClick={() => handleHide(similar.id)}
                                    >
                                      <EyeOff className="w-3 h-3 mr-1" />
                                      Hide
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>,
                    ];
                  })}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
