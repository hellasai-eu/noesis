import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Puzzle,
  Loader2,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import {
  fillGapsAcceptableAnswersFromAnswerKey,
  fillGapsSkeletonFromStem,
  fillGapsStemFromPayload,
  questionDiagramFromPayload,
} from "@/lib/question-payload";
import { revealFrom } from "@/lib/question-reveal";
import { formatQuestionText, processLatexContent } from "@/lib/latex-utils";
import { QuestionDiagram } from "@/components/QuestionDiagram";
import { getDifficultyClass } from "@/lib/difficulty-color";
import "katex/dist/katex.min.css";

interface FillGapsListQuestion {
  id: string;
  stem: string;
  /**
   * Before the student answers this is the ordinal SKELETON read off the
   * stem — every `acceptable` list empty — which is all the renderer needs to
   * place and size the inputs. The real acceptable answers arrive only once
   * there is an answer on record (#1011): from the grader's `reveal` on
   * submit, or from a one-question fetch when reopening a completed one.
   */
  gaps: { ordinal: number; acceptable: string[] }[];
  /** Justifies the key, so it is withheld with it. Empty until reveal. */
  explanation: string;
  difficulty: string;
  isCompleted: boolean;
  diagram?: { source: string; alt?: string } | null;
}

interface SubmittedRecord {
  perGap: boolean[];
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
 * Splits a stem on `{{N}}` placeholders, yielding a flat list of segments
 * that the renderer can map to either text spans or inputs. Returns
 * alternating "text" / "gap" entries; the first segment is always text
 * (possibly empty).
 */
function splitStem(stem: string): Array<{ kind: "text"; value: string } | { kind: "gap"; ordinal: number }> {
  const out: Array<{ kind: "text"; value: string } | { kind: "gap"; ordinal: number }> = [];
  const re = /\{\{(\d+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stem)) !== null) {
    out.push({ kind: "text", value: stem.slice(lastIndex, match.index) });
    out.push({ kind: "gap", ordinal: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  out.push({ kind: "text", value: stem.slice(lastIndex) });
  return out;
}

const StudentFillGapsQuestions = ({ courseId, offeringId, onBack }: Props) => {
  const [questions, setQuestions] = useState<FillGapsListQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedQuestion, setSelectedQuestion] = useState<FillGapsListQuestion | null>(null);
  const [inputs, setInputs] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<SubmittedRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(false);
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
                .eq("type", "fill_gaps")
                .in("id", cids),
            ),
          );
          for (const { data, error } of results) {
            if (error) throw error;
            rows.push(...(data || []).filter((q: any) => !q.hidden));
          }
        }
      } else {
        // Neither `answer_key` nor `explanation`: this is a whole course's
        // worth of questions, so requesting them handed over every acceptable
        // answer in the course before the student opened one (#1011).
        const { data, error } = await supabase
          .from("questions")
          .select("id, payload, difficulty")
          .eq("course_id", courseId)
          .eq("type", "fill_gaps")
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

      const mapped: FillGapsListQuestion[] = rows.map((r: any) => {
        const stem = fillGapsStemFromPayload(r.payload);
        return {
          id: r.id,
          stem,
          gaps: fillGapsSkeletonFromStem(stem),
          explanation: "",
          difficulty: r.difficulty,
          isCompleted: completed.has(r.id),
          diagram: questionDiagramFromPayload(r.payload),
        };
      });
      setQuestions(mapped);
    } catch (err: any) {
      console.error("Error fetching fill-gaps questions:", err);
      toast.error("Failed to load questions");
    } finally {
      setLoading(false);
    }
  };

  const selectQuestion = async (q: FillGapsListQuestion) => {
    selectionRef.current = q.id;
    setSelectedQuestion(q);
    setInputs(new Array(q.gaps.length).fill(""));
    setSubmitted(null);
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

      // Reopening a question this student already answered — these are
      // one-shot, so a grade row IS the record of an answer. Only now is the
      // key fetched, for this one question rather than the whole list, which
      // is what lets the review still show the expected answers (#1011).
      const { data: keyRow } = grade
        ? await supabase
            .from("questions")
            .select("answer_key, explanation")
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
            ? {
                ...prev,
                gaps: fillGapsAcceptableAnswersFromAnswerKey(keyRow.answer_key),
                explanation: keyRow.explanation || "",
              }
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
        const gr = grade.gap_results as { perGap?: boolean[]; allCorrect?: boolean };
        setSubmitted({
          perGap: Array.isArray(gr.perGap) ? gr.perGap : [],
          allCorrect: !!gr.allCorrect,
          submitted: submittedArr,
          grade: grade.grade ?? 0,
        });
      }
    } catch (err) {
      console.error("Failed to load existing fill-gaps grade:", err);
    } finally {
      // Only if this call is still the current one: a stale call clearing the
      // flag would show the new question as loaded while its own reads are
      // still in flight.
      if (selectionRef.current === q.id) setLoadingExisting(false);
    }
  };

  const handleSubmit = async () => {
    if (!selectedQuestion || submitting) return;
    if (inputs.some((v) => v.trim().length === 0)) {
      toast.error("Please fill in every blank before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      // Grade + persist server-side under the service role — RLS on
      // open_question_grades only permits admin/instructor writes, so a
      // direct client upsert would be rejected. The edge function also
      // recomputes the grade from answer_key so a tampered client can't
      // post a fake grade.
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
          questionType: "fill_gaps",
          submittedAnswer: inputs,
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

      const gr = (json.gapResults ?? {}) as { perGap?: boolean[]; allCorrect?: boolean };
      const perGap = Array.isArray(gr.perGap) ? gr.perGap : [];
      const allCorrect = !!gr.allCorrect;
      const correctCount = perGap.filter(Boolean).length;
      const totalCount = perGap.length;
      const grade = typeof json.grade === "number" ? json.grade : 0;

      // The expected-answer list and the explanation, for the answer just
      // recorded. Not fetched with the question any more (#1011), so without
      // this the review would have nothing to show but the marks.
      const reveal = revealFrom(json);
      if (reveal) {
        setSelectedQuestion((prev) =>
          prev && prev.id === selectedQuestion.id
            ? {
                ...prev,
                gaps: reveal.fillGapsGaps ?? prev.gaps,
                explanation: reveal.explanation ?? "",
              }
            : prev,
        );
      }

      setSubmitted({
        perGap,
        allCorrect,
        submitted: [...inputs],
        grade,
      });
      setQuestions((prev) =>
        prev.map((qq) => (qq.id === selectedQuestion.id ? { ...qq, isCompleted: true } : qq)),
      );
      if (allCorrect) {
        toast.success("All gaps correct!");
      } else {
        toast.info(`${correctCount} of ${totalCount} gaps correct.`);
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
    const segments = splitStem(selectedQuestion.stem);
    const submittedView = submitted !== null;
    const GAP_INPUT_WIDTH_CH = 15;

    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSelectedQuestion(null)}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div>
              <h3 className="font-semibold text-sm">Fill the Gaps</h3>
              <p className="text-xs text-muted-foreground">
                {submittedView
                  ? "Submitted — review your answers below."
                  : "Type one answer per blank. One submission per question."}
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
              <div className="flex flex-wrap items-baseline gap-x-1 gap-y-2 text-base leading-relaxed">
                {segments.map((seg, i) => {
                  if (seg.kind === "text") {
                    return (
                      <span
                        key={`t-${i}`}
                        className="whitespace-pre-wrap"
                        dangerouslySetInnerHTML={{ __html: processLatexContent(seg.value) }}
                      />
                    );
                  }
                  const gapIndex = selectedQuestion.gaps.findIndex(
                    (g) => g.ordinal === seg.ordinal,
                  );
                  if (gapIndex < 0) {
                    // Stem references an ordinal with no gap entry — render a literal placeholder.
                    return (
                      <span key={`g-${i}`} className="text-destructive italic">
                        ___({seg.ordinal})
                      </span>
                    );
                  }
                  const submittedValue = submittedView ? submitted.submitted[gapIndex] || "" : "";
                  const isCorrect = submittedView ? submitted.perGap[gapIndex] : null;
                  return (
                    <span
                      key={`g-${i}`}
                      className="inline-flex items-center gap-1"
                    >
                      <Input
                        aria-label={`Gap ${seg.ordinal}`}
                        value={submittedView ? submittedValue : inputs[gapIndex] || ""}
                        onChange={(e) => {
                          if (submittedView) return;
                          setInputs((prev) => {
                            const next = [...prev];
                            next[gapIndex] = e.target.value;
                            return next;
                          });
                        }}
                        disabled={submittedView || submitting}
                        style={{ width: `${GAP_INPUT_WIDTH_CH}ch` }}
                        className={`inline h-8 px-2 text-sm align-baseline ${
                          submittedView
                            ? isCorrect
                              ? "border-green-500 bg-green-50 dark:bg-green-950/30"
                              : "border-destructive bg-red-50 dark:bg-red-950/30"
                            : ""
                        }`}
                      />
                      {submittedView && isCorrect === true && (
                        <CheckCircle2 className="w-4 h-4 text-green-600 inline" />
                      )}
                      {submittedView && isCorrect === false && (
                        <XCircle className="w-4 h-4 text-destructive inline" />
                      )}
                    </span>
                  );
                })}
              </div>

              {submittedView && (
                <div className="space-y-2 pt-2 border-t">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        submitted.allCorrect
                          ? "bg-green-500/10 text-green-700 border-green-500/20"
                          : "bg-amber-500/10 text-amber-700 border-amber-500/20"
                      }
                    >
                      Grade: {submitted.grade}/100
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {submitted.perGap.filter(Boolean).length} of {submitted.perGap.length} gaps correct
                    </span>
                  </div>
                  {!submitted.allCorrect && (
                    <div className="space-y-1">
                      <Label className="text-muted-foreground text-xs">Expected answers</Label>
                      <ul className="text-sm space-y-1">
                        {selectedQuestion.gaps.map((g, idx) => {
                          if (submitted.perGap[idx]) return null;
                          return (
                            <li key={g.ordinal} className="flex items-baseline gap-2">
                              <span className="text-xs text-muted-foreground">
                                Gap {g.ordinal}:
                              </span>
                              <span className="font-medium">{g.acceptable[0]}</span>
                              {g.acceptable.length > 1 && (
                                <span className="text-xs text-muted-foreground">
                                  (also accepted: {g.acceptable.slice(1).join(", ")})
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}
                  {selectedQuestion.explanation && (
                    <div>
                      <Label className="text-muted-foreground text-xs">Explanation</Label>
                      {/* The gap segments above already render their LaTeX; the
                          explanation of the same question was printed raw. */}
                      <div
                        className="mt-1 text-sm"
                        dangerouslySetInnerHTML={{
                          __html: processLatexContent(selectedQuestion.explanation),
                        }}
                      />
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground italic">
                    Fill-the-gaps questions allow only one submission per question.
                  </p>
                </div>
              )}

              {!submittedView && (
                <div className="flex justify-end pt-2 border-t">
                  <Button
                    size="sm"
                    onClick={handleSubmit}
                    disabled={submitting || inputs.some((v) => v.trim().length === 0)}
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
          <h2 className="text-xl font-display font-bold">Fill the Gaps</h2>
          <p className="text-sm text-muted-foreground">
            Cloze-style questions — type one short answer per blank
          </p>
        </div>
      </div>

      {questions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Puzzle className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
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
                  <TableHead>Stem (preview)</TableHead>
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
                          __html: formatQuestionText(
                            // U+2017 (DOUBLE LOW LINE) so multiple placeholders
                            // don't form a `__bold__` pair when fed to the
                            // markdown step in formatQuestionText.
                            q.stem.replace(/\{\{(\d+)\}\}/g, "‗‗‗"),
                          ),
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

export default StudentFillGapsQuestions;
