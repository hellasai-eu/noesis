/**
 * Build a study guide piece by piece (#1004).
 *
 * Each piece moves through three states the instructor drives by hand:
 *
 *   outlined   title only, no theory yet          -> "Write theory"
 *   written    theory exists, no questions yet    -> edit it, then "Generate questions"
 *   complete   theory + questions                 -> ready to publish
 *
 * Questions are generated FROM the stored theory, so editing the theory and
 * saving before generating is the point of the flow, not an afterthought. When
 * theory changes under existing questions the piece is flagged, because those
 * questions now test text the student no longer reads.
 *
 * Questions are read-only here beyond deletion. There is no shared per-type
 * question editor in the codebase (#1001); removing a bad question and
 * regenerating is the recovery path until there is.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Loader2,
  PenLine,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { CheatSheetEditor } from "@/components/CheatSheetEditor";
import { TypeBadge } from "@/components/UnifiedQuestionsTable";
import { QuestionEditorDialog } from "@/components/question-bank/editor";
import type { QuestionType } from "@/types/question";
import { pieceIsStale } from "@/lib/study-guide";
import { formatQuestionText } from "@/lib/latex-utils";

interface PieceQuestion {
  id: string;
  question: string;
  type: QuestionType;
  position: number;
}

interface Piece {
  id: string;
  position: number;
  title: string;
  theory_html: string | null;
  theory_updated_at: string | null;
  questions_generated_at: string | null;
  questions: PieceQuestion[];
}

/**
 * What the instructor may pin for a generation run (#1006). "mixed" keeps the
 * model choosing, which is what it did before these controls existed.
 *
 * Type defaults to MCQ rather than mixed: it is the type instructors reach for
 * most, and an explicit default is easier to override than to discover.
 */
const QUESTION_TYPE_CHOICES: Array<{ value: string; label: string }> = [
  { value: "mcq", label: "Multiple choice" },
  { value: "open", label: "Open answer" },
  { value: "fill_gaps", label: "Fill the gaps" },
  { value: "ordering", label: "Ordering" },
  { value: "classification", label: "Classification" },
  { value: "mixed", label: "Mixed" },
];

const DIFFICULTY_CHOICES: Array<{ value: string; label: string }> = [
  { value: "mixed", label: "Mixed" },
  { value: "easy", label: "Easy" },
  { value: "medium", label: "Medium" },
  { value: "hard", label: "Hard" },
];

const DEFAULT_QUESTION_TYPE = "mcq";
const DEFAULT_DIFFICULTY = "mixed";
const DEFAULT_QUESTION_COUNT = 5;
const MIN_QUESTION_COUNT = 1;
const MAX_QUESTION_COUNT = 20;

interface GenerationChoice {
  count: number;
  difficulty: string;
  questionType: string;
}

interface StudyGuidePieceEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studyGuideId: string | null;
  studyGuideTitle: string;
  onChanged?: () => void;
}

async function readInvokeError(error: unknown, fallback: string): Promise<string> {
  let message = (error as { message?: string })?.message ?? fallback;
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = await ctx.clone().json();
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON body — keep the generic message.
    }
  }
  return message;
}

/** Tags stripped, for places that need words rather than markup (aria labels). */
function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function hasTheory(piece: Piece): boolean {
  return (piece.theory_html ?? "").replace(/<[^>]+>/g, "").trim().length > 0;
}

export function StudyGuidePieceEditor({
  open,
  onOpenChange,
  studyGuideId,
  studyGuideTitle,
  onChanged,
}: StudyGuidePieceEditorProps) {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyPieceId, setBusyPieceId] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string>("");
  const [draftTheory, setDraftTheory] = useState<Record<string, string>>({});
  const [draftTitle, setDraftTitle] = useState<Record<string, string>>({});
  /** Free-text steering for the AI theory writer, per piece. Not persisted. */
  const [theoryPrompt, setTheoryPrompt] = useState<Record<string, string>>({});
  const [confirmDeleteQuestion, setConfirmDeleteQuestion] = useState<PieceQuestion | null>(null);
  const [editingQuestion, setEditingQuestion] = useState<PieceQuestion | null>(null);
  const [confirmDeletePiece, setConfirmDeletePiece] = useState<Piece | null>(null);
  /** Per piece, so configuring one does not silently change another. */
  const [choices, setChoices] = useState<Record<string, GenerationChoice>>({});

  function choiceFor(pieceId: string): GenerationChoice {
    return (
      choices[pieceId] ?? {
        count: DEFAULT_QUESTION_COUNT,
        difficulty: DEFAULT_DIFFICULTY,
        questionType: DEFAULT_QUESTION_TYPE,
      }
    );
  }

  function setChoice(pieceId: string, patch: Partial<GenerationChoice>) {
    setChoices((prev) => ({ ...prev, [pieceId]: { ...choiceFor(pieceId), ...patch } }));
  }

  const load = useCallback(async () => {
    if (!studyGuideId) return;
    setLoading(true);
    try {
      const { data: pieceRows, error: pieceError } = await supabase
        .from("study_guide_pieces")
        .select("id, position, title, theory_html, theory_updated_at, questions_generated_at")
        .eq("study_guide_id", studyGuideId)
        .order("position", { ascending: true });
      if (pieceError) throw pieceError;

      const ids = (pieceRows ?? []).map((p) => p.id);
      const byPiece: Record<string, PieceQuestion[]> = {};
      if (ids.length > 0) {
        const { data: linkRows, error: linkError } = await supabase
          .from("study_guide_piece_questions")
          .select("piece_id, position, questions!inner(id, question, type)")
          .in("piece_id", ids)
          .order("position", { ascending: true });
        if (linkError) throw linkError;
        for (const row of linkRows ?? []) {
          const r = row as unknown as {
            piece_id: string;
            position: number;
            questions: { id: string; question: string; type: string };
          };
          (byPiece[r.piece_id] ??= []).push({
            id: r.questions.id,
            question: r.questions.question,
            type: r.questions.type as QuestionType,
            position: r.position,
          });
        }
      }

      const next: Piece[] = (pieceRows ?? []).map((p) => ({
        id: p.id,
        position: p.position,
        title: p.title,
        theory_html: p.theory_html,
        theory_updated_at: p.theory_updated_at,
        questions_generated_at: p.questions_generated_at,
        questions: byPiece[p.id] ?? [],
      }));
      setPieces(next);
      setDraftTheory(Object.fromEntries(next.map((p) => [p.id, p.theory_html ?? ""])));
      setDraftTitle(Object.fromEntries(next.map((p) => [p.id, p.title])));
    } catch (err) {
      console.error("Failed to load study guide pieces", err);
      toast.error("Could not load this study guide");
    } finally {
      setLoading(false);
    }
  }, [studyGuideId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function withBusy(piece: Piece, label: string, fn: () => Promise<void>) {
    setBusyPieceId(piece.id);
    setBusyLabel(label);
    try {
      await fn();
    } finally {
      setBusyPieceId(null);
      setBusyLabel("");
    }
  }

  async function writeTheory(piece: Piece) {
    await withBusy(piece, "theory", async () => {
      try {
        const instructions = (theoryPrompt[piece.id] ?? "").trim();
        const { data, error } = await supabase.functions.invoke(
          "generate-study-guide-theory",
          {
            body: {
              pieceId: piece.id,
              ...(instructions ? { specialInstructions: instructions } : {}),
            },
          },
        );
        if (error) throw new Error(await readInvokeError(error, "Could not write the theory"));
        if (data?.error) throw new Error(data.error);
        toast.success(`Theory written for "${piece.title}"`);
        // Staleness follows from the stored timestamps; nothing to remember.
        await load();
        onChanged?.();
      } catch (err) {
        console.error("Failed to write theory", err);
        toast.error((err as Error).message || "Could not write the theory");
      }
    });
  }

  async function generateQuestions(piece: Piece) {
    await withBusy(piece, "questions", async () => {
      try {
        const choice = choiceFor(piece.id);
        const { data, error } = await supabase.functions.invoke(
          "generate-study-guide-questions",
          {
            body: {
              pieceId: piece.id,
              count: choice.count,
              difficulty: choice.difficulty,
              questionType: choice.questionType,
            },
          },
        );
        if (error) throw new Error(await readInvokeError(error, "Could not generate questions"));
        if (data?.error) throw new Error(data.error);
        const inserted = typeof data?.inserted === "number" ? data.inserted : 0;
        const rejected = typeof data?.rejected === "number" ? data.rejected : 0;
        toast.success(
          rejected > 0
            ? `${inserted} questions added — ${rejected} discarded as malformed`
            : `${inserted} questions added`,
        );
        await load();
        onChanged?.();
      } catch (err) {
        console.error("Failed to generate questions", err);
        toast.error((err as Error).message || "Could not generate questions");
      }
    });
  }

  async function savePiece(piece: Piece) {
    await withBusy(piece, "save", async () => {
      try {
        const nextTheory = draftTheory[piece.id] ?? piece.theory_html ?? "";
        const { error } = await supabase
          .from("study_guide_pieces")
          .update({
            title: (draftTitle[piece.id] ?? piece.title).trim() || piece.title,
            theory_html: nextTheory,
          })
          .eq("id", piece.id);
        if (error) throw error;
        // A theory change bumps theory_updated_at via trigger, so the staleness
        // badge appears on reload without being tracked here.
        toast.success("Piece saved");
        await load();
        onChanged?.();
      } catch (err) {
        console.error("Failed to save piece", err);
        toast.error("Could not save this piece");
      }
    });
  }

  async function movePiece(piece: Piece, direction: "up" | "down") {
    await withBusy(piece, "move", async () => {
      try {
        // One RPC: UNIQUE (study_guide_id, position) makes a client-side
        // two-update swap collide with the neighbour it is swapping with.
        const { error } = await supabase.rpc("move_study_guide_piece", {
          _piece_id: piece.id,
          _direction: direction,
        });
        if (error) throw error;
        await load();
        onChanged?.();
      } catch (err) {
        console.error("Failed to move piece", err);
        toast.error("Could not reorder the pieces");
      }
    });
  }

  async function deletePiece(piece: Piece) {
    try {
      // Through the RPC: a plain delete would strand this piece's generated
      // questions in the Question Bank (the cascade removes only the junction
      // rows that identify them), silently destroy any student submissions,
      // and leave a gap in the position sequence students advance through.
      const { error } = await supabase.rpc("delete_study_guide_piece", {
        _piece_id: piece.id,
      });
      if (error) throw error;
      toast.success(`"${piece.title}" removed`);
      await load();
      onChanged?.();
    } catch (err) {
      console.error("Failed to delete piece", err);
      toast.error((err as Error).message || "Could not remove this piece");
    } finally {
      setConfirmDeletePiece(null);
    }
  }

  async function deleteQuestion(question: PieceQuestion) {
    try {
      // Through the RPC, not a plain delete: `study_guide_answers.question_id`
      // cascades, so a direct delete would silently destroy student work. The
      // RPC locks the row, re-checks, and refuses.
      const { error } = await supabase.rpc("delete_study_guide_question", {
        _question_id: question.id,
      });
      if (error) throw error;
      toast.success("Question removed");
      await load();
      onChanged?.();
    } catch (err) {
      console.error("Failed to delete question", err);
      toast.error((err as Error).message || "Could not remove this question");
    } finally {
      setConfirmDeleteQuestion(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl h-[88vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{studyGuideTitle}</DialogTitle>
            <DialogDescription>
              Write the theory for each piece, edit it until you are happy, then generate its
              questions from that text. Students work through the pieces in order.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center flex-1 text-muted-foreground">
              <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading pieces…
            </div>
          ) : pieces.length === 0 ? (
            <div className="flex items-center justify-center flex-1 text-sm text-muted-foreground">
              This guide has no pieces yet — build its outline first.
            </div>
          ) : (
            <ScrollableDialogBody className="pr-3">
              <Accordion type="multiple" className="space-y-2">
                {pieces.map((piece, index) => {
                  const written = hasTheory(piece);
                  const complete = written && piece.questions.length > 0;
                  const stale =
                    piece.questions.length > 0 &&
                    pieceIsStale(piece.questions_generated_at, piece.theory_updated_at);
                  const busy = busyPieceId === piece.id;
                  return (
                    <AccordionItem
                      key={piece.id}
                      value={piece.id}
                      className="border rounded-md px-3"
                      data-testid={`sg-piece-${piece.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <AccordionTrigger className="flex-1 hover:no-underline">
                          <div className="flex items-center gap-2 text-left">
                            <Badge variant="outline">{index + 1}</Badge>
                            <span className="font-medium">{piece.title}</span>
                            {complete ? (
                              <Badge variant="secondary" className="gap-1">
                                <CheckCircle2 className="w-3 h-3" />
                                {piece.questions.length} question
                                {piece.questions.length === 1 ? "" : "s"}
                              </Badge>
                            ) : written ? (
                              <Badge variant="outline">Theory only</Badge>
                            ) : (
                              <Badge variant="outline">Not written</Badge>
                            )}
                            {stale && (
                              <Badge variant="destructive" className="gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                Questions out of date
                              </Badge>
                            )}
                          </div>
                        </AccordionTrigger>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={index === 0 || busy}
                            onClick={() => movePiece(piece, "up")}
                            aria-label={`Move ${piece.title} up`}
                          >
                            <ArrowUp className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={index === pieces.length - 1 || busy}
                            onClick={() => movePiece(piece, "down")}
                            aria-label={`Move ${piece.title} down`}
                          >
                            <ArrowDown className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            disabled={busy}
                            onClick={() => setConfirmDeletePiece(piece)}
                            aria-label={`Delete ${piece.title}`}
                            data-testid={`sg-delete-piece-${piece.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>

                      <AccordionContent className="space-y-4 pt-2">
                        <Input
                          value={draftTitle[piece.id] ?? piece.title}
                          onChange={(e) =>
                            setDraftTitle((prev) => ({ ...prev, [piece.id]: e.target.value }))
                          }
                          aria-label="Piece title"
                        />

                        {/*
                          CheatSheetEditor sets `min-h-[300px]` on its ProseMirror
                          content and adds ~90px of tabs and toolbar above it, so
                          anything shorter than ~400px cannot lay out: its internal
                          flex-1 ScrollArea never forms a bound and the text is
                          clipped mid-line. It draws its own border, so this
                          wrapper adds none.
                        */}
                        {written ? (
                          <div className="h-[28rem]">
                            <CheatSheetEditor
                              content={draftTheory[piece.id] ?? ""}
                              onChange={(html) =>
                                setDraftTheory((prev) => ({ ...prev, [piece.id]: html }))
                              }
                            />
                          </div>
                        ) : (
                          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                            No theory yet. Write it first — the questions are generated from it.
                          </div>
                        )}

                        {/*
                          Generation shape, per piece. Pinned type and
                          difficulty are enforced server-side: a question of the
                          wrong type is discarded rather than kept, so these are
                          controls and not suggestions.
                        */}
                        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3">
                          <div className="space-y-1">
                            <Label htmlFor={`sg-count-${piece.id}`} className="text-xs">
                              How many
                            </Label>
                            <Input
                              id={`sg-count-${piece.id}`}
                              type="number"
                              min={MIN_QUESTION_COUNT}
                              max={MAX_QUESTION_COUNT}
                              className="h-8 w-20"
                              value={choiceFor(piece.id).count}
                              onChange={(e) =>
                                setChoice(piece.id, {
                                  count: Math.min(
                                    MAX_QUESTION_COUNT,
                                    Math.max(MIN_QUESTION_COUNT, Number(e.target.value) || 1),
                                  ),
                                })
                              }
                              data-testid={`sg-q-count-${piece.id}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Type</Label>
                            <Select
                              value={choiceFor(piece.id).questionType}
                              onValueChange={(v) => setChoice(piece.id, { questionType: v })}
                            >
                              <SelectTrigger
                                className="h-8 w-44"
                                data-testid={`sg-q-type-${piece.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {QUESTION_TYPE_CHOICES.map((c) => (
                                  <SelectItem key={c.value} value={c.value}>
                                    {c.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Difficulty</Label>
                            <Select
                              value={choiceFor(piece.id).difficulty}
                              onValueChange={(v) => setChoice(piece.id, { difficulty: v })}
                            >
                              <SelectTrigger
                                className="h-8 w-32"
                                data-testid={`sg-q-difficulty-${piece.id}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {DIFFICULTY_CHOICES.map((c) => (
                                  <SelectItem key={c.value} value={c.value}>
                                    {c.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => writeTheory(piece)}
                            disabled={busy}
                            data-testid={`sg-write-theory-${piece.id}`}
                          >
                            {busy && busyLabel === "theory" ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <PenLine className="w-4 h-4 mr-2" />
                            )}
                            {written ? "Rewrite theory" : "Write theory"}
                          </Button>

                          <Textarea
                            id={`sg-theory-prompt-${piece.id}`}
                            rows={1}
                            maxLength={2000}
                            className="h-8 min-h-0 flex-1 basis-64 resize-none py-1.5 text-xs"
                            aria-label="Instructions for the AI (optional)"
                            aria-describedby={`sg-theory-prompt-help-${piece.id}`}
                            title={`Optional instructions, applied the next time you ${
                              written ? "rewrite" : "write"
                            } the theory with AI.`}
                            placeholder={
                              written
                                ? "e.g., Use simpler language, add a worked example, shorten it…"
                                : "e.g., Use simpler language, open with a real-world example…"
                            }
                            value={theoryPrompt[piece.id] ?? ""}
                            onChange={(e) =>
                              setTheoryPrompt((prev) => ({
                                ...prev,
                                [piece.id]: e.target.value,
                              }))
                            }
                            data-testid={`sg-theory-prompt-${piece.id}`}
                          />
                          {/*
                            The sighted get the same sentence via `title`; this
                            copy exists because a tooltip is unreachable from
                            keyboard, touch, and screen readers.
                          */}
                          <span id={`sg-theory-prompt-help-${piece.id}`} className="sr-only">
                            Optional instructions, applied the next time you{" "}
                            {written ? "rewrite" : "write"} the theory with AI.
                          </span>

                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => generateQuestions(piece)}
                            disabled={busy || !written}
                            title={written ? undefined : "Write the theory first"}
                            data-testid={`sg-generate-questions-${piece.id}`}
                          >
                            {busy && busyLabel === "questions" ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : piece.questions.length > 0 ? (
                              <RefreshCw className="w-4 h-4 mr-2" />
                            ) : (
                              <Sparkles className="w-4 h-4 mr-2" />
                            )}
                            {piece.questions.length > 0
                              ? "Regenerate questions"
                              : "Generate questions"}
                          </Button>

                          <Button size="sm" onClick={() => savePiece(piece)} disabled={busy}>
                            {busy && busyLabel === "save" && (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            )}
                            Save piece
                          </Button>
                        </div>

                        {stale && (
                          <p className="text-xs text-destructive">
                            The theory changed after these questions were written, so they may test
                            text the student no longer reads. Regenerate them.
                          </p>
                        )}

                        <div className="space-y-1">
                          <p className="text-sm font-medium">Questions</p>
                          {piece.questions.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              None yet.
                            </p>
                          ) : (
                            piece.questions.map((q) => (
                              <div
                                key={q.id}
                                className="flex items-start gap-2 rounded border px-2 py-1.5 text-sm"
                              >
                                <TypeBadge type={q.type} />
                                {/*
                                  Question stems carry markup — the model emits
                                  <em>, and MathML/LaTeX is rendered here too —
                                  so they go through the same formatter the
                                  Question Bank uses rather than being printed
                                  as text, which showed raw tags to the
                                  instructor. formatQuestionText sanitizes.
                                */}
                                <span
                                  className="flex-1"
                                  dangerouslySetInnerHTML={{
                                    __html: formatQuestionText(q.question),
                                  }}
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => setEditingQuestion(q)}
                                  aria-label={`Edit question: ${plainText(q.question).slice(0, 40)}`}
                                >
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive"
                                  onClick={() => setConfirmDeleteQuestion(q)}
                                  aria-label={`Remove question: ${plainText(q.question).slice(0, 40)}`}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </ScrollableDialogBody>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!confirmDeletePiece}
        onOpenChange={(next) => !next && setConfirmDeletePiece(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this piece?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{confirmDeletePiece?.title}&rdquo; and its{" "}
              {confirmDeletePiece?.questions.length ?? 0} question
              {(confirmDeletePiece?.questions.length ?? 0) === 1 ? "" : "s"} are removed, and the
              pieces after it move up. If a student has already answered it, the deletion is
              refused so their submissions are not destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeletePiece && deletePiece(confirmDeletePiece)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!confirmDeleteQuestion}
        onOpenChange={(next) => !next && setConfirmDeleteQuestion(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this question?</AlertDialogTitle>
            <AlertDialogDescription>
              It is deleted from the guide and from the course. If a student has already answered
              it, the removal is refused so their submission is not destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteQuestion && deleteQuestion(confirmDeleteQuestion)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <QuestionEditorDialog
        questionId={editingQuestion?.id ?? null}
        open={!!editingQuestion}
        onOpenChange={(next) => !next && setEditingQuestion(null)}
        onSaved={async () => {
          setEditingQuestion(null);
          await load();
          onChanged?.();
        }}
      />
    </>
  );
}

export default StudyGuidePieceEditor;
