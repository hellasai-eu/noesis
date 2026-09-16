import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FolderTree,
  Loader2,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Lightbulb,
  Undo2,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import {
  classificationAssignmentsFromAnswerKey,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  classificationPromptFromPayload,
  questionDiagramFromPayload,
  type ClassificationCategory,
  type ClassificationItem,
} from "@/lib/question-payload";
import { revealFrom } from "@/lib/question-reveal";
import { seededShuffle } from "@/lib/seeded-shuffle";
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { getDifficultyClass } from "@/lib/difficulty-color";
import "katex/dist/katex.min.css";

interface ClassificationListQuestion {
  id: string;
  prompt: string;
  categories: ClassificationCategory[];
  items: ClassificationItem[];
  // item_id → category_id. Never displayed to the student before submit.
  /**
   * Empty until the student opens this question. The hint button needs it
   * (see `handleHint`), so it is fetched for the ONE question being opened
   * rather than arriving with the whole list (#1011).
   */
  canonicalAssignments: Record<string, string>;
  explanation: string;
  difficulty: string;
  isCompleted: boolean;
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

interface Props {
  courseId: string;
  offeringId?: string | null;
  onBack: () => void;
}

const StudentClassificationQuestions = ({ courseId, offeringId, onBack }: Props) => {
  const [questions, setQuestions] = useState<ClassificationListQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedQuestion, setSelectedQuestion] = useState<ClassificationListQuestion | null>(null);
  // `placed` is a stack — push on category click, pop on undo. The current
  // card is `shuffledItems[placed.length]`.
  const [placed, setPlaced] = useState<Placement[]>([]);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [hintCategoryId, setHintCategoryId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  // The question currently on screen, readable synchronously.
  //
  // `selectQuestion` awaits two reads before it writes, and the student can
  // leave for another question in that window. Without this, a late response
  // lands on whatever is on screen now: the previous question's grade, key and
  // explanation, shown against a different question.
  const selectionRef = useRef<string | null>(null);

  useEffect(() => {
    fetchQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/offeringId change
  }, [courseId, offeringId]);

  const fetchQuestions = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setUserId(user.id);

      let rows: any[] = [];
      if (offeringId) {
        const { data: assignments, error: assignError } = await supabase
          .from("offering_questions")
          .select("question_id")
          .eq("offering_id", offeringId)
          .not("published_at", "is", null);
        if (assignError) throw assignError;
        const ids = (assignments || []).map((a: any) => a.question_id);
        if (ids.length === 0) {
          rows = [];
        } else {
          const CHUNK = 100;
          const chunks: string[][] = [];
          for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
          const results = await Promise.all(
            chunks.map((cids) =>
              supabase
                .from("questions")
                .select("id, payload, difficulty, hidden")
                .eq("type", "classification")
                .in("id", cids),
            ),
          );
          for (const { data, error } of results) {
            if (error) throw error;
            rows.push(...(data || []).filter((q: any) => !q.hidden));
          }
        }
      } else {
        const { data, error } = await supabase
          .from("questions")
          .select("id, payload, difficulty")
          .eq("course_id", courseId)
          .eq("type", "classification")
          .eq("hidden", false)
          .order("created_at", { ascending: false });
        if (error) throw error;
        rows = data || [];
      }

      const ids = rows.map((r) => r.id);
      const completed = new Set<string>();
      if (ids.length > 0) {
        const { data: progress } = await supabase
          .from("chat_sessions")
          .select("open_question_id, status")
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .in("open_question_id", ids);
        (progress || []).forEach((p: any) => {
          if (p.status === "completed") completed.add(p.open_question_id);
        });
      }

      const mapped: ClassificationListQuestion[] = rows.map((r: any) => ({
        id: r.id,
        prompt: classificationPromptFromPayload(r.payload),
        categories: classificationCategoriesFromPayload(r.payload),
        items: classificationItemsFromPayload(r.payload),
        // Not fetched with the list any more (#1011): this is a whole
        // course's worth of questions, so requesting the key here handed over
        // every classification answer in the course before the student opened
        // one. Filled in by `selectQuestion` for the question actually opened.
        canonicalAssignments: {},
        explanation: "",
        difficulty: r.difficulty,
        isCompleted: completed.has(r.id),
        diagram: questionDiagramFromPayload(r.payload),
      }));
      setQuestions(mapped);
    } catch (err: any) {
      console.error("Error fetching classification questions:", err);
      toast.error("Failed to load questions");
    } finally {
      setLoading(false);
    }
  };

  // Stable per-(question, user) shuffle of the deck. Memoizing both prevents
  // a re-render from re-randomizing and lets restart re-derive from the
  // same seed.
  const shuffledItems = useMemo(() => {
    if (!selectedQuestion || !userId) return [];
    return seededShuffle(selectedQuestion.items, `${selectedQuestion.id}::${userId}`);
  }, [selectedQuestion, userId]);

  const initialHints = useMemo(() => {
    if (!selectedQuestion) return 0;
    return Math.max(1, Math.floor(selectedQuestion.items.length / 2));
  }, [selectedQuestion]);

  const hintsRemaining = initialHints - hintsUsed;
  const currentItem = placed.length < shuffledItems.length ? shuffledItems[placed.length] : null;
  const isFinished = placed.length === shuffledItems.length && shuffledItems.length > 0;

  const selectQuestion = async (q: ClassificationListQuestion) => {
    selectionRef.current = q.id;
    setSelectedQuestion(q);
    setSubmitted(null);
    setPlaced([]);
    setHintsUsed(0);
    setHintCategoryId(null);
    setLoadingExisting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: grade } = await supabase
        .from("open_question_grades")
        .select("grade, submitted_answer, gap_results")
        .eq("open_question_id", q.id)
        .eq("user_id", user.id)
        .maybeSingle();

      // The key for this one question. `handleHint` reveals the correct
      // category for the current card on demand, so this surface genuinely
      // needs the key BEFORE the answer — unlike its fill-gaps and ordering
      // siblings, which now get theirs only from the grader's `reveal`.
      //
      // So this is narrowed, not closed: a whole course's answers at list time
      // became one question's answer when the student opens it. Closing it
      // properly means serving a hint from the server, one category at a time,
      // which needs somewhere to count hints against — see #1011.
      //
      // `explanation` is a different matter: nothing needs it before an
      // answer exists, so it is asked for only when a grade row proves one
      // does. These questions are one-shot, so a grade row IS that record.
      const { data: keyRow } = await supabase
        .from("questions")
        .select(grade ? "answer_key, explanation" : "answer_key")
        .eq("id", q.id)
        .maybeSingle();
      // EVERY read above, EVERY write below, and this the only thing between
      // them. The student can leave for another question while either read is
      // in flight, and everything past this point describes a question they
      // may no longer be looking at. A guard placed higher would not cover the
      // writes that follow the second read — and here a stale write would have
      // the hint button revealing another question's categories.
      if (selectionRef.current !== q.id) return;

      if (keyRow) {
        const row = keyRow as { answer_key?: unknown; explanation?: string | null };
        setSelectedQuestion((prev) =>
          prev && prev.id === q.id
            ? {
                ...prev,
                canonicalAssignments: classificationAssignmentsFromAnswerKey(
                  (row.answer_key ?? null) as never,
                ),
                explanation: row.explanation || "",
              }
            : prev,
        );
      }

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
      }
    } catch (err) {
      console.error("Failed to load existing classification grade:", err);
    } finally {
      // Only if this call is still the current one: a stale call clearing the
      // flag would show the new question as loaded while its own reads are
      // still in flight.
      if (selectionRef.current === q.id) setLoadingExisting(false);
    }
  };

  const submitFinal = useCallback(
    async (finalPlacements: Placement[], finalHintsUsed: number) => {
      if (!selectedQuestion || submitting) return;
      setSubmitting(true);
      try {
        const submittedMap: Record<string, string> = {};
        for (const p of finalPlacements) submittedMap[p.itemId] = p.categoryId;

        // Grade + persist server-side under the service role — RLS on
        // open_question_grades only permits admin/instructor writes, so a
        // direct client upsert would be rejected. The edge function also
        // recomputes the grade from answer_key so a tampered client can't
        // post a fake grade.
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) throw new Error("Not authenticated");
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/grade-deterministic-answer`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            questionId: selectedQuestion.id,
            courseId,
            questionType: "classification",
            submittedAnswer: submittedMap,
            hintsUsed: finalHintsUsed,
          }),
        });
        const json = await resp.json().catch(() => ({}));

        if (!resp.ok || json.error) {
          if (json.error === "already_submitted") {
            toast.info(json.message || "You've already submitted this answer.");
            await selectQuestion(selectedQuestion);
            return;
          }
          throw new Error(json.message || json.error || "Failed to submit answer");
        }

        const gr = (json.gapResults ?? {}) as {
          perItem?: Record<string, boolean>;
          allCorrect?: boolean;
          hintsUsed?: number;
        };
        const perItem = gr.perItem && typeof gr.perItem === "object" ? gr.perItem : {};
        const allCorrect = !!gr.allCorrect;
        const grade = typeof json.grade === "number" ? json.grade : 0;

        // The explanation for the answer just recorded (#1011). The key
        // itself is already in state — the hint button needed it — so only
        // this half arrives with the verdict.
        const reveal = revealFrom(json);
        if (reveal) {
          setSelectedQuestion((prev) =>
            prev && prev.id === selectedQuestion.id
              ? { ...prev, explanation: reveal.explanation ?? "" }
              : prev,
          );
        }

        const correctCount = Object.values(perItem).filter(Boolean).length;
        const totalCount = Object.keys(perItem).length;

        setSubmitted({
          perItem,
          allCorrect,
          submitted: submittedMap,
          grade,
          hintsUsed: typeof gr.hintsUsed === "number" ? gr.hintsUsed : finalHintsUsed,
        });
        setQuestions((prev) =>
          prev.map((qq) => (qq.id === selectedQuestion.id ? { ...qq, isCompleted: true } : qq)),
        );
        if (allCorrect) {
          toast.success("All items classified correctly!");
        } else {
          toast.info(`${correctCount} of ${totalCount} items classified correctly.`);
        }
      } catch (err: any) {
        console.error("Submit error:", err);
        toast.error(err?.message || "Failed to submit answer");
      } finally {
        setSubmitting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectQuestion is stable per render and only used in the already_submitted retry path
    [selectedQuestion, courseId, submitting],
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
    const correctCategoryId = selectedQuestion?.canonicalAssignments[currentItem.id];
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

  const getDifficultyColor = getDifficultyClass;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (selectedQuestion) {
    const submittedView = submitted !== null;
    const totalItems = shuffledItems.length;
    const currentPosition = Math.min(placed.length + 1, totalItems);

    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSelectedQuestion(null)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h3 className="font-semibold text-sm">Classification</h3>
              <p className="text-xs text-muted-foreground">
                {submittedView
                  ? "Submitted — review your placements below."
                  : "Tap the category each card belongs to. One submission per question."}
              </p>
            </div>
          </div>
          <Badge className={getDifficultyColor(selectedQuestion.difficulty)}>
            {selectedQuestion.difficulty}
          </Badge>
        </div>

        {loadingExisting ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Card>
            <CardContent className="p-4 space-y-4">
              {selectedQuestion.diagram?.source && (
                <QuestionDiagram
                  source={selectedQuestion.diagram.source}
                  alt={selectedQuestion.diagram.alt ?? null}
                />
              )}
              <div
                className="text-base font-medium prose prose-sm dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{
                  __html: formatQuestionText(selectedQuestion.prompt),
                }}
              />

              {!submittedView ? (
                <>
                  {/* Category bucket buttons across the top */}
                  <div
                    className="flex flex-wrap gap-2 justify-center"
                    role="group"
                    aria-label="Category buckets"
                    onKeyDown={(e) => {
                      // Arrow-key navigation between category buttons —
                      // each focusable button advances/retreats focus
                      // within the group for keyboard users.
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
                    {selectedQuestion.categories.map((cat) => {
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
                          aria-label={`Place card in ${cat.label}`}
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

                  {/* Current card */}
                  {currentItem ? (
                    <Card className="border-2 border-primary/40">
                      <CardContent className="p-6 flex flex-col items-center gap-3">
                        <span className="text-xs text-muted-foreground tabular-nums">
                          ({currentPosition}/{totalItems})
                        </span>
                        <div
                          className="text-lg font-medium text-center prose prose-base dark:prose-invert max-w-none"
                          dangerouslySetInnerHTML={{
                            __html: processLatexContent(currentItem.text),
                          }}
                        />
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="flex items-center justify-center py-8">
                      {isFinished ? (
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      ) : (
                        <p className="text-sm text-muted-foreground">No cards left.</p>
                      )}
                    </div>
                  )}

                  {/* Control row: hint, undo, restart */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleHint}
                      disabled={!currentItem || hintsRemaining <= 0 || submitting || !!hintCategoryId}
                      className="gap-1.5"
                      aria-label={`Get a hint, ${hintsRemaining} remaining`}
                    >
                      <Lightbulb className="w-4 h-4" />
                      Get a hint!
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
                        Undo
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
                        Restart
                      </Button>
                    </div>
                  </div>

                  {submitting && (
                    <div className="flex items-center justify-center pt-2">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-sm text-muted-foreground">Submitting…</span>
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
                      Grade: {submitted!.grade}/100
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {
                        Object.values(submitted!.perItem).filter((v) => v).length
                      } of {Object.keys(submitted!.perItem).length} items correct · {submitted!.hintsUsed} hint(s) used
                    </span>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground text-xs">Per-item placements</Label>
                    <div className="space-y-1.5">
                      {selectedQuestion.items.map((it) => {
                        const submittedCategoryId = submitted!.submitted[it.id];
                        const correctCategoryId = selectedQuestion.canonicalAssignments[it.id];
                        const submittedLabel =
                          selectedQuestion.categories.find((c) => c.id === submittedCategoryId)?.label ?? "—";
                        const correctLabel =
                          selectedQuestion.categories.find((c) => c.id === correctCategoryId)?.label ?? "?";
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

                  {selectedQuestion.explanation && (
                    <div>
                      <Label className="text-muted-foreground text-xs">Explanation</Label>
                      <div
                        className="mt-1 text-sm prose prose-sm dark:prose-invert max-w-none"
                        dangerouslySetInnerHTML={{
                          __html: formatQuestionText(selectedQuestion.explanation),
                        }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground italic">
                    Classification questions allow only one submission per question.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h2 className="text-xl font-display font-bold">Classification</h2>
          <p className="text-sm text-muted-foreground">
            Sort cards into named category buckets one at a time
          </p>
        </div>
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FolderTree className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No questions available yet</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Difficulty</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead className="w-[100px] text-center">Status</TableHead>
                  <TableHead className="w-[100px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map((q) => (
                  <TableRow key={q.id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell>
                      <Badge className={getDifficultyColor(q.difficulty)}>{q.difficulty}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div
                        className="prose prose-sm dark:prose-invert max-w-none"
                        dangerouslySetInnerHTML={{
                          __html: formatQuestionText(q.prompt),
                        }}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      {q.isCompleted && (
                        <Badge
                          variant="outline"
                          className="bg-green-500/10 text-green-600 border-green-500/20"
                        >
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Completed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => selectQuestion(q)}>
                        {q.isCompleted ? "View" : "Start"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default StudentClassificationQuestions;
