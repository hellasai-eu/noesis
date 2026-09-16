/**
 * Create a study guide and kick off generation (#979).
 *
 * The instructor picks an existing chaptered material, ticks which chapters
 * feed the guide, describes what they want, and sets the shape (how many
 * pieces, how many questions each). Submitting writes the `study_guides` row
 * plus its `study_guide_source_chapters`, then asks for the OUTLINE — piece
 * titles and scope only.
 *
 * Submitting runs the whole pipeline in one sitting: outline first, then for
 * each piece its theory and its questions (multiple-choice only), sequentially,
 * with progress shown on the submit button. The per-piece stages of #1004 are
 * still the editing surface — a piece whose stage failed here, or whose content
 * the instructor dislikes, is rewritten from the piece editor — but the happy
 * path no longer requires clicking through every piece by hand. Everything runs
 * in THIS dialog, foreground, so nothing fails silently; a piece that fails is
 * named in the closing toast and finished from the editor.
 *
 * Upload is deliberately NOT embedded: the existing Course Materials flow
 * already handles upload, chapter detection and PDF splitting, and duplicating
 * it here would mean a second copy of a 495-line dialog.
 *
 * Two kinds of source are accepted (#1019):
 *  - a TEXTBOOK, picked chapter by chapter. Generation attaches chapter-level
 *    PDF slices (`material_chapters.openai_file_id`), so a textbook that has
 *    not been split cannot be selected.
 *  - an "OTHER" material — a standalone PDF uploaded specifically for this, and
 *    usable for nothing else in the app. It is never chaptered, so the WHOLE
 *    document is attached via `course_materials.openai_file_id`. Recording no
 *    `study_guide_source_chapters` rows is exactly how the schema spells
 *    "whole material".
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_DOCUMENT_MATERIAL_TYPE } from "@/components/MaterialUploadDialog";

/** Mirrors the CHECK constraints on `study_guides` (#977 migration). */
export const MIN_PIECES = 1;
export const MAX_PIECES = 20;
export const MIN_QUESTIONS_PER_PIECE = 1;
export const MAX_QUESTIONS_PER_PIECE = 20;
export const DEFAULT_PIECES = 5;
export const DEFAULT_QUESTIONS_PER_PIECE = 5;

export interface CreateStudyGuideMaterial {
  id: string;
  title: string | null;
  file_name: string;
  material_type: string | null;
  /** Required for an "Other" material — it is the only file the model gets. */
  openai_file_id?: string | null;
}

interface Chapter {
  id: string;
  chapter_number: number;
  title: string;
  openai_file_id: string | null;
}

interface CreateStudyGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  materials: CreateStudyGuideMaterial[];
  onCreated?: (studyGuideId: string) => void;
}

function materialLabel(m: CreateStudyGuideMaterial): string {
  return m.title?.trim() || m.file_name;
}

/**
 * What the outline function returns per piece. `scope` is model output the
 * server deliberately does not store — it exists precisely so this dialog can
 * hand it straight back to the theory writer while it still has it.
 */
interface OutlinePiece {
  id: string;
  title?: string | null;
  scope?: string | null;
}

/**
 * Surfaces the edge function's own error body. `supabase.functions.invoke`
 * stashes the raw Response on `error.context` for non-2xx, and the enqueue
 * function returns meaningful 409s (already running / has submissions) that
 * are far more useful than "Edge Function returned a non-2xx status code".
 */
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

export function CreateStudyGuideDialog({
  open,
  onOpenChange,
  courseId,
  materials,
  onCreated,
}: CreateStudyGuideDialogProps) {
  const [materialId, setMaterialId] = useState<string>("");
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [pieceCount, setPieceCount] = useState(DEFAULT_PIECES);
  const [questionsPerPiece, setQuestionsPerPiece] = useState(DEFAULT_QUESTIONS_PER_PIECE);
  const [submitting, setSubmitting] = useState(false);
  // Human-readable stage label while the pipeline runs, shown on the submit
  // button. Null while idle; "Building outline…" before per-piece work starts.
  const [progress, setProgress] = useState<string | null>(null);

  // Textbooks contribute chapter PDF slices; "Other" materials contribute the
  // whole document. Nothing else can be a study guide source, and an "Other"
  // material without an OpenAI file has nothing to attach at all.
  const candidates = useMemo(
    () =>
      materials.filter((m) =>
        m.material_type === WHOLE_DOCUMENT_MATERIAL_TYPE
          ? !!m.openai_file_id
          : m.material_type === "textbook",
      ),
    [materials],
  );

  useEffect(() => {
    if (!open) return;
    setMaterialId("");
    setChapters([]);
    setSelectedChapterIds(new Set());
    setTitle("");
    setBrief("");
    setPieceCount(DEFAULT_PIECES);
    setQuestionsPerPiece(DEFAULT_QUESTIONS_PER_PIECE);
  }, [open]);

  const selectedMaterial = candidates.find((m) => m.id === materialId) ?? null;
  /** "Other" materials are never chaptered — the whole PDF is the source. */
  const wholeDocument =
    selectedMaterial?.material_type === WHOLE_DOCUMENT_MATERIAL_TYPE;

  useEffect(() => {
    if (!materialId || wholeDocument) {
      setChapters([]);
      setSelectedChapterIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingChapters(true);
      try {
        const { data, error } = await supabase
          .from("material_chapters")
          .select("id, chapter_number, title, openai_file_id")
          .eq("material_id", materialId)
          .order("chapter_number", { ascending: true }).order("id");
        if (error) throw error;
        if (cancelled) return;
        const rows = (data ?? []) as Chapter[];
        setChapters(rows);
        // Start with nothing selected. Defaulting to every chapter meant the
        // common case — a guide over part of a book — required unpicking a list
        // the instructor had not chosen, and the quiet path was to accept it,
        // sending the whole material to the model. Choosing is now explicit;
        // `canSubmit` already refuses an empty selection, so the button stays
        // disabled until one is made rather than building the wrong outline.
        setSelectedChapterIds(new Set());
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load chapters", err);
          toast.error("Could not load this material's chapters");
        }
      } finally {
        if (!cancelled) setLoadingChapters(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [materialId, wholeDocument]);

  const allSelected = chapters.length > 0 && selectedChapterIds.size === chapters.length;
  // A chapter without a split PDF cannot be sent to the model at all.
  const usableChapters = chapters.filter((c) => !!c.openai_file_id);
  const selectedUsableCount = chapters.filter(
    (c) => selectedChapterIds.has(c.id) && !!c.openai_file_id,
  ).length;

  function toggleChapter(id: string) {
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedChapterIds(allSelected ? new Set() : new Set(chapters.map((c) => c.id)));
  }

  const canSubmit =
    !!materialId &&
    title.trim().length > 0 &&
    (wholeDocument || selectedUsableCount > 0) &&
    pieceCount >= MIN_PIECES &&
    pieceCount <= MAX_PIECES &&
    questionsPerPiece >= MIN_QUESTIONS_PER_PIECE &&
    questionsPerPiece <= MAX_QUESTIONS_PER_PIECE &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    let createdGuideId: string | null = null;
    // Once the outline request has left, its outcome is unknowable from here: a
    // lost or unreadable response does not mean the pieces were not written.
    // Deleting the guide then would discard content that exists, so cleanup is
    // gated on the failure having happened BEFORE the call went out.
    let enqueueAttempted = false;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id ?? null;

      const { data: guide, error: guideError } = await supabase
        .from("study_guides")
        .insert({
          course_id: courseId,
          material_id: materialId,
          title: title.trim(),
          brief: brief.trim() || null,
          target_piece_count: pieceCount,
          target_questions_per_piece: questionsPerPiece,
          created_by: userId,
        })
        .select("id")
        .single();
      if (guideError || !guide) throw guideError ?? new Error("Could not create the study guide");
      createdGuideId = guide.id;

      // Only chapters with a split PDF: the rest cannot be sent to the model,
      // and recording them would make the source look broader than it is.
      //
      // For an "Other" material there are no chapters at all — leaving the
      // table empty is how the schema records "the whole material", and the
      // generation functions fall back to `course_materials.openai_file_id`.
      if (!wholeDocument) {
        const sourceRows = chapters
          .filter((c) => selectedChapterIds.has(c.id) && !!c.openai_file_id)
          .map((c) => ({ study_guide_id: guide.id, chapter_id: c.id }));
        const { error: chapterError } = await supabase
          .from("study_guide_source_chapters")
          .insert(sourceRows);
        if (chapterError) throw chapterError;
      }

      enqueueAttempted = true;
      setProgress("Building outline…");
      const { data, error } = await supabase.functions.invoke(
        "generate-study-guide-outline",
        { body: { studyGuideId: guide.id } },
      );
      if (error) throw new Error(await readInvokeError(error, "Could not build the outline"));
      if (data?.error) throw new Error(data.error);

      const pieces: OutlinePiece[] = Array.isArray(data?.pieces) ? data.pieces : [];

      // Theory then questions, piece by piece. Sequential on purpose: questions
      // are grounded in the stored theory, so within a piece the order is
      // mandatory, and running pieces in parallel would trip the per-user rate
      // limit the generation functions enforce. A failed stage is recorded and
      // the loop moves on — the piece editor rewrites any piece individually,
      // so a partial guide is recoverable, while aborting here would waste the
      // pieces already written. Failures must not reach the outer catch: its
      // toast would report the whole creation as failed.
      const failedPieces: string[] = [];
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        const label = piece.title?.trim() || `Piece ${i + 1}`;
        setProgress(`Writing theory ${i + 1}/${pieces.length}…`);
        const theoryScope = piece.scope?.trim();
        const { data: theoryData, error: theoryError } = await supabase.functions.invoke(
          "generate-study-guide-theory",
          {
            body: {
              pieceId: piece.id,
              ...(theoryScope ? { scope: theoryScope } : {}),
            },
          },
        );
        if (theoryError || theoryData?.error) {
          console.error(`Failed to write theory for "${label}"`, theoryError ?? theoryData?.error);
          // Without theory the questions call is a guaranteed 409 — skip it.
          failedPieces.push(label);
          continue;
        }

        setProgress(`Generating questions ${i + 1}/${pieces.length}…`);
        const { data: questionData, error: questionError } = await supabase.functions.invoke(
          "generate-study-guide-questions",
          {
            body: {
              pieceId: piece.id,
              count: questionsPerPiece,
              questionType: "mcq",
              difficulty: "mixed",
            },
          },
        );
        // A 2xx response is not a full batch: questions the model returned
        // malformed (or off-type) are rejected, not retried, so `inserted` is
        // the authoritative count. Zero is a failure; a short batch is real
        // content but still needs the instructor's attention.
        const inserted =
          typeof questionData?.inserted === "number" ? questionData.inserted : 0;
        if (questionError || questionData?.error || inserted === 0) {
          console.error(
            `Failed to generate questions for "${label}"`,
            questionError ?? questionData?.error,
          );
          failedPieces.push(label);
        } else if (inserted < questionsPerPiece) {
          failedPieces.push(`${label} (only ${inserted}/${questionsPerPiece} questions)`);
        }
      }

      if (failedPieces.length === 0) {
        toast.success(
          `Study guide ready — ${pieces.length} piece${pieces.length === 1 ? "" : "s"} with theory and questions.`,
        );
      } else {
        toast.warning(
          `Study guide created, but ${failedPieces.length} piece${
            failedPieces.length === 1 ? "" : "s"
          } need${failedPieces.length === 1 ? "s" : ""} attention: ${failedPieces.join(", ")}. Open the guide to finish ${failedPieces.length === 1 ? "it" : "them"}.`,
        );
      }
      onCreated?.(guide.id);
      onOpenChange(false);
    } catch (err) {
      // Clean up only when the failure happened BEFORE the outline call went
      // out — there is definitively no content in that case. After it, the
      // guide is left in place: it shows in the list as a draft with no pieces
      // and a working "Build outline" action. A recoverable stray draft beats
      // deleting pieces that may have been written.
      if (createdGuideId && !enqueueAttempted) {
        await supabase.from("study_guides").delete().eq("id", createdGuideId);
      }
      console.error("Failed to create study guide", err);
      toast.error((err as Error).message || "Could not create the study guide");
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>New study guide</DialogTitle>
          <DialogDescription>
            A model reads the material you choose, proposes a sequence of pieces, then writes the
            theory and multiple-choice questions for each — all in one go. This can take several
            minutes; keep this dialog open until it finishes. You can edit every piece afterwards.
          </DialogDescription>
        </DialogHeader>

        <ScrollableDialogBody className="space-y-4 pr-1">
          <div className="space-y-2">
            <Label htmlFor="sg-material">Material</Label>
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No usable materials yet. From Course Materials, either upload a textbook and split
                it into chapters, or upload a PDF as an <strong>Other</strong> material — that type
                exists for study guides and is read whole, no chapters needed.
              </p>
            ) : (
              <Select value={materialId} onValueChange={setMaterialId}>
                <SelectTrigger id="sg-material" data-testid="sg-material-select">
                  <SelectValue placeholder="Choose a material" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {materialLabel(m)}
                      {m.material_type === WHOLE_DOCUMENT_MATERIAL_TYPE && (
                        <span className="ml-2 text-xs text-muted-foreground">(Other)</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {materialId && wholeDocument && (
            <p className="text-sm text-muted-foreground" data-testid="sg-whole-document-note">
              This is an <strong>Other</strong> material, so the whole document is the source —
              there are no chapters to choose from. Use the brief below to narrow what the guide
              should cover.
            </p>
          )}

          {materialId && !wholeDocument && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Chapters</Label>
                {chapters.length > 0 && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={toggleAll}
                  >
                    {allSelected ? "Clear all" : `Select all (${chapters.length})`}
                  </button>
                )}
              </div>

              {loadingChapters ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading chapters…
                </div>
              ) : chapters.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This material has no chapters. Split it into chapters from Course Materials
                  first — generation works from chapter PDFs.
                </p>
              ) : (
                <>
                  <ScrollArea className="h-48 rounded-md border p-2">
                    <div className="space-y-1">
                      {chapters.map((c) => {
                        const unusable = !c.openai_file_id;
                        return (
                          <label
                            key={c.id}
                            className={`flex items-start gap-2 rounded px-2 py-1 text-sm ${
                              unusable ? "opacity-50" : "hover:bg-muted/50 cursor-pointer"
                            }`}
                          >
                            <Checkbox
                              checked={selectedChapterIds.has(c.id)}
                              onCheckedChange={() => toggleChapter(c.id)}
                              disabled={unusable}
                              data-testid={`sg-chapter-${c.id}`}
                            />
                            <span>
                              {c.chapter_number}. {c.title}
                              {unusable && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  (no split PDF — re-split this material to include it)
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <p className="text-xs text-muted-foreground">
                    {selectedUsableCount} of {usableChapters.length} usable chapters selected
                  </p>
                </>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="sg-title">Title</Label>
            <Input
              id="sg-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={selectedMaterial ? `Study guide: ${materialLabel(selectedMaterial)}` : "Study guide title"}
              data-testid="sg-title"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sg-brief">What should this guide cover?</Label>
            <Textarea
              id="sg-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              placeholder="e.g. Focus on the second law and entropy. My students struggle with sign conventions — build up to them slowly and test them hard."
              data-testid="sg-brief"
            />
            <p className="text-xs text-muted-foreground">
              This is the model's main guide to emphasis and depth. The more specific, the better.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sg-pieces">Pieces</Label>
              <Input
                id="sg-pieces"
                type="number"
                min={MIN_PIECES}
                max={MAX_PIECES}
                value={pieceCount}
                onChange={(e) => setPieceCount(Number(e.target.value))}
                data-testid="sg-piece-count"
              />
              <p className="text-xs text-muted-foreground">
                A target, not a rule — the model may differ if the material demands it.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sg-questions">Questions per piece</Label>
              <Input
                id="sg-questions"
                type="number"
                min={MIN_QUESTIONS_PER_PIECE}
                max={MAX_QUESTIONS_PER_PIECE}
                value={questionsPerPiece}
                onChange={(e) => setQuestionsPerPiece(Number(e.target.value))}
                data-testid="sg-question-count"
              />
              <p className="text-xs text-muted-foreground">
                Multiple-choice. Other question types can be generated per piece afterwards.
              </p>
            </div>
          </div>
        </ScrollableDialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit} data-testid="sg-create-submit">
            {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {submitting ? progress ?? "Creating…" : "Create & generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default CreateStudyGuideDialog;
