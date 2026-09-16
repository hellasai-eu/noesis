/**
 * Bulk Generate config dialog (issue #698).
 *
 * Course managers configure a run — types, count per type per chapter,
 * difficulty, chapter scope — and click Start. The dialog POSTs to the
 * `enqueue-bulk-generation` edge function which validates, blocks
 * concurrent runs, inserts a `jobs` row, and triggers the runner. The
 * actual generation is done by the existing handler (#697); progress UI
 * is out of scope (#699).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { TypeBadge } from "./UnifiedQuestionsTable";
import {
  ALL_QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
} from "@/lib/unified-question";
import type { QuestionType } from "@/types/question";

/** Mirrors the edge function's MAX_ITEMS_PER_JOB so the UI fails fast. */
export const MAX_ITEMS_PER_JOB = 300;

/** Default `countPerType` — matches the single-type dialog's default. */
const DEFAULT_COUNT = 3;

/** Default types selected on first open. */
const DEFAULT_SELECTED_TYPES: QuestionType[] = ["mcq", "open"];

interface ChapterRow {
  id: string;
  title: string;
  material_id: string;
  material_title: string;
}

interface BulkGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  onEnqueued?: (jobId: string) => void;
}

export function BulkGenerateDialog({
  open,
  onOpenChange,
  courseId,
  onEnqueued,
}: BulkGenerateDialogProps) {
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<QuestionType>>(
    () => new Set(DEFAULT_SELECTED_TYPES),
  );
  const [selectedChapterIds, setSelectedChapterIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [allChapters, setAllChapters] = useState(true);
  const [countPerType, setCountPerType] = useState(String(DEFAULT_COUNT));
  const [difficulty, setDifficulty] = useState<string>("mixed");
  const [diagramMode, setDiagramMode] = useState<"off" | "auto">("off");
  const [startHidden, setStartHidden] = useState(false);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset state every time the dialog reopens fresh.
  useEffect(() => {
    if (!open) return;
    setSelectedTypes(new Set(DEFAULT_SELECTED_TYPES));
    setSelectedChapterIds(new Set());
    setAllChapters(true);
    setCountPerType(String(DEFAULT_COUNT));
    setDifficulty("mixed");
    setDiagramMode("off");
    setStartHidden(false);
    setSpecialInstructions("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoadingChapters(true);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("material_chapters")
          .select(
            "id, title, material_id, course_materials!inner(course_id, title, file_name)",
          )
          .eq("course_materials.course_id", courseId)
          // "Other" materials are never split, so they have no chapters to
          // list here (#1019).
          .neq("course_materials.material_type", "other")
          .order("chapter_number", { ascending: true }).order("id");
        if (error) throw error;
        const rows: ChapterRow[] = (data ?? []).map((row) => {
          const r = row as unknown as {
            id: string;
            title: string;
            material_id: string;
            course_materials:
              | { title: string | null; file_name: string | null }
              | null;
          };
          return {
            id: r.id,
            title: r.title,
            material_id: r.material_id,
            material_title:
              r.course_materials?.title ||
              r.course_materials?.file_name ||
              "Unknown",
          };
        });
        setChapters(rows);
      } catch (err) {
        console.error("Failed to load chapters", err);
        toast.error("Failed to load chapters");
      } finally {
        setLoadingChapters(false);
      }
    })();
  }, [open, courseId]);

  const groupedChapters = useMemo(() => {
    const acc: Record<string, { title: string; chapters: ChapterRow[] }> = {};
    for (const ch of chapters) {
      if (!acc[ch.material_id]) {
        acc[ch.material_id] = { title: ch.material_title, chapters: [] };
      }
      acc[ch.material_id].chapters.push(ch);
    }
    return acc;
  }, [chapters]);

  const effectiveChapterIds = useMemo(() => {
    if (allChapters) return chapters.map((ch) => ch.id);
    return chapters.filter((ch) => selectedChapterIds.has(ch.id)).map((ch) => ch.id);
  }, [allChapters, chapters, selectedChapterIds]);

  const countNum = Math.max(
    1,
    Math.min(5, Number.parseInt(countPerType, 10) || DEFAULT_COUNT),
  );

  const estimate = effectiveChapterIds.length * selectedTypes.size * countNum;
  const itemCount = effectiveChapterIds.length * selectedTypes.size;
  const overCap = itemCount > MAX_ITEMS_PER_JOB;

  const canSubmit =
    !submitting &&
    !loadingChapters &&
    selectedTypes.size > 0 &&
    effectiveChapterIds.length > 0 &&
    !overCap;

  const toggleType = (t: QuestionType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const toggleChapter = (id: string) => {
    setSelectedChapterIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // The bulk handler's parseDiagramMode accepts `off | auto | on`. We
      // expose only off/auto in the UI because the bulk path forwards the
      // value to the per-type generators verbatim, and those still expect
      // `force` for the "on every question" mode — wiring "force" through
      // bulk needs a handler-side translation that isn't part of this PR.
      const payload = {
        courseId,
        types: Array.from(selectedTypes),
        chapterIds: effectiveChapterIds,
        countPerType: countNum,
        difficulty: difficulty === "mixed" ? undefined : difficulty,
        startHidden,
        diagramMode,
        specialInstructions: specialInstructions.trim() || undefined,
      };
      const { data, error } = await supabase.functions.invoke(
        "enqueue-bulk-generation",
        { body: payload },
      );
      if (error) {
        // supabase-js wraps a non-2xx response into FunctionsHttpError and
        // stashes the raw Response on `.context`. Read the JSON body to
        // recover the handler's real message (e.g. the 409 "already running"
        // text) instead of showing the generic "non-2xx status code".
        let message = error.message ?? "Enqueue failed";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (error as any).context;
        if (ctx instanceof Response) {
          try {
            const body = await ctx.clone().json();
            if (body?.error) message = body.error;
          } catch {
            // body wasn't JSON — keep the default message
          }
        }
        throw new Error(message);
      }
      if (data?.error) throw new Error(data.error);
      const jobId = data?.jobId as string | undefined;
      if (!jobId) throw new Error("Enqueue returned no jobId");

      toast.success(
        `Bulk generation started for ${effectiveChapterIds.length} chapter${
          effectiveChapterIds.length === 1 ? "" : "s"
        } × ${selectedTypes.size} type${selectedTypes.size === 1 ? "" : "s"}.`,
      );
      onEnqueued?.(jobId);
      onOpenChange(false);
    } catch (err) {
      console.error("Bulk enqueue failed", err);
      const msg = err instanceof Error ? err.message : "Enqueue failed";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    countNum,
    courseId,
    difficulty,
    diagramMode,
    effectiveChapterIds,
    onEnqueued,
    onOpenChange,
    selectedTypes,
    specialInstructions,
    startHidden,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="w-5 h-5" />
            Bulk Generate Questions
          </DialogTitle>
          <DialogDescription>
            Configure a one-shot bulk generation across multiple chapters and
            question types. The job runs in the background — you can navigate
            away once it starts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-2 block">Question types</Label>
            <div className="flex flex-wrap gap-2" data-testid="bulk-types">
              {ALL_QUESTION_TYPES.map((t) => {
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
                    data-testid={`bulk-type-${t}`}
                  >
                    <Checkbox checked={active} onCheckedChange={() => toggleType(t)} />
                    <TypeBadge type={t} />
                    <span>{QUESTION_TYPE_LABELS[t]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>Chapter scope</Label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <Checkbox
                  checked={allChapters}
                  onCheckedChange={(v) => setAllChapters(v === true)}
                  data-testid="bulk-all-chapters"
                />
                <span>All chapters ({chapters.length})</span>
              </label>
            </div>
            <ScrollArea className="h-48 rounded-md border p-2">
              {loadingChapters ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : Object.keys(groupedChapters).length === 0 ? (
                <p className="text-sm text-muted-foreground p-2">
                  No chapters available. Upload a course material first.
                </p>
              ) : (
                Object.entries(groupedChapters).map(([mid, group]) => (
                  <div key={mid} className="mb-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                      {group.title}
                    </p>
                    {group.chapters.map((ch) => (
                      <label
                        key={ch.id}
                        className={`flex items-start gap-2 py-1 ${
                          allChapters ? "opacity-50" : "cursor-pointer"
                        }`}
                      >
                        <Checkbox
                          checked={
                            allChapters || selectedChapterIds.has(ch.id)
                          }
                          disabled={allChapters}
                          onCheckedChange={() => toggleChapter(ch.id)}
                          data-testid={`bulk-chapter-${ch.id}`}
                        />
                        <span className="text-sm">{ch.title}</span>
                      </label>
                    ))}
                  </div>
                ))
              )}
            </ScrollArea>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Questions per type, per chapter</Label>
              <Select value={countPerType} onValueChange={setCountPerType}>
                <SelectTrigger data-testid="bulk-count-per-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((n) => (
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
                <SelectTrigger data-testid="bulk-difficulty">
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

          <div>
            <Label htmlFor="bulk-diagram-mode">Diagrams</Label>
            <Select
              value={diagramMode}
              onValueChange={(v) => setDiagramMode(v as "off" | "auto")}
            >
              <SelectTrigger id="bulk-diagram-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off — no diagrams</SelectItem>
                <SelectItem value="auto">Auto — when helpful</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="bulk-special-instructions">
              Special instructions (optional)
            </Label>
            <Textarea
              id="bulk-special-instructions"
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder="e.g. Focus on application-level questions only."
              rows={3}
            />
          </div>

          <Separator />

          <div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Estimate
            </p>
            <p
              className="text-sm"
              data-testid="bulk-estimate"
            >
              {effectiveChapterIds.length} chapter
              {effectiveChapterIds.length === 1 ? "" : "s"} × {selectedTypes.size}{" "}
              type{selectedTypes.size === 1 ? "" : "s"} × {countNum} ={" "}
              <strong>{estimate}</strong> question
              {estimate === 1 ? "" : "s"} (over {itemCount} batch
              {itemCount === 1 ? "" : "es"})
            </p>
            {overCap && (
              <p
                className="text-sm text-destructive flex items-start gap-1"
                data-testid="bulk-over-cap"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5" />
                Over the {MAX_ITEMS_PER_JOB}-batch cap. Reduce chapters or
                types.
              </p>
            )}
            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <Checkbox
                checked={startHidden}
                onCheckedChange={(v) => setStartHidden(v === true)}
                data-testid="bulk-start-hidden"
              />
              <span className="text-sm">
                Start generated questions as drafts (hidden from students)
              </span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="bulk-start"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Layers className="w-4 h-4 mr-2" />
                Start bulk generation
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default BulkGenerateDialog;
