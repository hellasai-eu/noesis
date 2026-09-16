import { useState, useEffect, useMemo, useRef } from "react";
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
  ListOrdered,
  Loader2,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Send,
  GripVertical,
} from "lucide-react";
import { toast } from "sonner";
import {
  orderingItemsFromPayload,
  orderingPromptFromPayload,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import { revealFrom } from "@/lib/question-reveal";
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { getDifficultyClass } from "@/lib/difficulty-color";
import "katex/dist/katex.min.css";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface OrderingListQuestion {
  id: string;
  prompt: string;
  // Canonical (correct) order. Never displayed to the student before submit.
  canonicalItems: string[];
  explanation: string;
  difficulty: string;
  isCompleted: boolean;
  diagram?: { source: string; alt?: string } | null;
}

interface SubmittedRecord {
  perPosition: boolean[];
  allCorrect: boolean;
  submitted: string[];
  grade: number;
}

interface Props {
  courseId: string;
  offeringId?: string | null;
  onBack: () => void;
}

/**
 * Deterministic 32-bit hash of a string (cyrb53-lite). Used to seed the
 * per-(student, question) shuffle so the same student sees the same order
 * on re-render but different students see different orders.
 */
function hashString(s: string): number {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates with a seeded PRNG so the shuffle is deterministic for the
 * given seed string. Different (questionId, userId) pairs produce different
 * shuffles, but a single re-render reproduces the same order.
 */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const out = [...items];
  const rand = mulberry32(hashString(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface SortableStudentRowProps {
  uid: string;
  text: string;
  index: number;
  disabled: boolean;
  submittedView: boolean;
  isCorrect: boolean | null;
}

function SortableStudentRow({
  uid,
  text,
  index,
  disabled,
  submittedView,
  isCorrect,
}: SortableStudentRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: uid, disabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-md border p-3 bg-background ${
        submittedView
          ? isCorrect
            ? "border-green-500 bg-green-50 dark:bg-green-950/30"
            : "border-destructive bg-red-50 dark:bg-red-950/30"
          : ""
      }`}
    >
      <button
        type="button"
        className={`text-muted-foreground ${
          disabled ? "cursor-not-allowed opacity-50" : "cursor-grab hover:text-foreground active:cursor-grabbing"
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded`}
        aria-label={`Drag item at position ${index + 1}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-5 w-5" />
      </button>
      <span className="text-xs text-muted-foreground w-6 text-right tabular-nums">
        {index + 1}.
      </span>
      <span
        className="flex-1 text-sm"
        dangerouslySetInnerHTML={{ __html: processLatexContent(text) }}
      />
      {submittedView && isCorrect === true && (
        <CheckCircle2 data-testid="ordering-row-correct" className="w-4 h-4 text-green-600" />
      )}
      {submittedView && isCorrect === false && (
        <XCircle data-testid="ordering-row-incorrect" className="w-4 h-4 text-destructive" />
      )}
    </div>
  );
}

const StudentOrderingQuestions = ({ courseId, offeringId, onBack }: Props) => {
  const [questions, setQuestions] = useState<OrderingListQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedQuestion, setSelectedQuestion] = useState<OrderingListQuestion | null>(null);
  // The current draggable order, as canonical strings, in the student's
  // chosen order. We track item identity by index in the canonical array
  // (stable per question), so dragging never re-randomizes mid-drag.
  const [currentOrder, setCurrentOrder] = useState<string[]>([]);
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

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
                .eq("type", "ordering")
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
          .eq("type", "ordering")
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

      const mapped: OrderingListQuestion[] = rows.map((r: any) => ({
        id: r.id,
        prompt: orderingPromptFromPayload(r.payload),
        canonicalItems: orderingItemsFromPayload(r.payload),
        // Withheld until the student has answered (#1011): an explanation is
        // written to justify the key, so it gives the order away as readily.
        //
        // `canonicalItems` cannot be withheld the same way — an ordering
        // question's correct sequence IS its `payload.items`, so the renderer
        // needs it to draw the question at all. That is #1117, and no fetch
        // narrowing can close it.
        explanation: "",
        difficulty: r.difficulty,
        isCompleted: completed.has(r.id),
        diagram: questionDiagramFromPayload(r.payload),
      }));
      setQuestions(mapped);
    } catch (err: any) {
      console.error("Error fetching ordering questions:", err);
      toast.error("Failed to load questions");
    } finally {
      setLoading(false);
    }
  };

  // Memoize the initial shuffled order per (question, user) so re-renders
  // don't re-randomize. The seeded shuffle in seededShuffle is deterministic
  // given the same seed, but recomputing on every render would still re-run
  // the work; memoizing also lets us reset currentOrder to it on selection.
  const initialShuffledItems = useMemo(() => {
    if (!selectedQuestion || !userId) return [];
    return seededShuffle(selectedQuestion.canonicalItems, `${selectedQuestion.id}::${userId}`);
  }, [selectedQuestion, userId]);

  const selectQuestion = async (q: OrderingListQuestion) => {
    selectionRef.current = q.id;
    setSelectedQuestion(q);
    setSubmitted(null);
    setCurrentOrder([]);
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

      // These are one-shot, so a grade row IS the record of an answer. Only
      // then is the explanation fetched, for this one question rather than the
      // whole list (#1011).
      const { data: keyRow } = grade
        ? await supabase
            .from("questions")
            .select("explanation")
            .eq("id", q.id)
            .maybeSingle()
        : { data: null };

      // EVERY read above, EVERY write below, and this the only thing between
      // them. The student can leave for another question while either read is
      // in flight, and everything past this point describes a question they
      // may no longer be looking at. A guard placed higher would not cover the
      // writes that follow the second read.
      if (selectionRef.current !== q.id) return;

      if (keyRow) {
        setSelectedQuestion((prev) =>
          prev && prev.id === q.id
            ? { ...prev, explanation: keyRow.explanation || "" }
            : prev,
        );
      }

      if (grade && grade.gap_results) {
        const submittedArr = (() => {
          try {
            const parsed = JSON.parse(grade.submitted_answer || "[]");
            return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
          } catch {
            return [];
          }
        })();
        const gr = grade.gap_results as { perPosition?: boolean[]; allCorrect?: boolean };
        setSubmitted({
          perPosition: Array.isArray(gr.perPosition) ? gr.perPosition : [],
          allCorrect: !!gr.allCorrect,
          submitted: submittedArr,
          grade: grade.grade ?? 0,
        });
        setCurrentOrder(submittedArr);
      }
    } catch (err) {
      console.error("Failed to load existing ordering grade:", err);
    } finally {
      // Only if this call is still the current one: a stale call clearing the
      // flag would show the new question as loaded while its own reads are
      // still in flight.
      if (selectionRef.current === q.id) setLoadingExisting(false);
    }
  };

  // When entering edit mode for the first time (no prior submission and
  // we haven't initialized the order yet), seed from the shuffled order.
  useEffect(() => {
    if (
      selectedQuestion &&
      !submitted &&
      currentOrder.length === 0 &&
      initialShuffledItems.length > 0
    ) {
      setCurrentOrder(initialShuffledItems);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial seed only
  }, [initialShuffledItems, selectedQuestion]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (submitted) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setCurrentOrder((prev) => {
      const oldIndex = prev.indexOf(String(active.id));
      const newIndex = prev.indexOf(String(over.id));
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleSubmit = async () => {
    if (!selectedQuestion || submitting) return;
    setSubmitting(true);
    try {
      // Grade + persist server-side under the service role — RLS on
      // open_question_grades only permits admin/instructor writes, so a
      // direct client upsert would be rejected. The edge function also
      // recomputes the grade from the question's canonical order so a
      // tampered client can't post a fake grade.
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/grade-deterministic-answer`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          questionId: selectedQuestion.id,
          courseId,
          questionType: "ordering",
          submittedAnswer: currentOrder,
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
        perPosition?: boolean[];
        allCorrect?: boolean;
      };
      const perPosition = Array.isArray(gr.perPosition) ? gr.perPosition : [];
      const allCorrect = !!gr.allCorrect;
      const correctCount = perPosition.filter(Boolean).length;
      const totalCount = perPosition.length;
      const grade = typeof json.grade === "number" ? json.grade : 0;

      // The explanation for the answer just recorded — not fetched with the
      // question any more (#1011).
      const reveal = revealFrom(json);
      if (reveal) {
        setSelectedQuestion((prev) =>
          prev && prev.id === selectedQuestion.id
            ? { ...prev, explanation: reveal.explanation ?? "" }
            : prev,
        );
      }

      setSubmitted({
        perPosition,
        allCorrect,
        submitted: [...currentOrder],
        grade,
      });
      setQuestions((prev) =>
        prev.map((qq) => (qq.id === selectedQuestion.id ? { ...qq, isCompleted: true } : qq)),
      );
      if (allCorrect) {
        toast.success("All positions correct!");
      } else {
        toast.info(`${correctCount} of ${totalCount} positions correct.`);
      }
    } catch (err: any) {
      console.error("Submit error:", err);
      toast.error(err?.message || "Failed to submit answer");
    } finally {
      setSubmitting(false);
    }
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
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSelectedQuestion(null)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h3 className="font-semibold text-sm">Ordering</h3>
              <p className="text-xs text-muted-foreground">
                {submittedView
                  ? "Submitted — review your order below."
                  : "Drag items into the correct order. One submission per question."}
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

              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={currentOrder}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {currentOrder.map((item, idx) => {
                      const isCorrect = submittedView
                        ? submitted!.perPosition[idx] ?? false
                        : null;
                      return (
                        <SortableStudentRow
                          key={item}
                          uid={item}
                          text={item}
                          index={idx}
                          disabled={submittedView || submitting}
                          submittedView={submittedView}
                          isCorrect={isCorrect}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>

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
                      Grade: {submitted!.grade}/100
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {submitted!.perPosition.filter(Boolean).length} of {submitted!.perPosition.length} positions correct
                    </span>
                  </div>
                  {!submitted!.allCorrect && (
                    <div className="space-y-1">
                      <Label className="text-muted-foreground text-xs">Correct order</Label>
                      <ol className="text-sm space-y-1 list-decimal list-inside">
                        {selectedQuestion.canonicalItems.map((item) => (
                          <li key={item} className="font-medium">
                            <span
                              dangerouslySetInnerHTML={{ __html: processLatexContent(item) }}
                            />
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
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
                    Ordering questions allow only one submission per question.
                  </p>
                </div>
              )}

              {!submittedView && (
                <div className="flex justify-end pt-2 border-t">
                  <Button
                    size="sm"
                    onClick={handleSubmit}
                    disabled={submitting || currentOrder.length === 0}
                    className="gap-2"
                  >
                    {submitting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    {submitting ? "Submitting..." : "Submit"}
                  </Button>
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
          <h2 className="text-xl font-display font-bold">Ordering</h2>
          <p className="text-sm text-muted-foreground">
            Drag a shuffled list of items into the correct sequence
          </p>
        </div>
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ListOrdered className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
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

export default StudentOrderingQuestions;
