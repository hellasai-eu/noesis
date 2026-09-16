/**
 * Two-step generate dialog for the unified Question Bank (#621).
 *
 * Step 1 — instructor picks a question type via a radio group.
 * Step 2 — type-specific form:
 *   - MCQ delegates to the existing standalone `GenerateMcqDialog`
 *     (already separated; no duplication possible).
 *   - The other 4 types share `UnifiedGenerateForm`, a single form that
 *     dispatches to the right edge function based on `type`. The form
 *     covers the common fields documented in the issue (chapters /
 *     competencies / difficulty / count / special instructions / start as
 *     draft / target audience).
 *
 * Per-type page-limit / size warnings present in some of the original
 * inlined dialogs are deferred — the edge functions still enforce their
 * own limits server-side.
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { GenerateMcqDialog } from "./GenerateMcqDialog";
import {
  TargetAudienceSelector,
  type AudienceSelection,
  type GroupOption,
} from "./TargetAudienceSelector";
import { TypeBadge } from "./UnifiedQuestionsTable";
import {
  ALL_QUESTION_TYPES,
  QUESTION_TYPE_DESCRIPTIONS,
  QUESTION_TYPE_LABELS,
} from "@/lib/unified-question";
import {
  insertGeneratedQuestions,
  type GeneratedRow,
} from "@/lib/insert-generated-questions";
import type { CourseClass, OfferingGroup } from "@/types/content-assignments";
import type { QuestionType } from "@/types/question";
import {
  fetchWholeDocumentMaterials,
  type WholeDocumentMaterial,
} from "@/lib/whole-document-materials";

interface CourseMaterial {
  id: string;
  file_name: string;
  title: string | null;
}

interface UnifiedGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  classes?: CourseClass[];
  materials: CourseMaterial[];
  groupsByOffering?: Record<string, OfferingGroup[]>;
  onGenerated?: () => void;
  /** Pre-selected target audience (e.g. launched from a group's row). */
  initialAudience?: AudienceSelection;
}

interface ChapterRow {
  id: string;
  title: string;
  material_id: string;
  material_title: string;
}

interface CompetencyRow {
  id: string;
  title: string;
  chapter_id: string | null;
}

const EDGE_FUNCTION_BY_TYPE: Record<
  Exclude<QuestionType, "mcq">,
  string
> = {
  open: "generate-open-questions",
  fill_gaps: "generate-fill-gaps-questions",
  ordering: "generate-ordering-questions",
  classification: "generate-classification-questions",
};

export function UnifiedGenerateDialog({
  open,
  onOpenChange,
  courseId,
  classes = [],
  materials,
  groupsByOffering = {},
  onGenerated,
  initialAudience,
}: UnifiedGenerateDialogProps) {
  const [step, setStep] = useState<"pick" | "form">("pick");
  const [selectedType, setSelectedType] = useState<QuestionType>("mcq");

  // Reset to step 1 every time the dialog opens fresh.
  useEffect(() => {
    if (open) {
      setStep("pick");
      setSelectedType("mcq");
    }
  }, [open]);

  const handleContinue = () => {
    setStep("form");
  };

  // For MCQ we hand off entirely to the existing standalone dialog so the
  // user gets the full original UX (chapter page-limit warnings, etc).
  const showMcqDialog = open && step === "form" && selectedType === "mcq";

  // The pick-step dialog is closed while the MCQ dialog is open so they
  // don't visually stack.
  const showPickDialog = open && step === "pick";
  const showFormDialog = open && step === "form" && selectedType !== "mcq";

  return (
    <>
      <Dialog
        open={showPickDialog}
        onOpenChange={(next) => {
          if (!next) onOpenChange(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-5 h-5" />
              Generate Questions
            </DialogTitle>
            <DialogDescription>
              Choose the type of question you'd like to generate. You can
              still tune count, difficulty, and source after this step.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            value={selectedType}
            onValueChange={(v) => setSelectedType(v as QuestionType)}
            className="space-y-2"
          >
            {ALL_QUESTION_TYPES.map((t) => (
              <label
                key={t}
                className="flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-muted/30"
              >
                <RadioGroupItem value={t} className="mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <TypeBadge type={t} />
                    <span className="font-medium text-sm">
                      {QUESTION_TYPE_LABELS[t]}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {QUESTION_TYPE_DESCRIPTIONS[t]}
                  </p>
                </div>
              </label>
            ))}
          </RadioGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleContinue}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showMcqDialog && (
        <GenerateMcqDialog
          open
          onOpenChange={(next) => {
            if (!next) onOpenChange(false);
          }}
          courseId={courseId}
          classes={classes}
          groupsByOffering={groupsByOffering}
          seed={initialAudience ? { audience: initialAudience } : undefined}
          onGenerated={() => {
            onGenerated?.();
            onOpenChange(false);
          }}
        />
      )}

      {/* `showFormDialog` already carries `selectedType !== "mcq"`, and the
          compiler narrows through it, so repeating the check here compares two
          types that can never overlap. */}
      {showFormDialog && (
        <UnifiedGenerateForm
          open
          onOpenChange={(next) => {
            if (!next) onOpenChange(false);
          }}
          type={selectedType}
          courseId={courseId}
          classes={classes}
          groupsByOffering={groupsByOffering}
          initialAudience={initialAudience}
          onGenerated={() => {
            onGenerated?.();
            onOpenChange(false);
          }}
          onBack={() => setStep("pick")}
        />
      )}
    </>
  );
}

interface UnifiedGenerateFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: Exclude<QuestionType, "mcq">;
  courseId: string;
  classes: CourseClass[];
  groupsByOffering: Record<string, OfferingGroup[]>;
  initialAudience?: AudienceSelection;
  onGenerated?: () => void;
  onBack: () => void;
}

function UnifiedGenerateForm({
  open,
  onOpenChange,
  type,
  courseId,
  classes,
  groupsByOffering,
  initialAudience,
  onGenerated,
  onBack,
}: UnifiedGenerateFormProps) {
  const [selectionMode, setSelectionMode] = useState<"chapters" | "competencies">("chapters");
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  // "Other" materials (#1019) are never split, so they are selected as whole
  // documents rather than through the chapter list.
  const [wholeDocs, setWholeDocs] = useState<WholeDocumentMaterial[]>([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [competencies, setCompetencies] = useState<CompetencyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [selectedCompetencyIds, setSelectedCompetencyIds] = useState<string[]>([]);
  const [numQuestions, setNumQuestions] = useState("3");
  const [difficulty, setDifficulty] = useState<string>("mixed");
  const [startHidden, setStartHidden] = useState(false);
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [audience, setAudience] = useState<AudienceSelection>(
    initialAudience ?? { kind: "none" },
  );
  // #627 — 3-mode dropdown threads `diagramMode` to the generation edge
  // function. Default "off" keeps existing batches byte-for-byte unchanged.
  const [diagramMode, setDiagramMode] = useState<"off" | "auto" | "force">("off");
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      try {
        const [{ data: chs }, { data: comps }, docs] = await Promise.all([
          supabase
            .from("material_chapters")
            .select(
              "id, title, material_id, course_materials!inner(course_id, title, file_name)",
            )
            .eq("course_materials.course_id", courseId)
            // "Other" materials are never split, so they have no chapters to
            // list here — they are offered separately as whole documents (#1019).
            .neq("course_materials.material_type", "other")
            .order("chapter_number", { ascending: true }).order("id"),
          supabase
            .from("course_competencies")
            .select("id, title, chapter_id")
            .eq("course_id", courseId)
            .order("title"),
          fetchWholeDocumentMaterials(courseId),
        ]);

        setChapters(
          (chs ?? []).map((row) => {
            const r = row as unknown as {
              id: string;
              title: string;
              material_id: string;
              course_materials: { title: string | null; file_name: string | null } | null;
            };
            return {
              id: r.id,
              title: r.title,
              material_id: r.material_id,
              material_title:
                r.course_materials?.title || r.course_materials?.file_name || "Unknown",
            };
          }),
        );
        setCompetencies(
          (comps ?? []).map((row) => row as CompetencyRow),
        );
        setWholeDocs(docs);
      } catch (err) {
        console.error("Failed to load chapters/competencies", err);
        toast.error("Failed to load chapters");
      } finally {
        setLoading(false);
      }
    })();
  }, [open, courseId]);

  const groupOptions: GroupOption[] = useMemo(() => {
    const out: GroupOption[] = [];
    for (const offeringId of Object.keys(groupsByOffering)) {
      for (const g of groupsByOffering[offeringId] || []) {
        out.push({
          offering_id: offeringId,
          group_id: g.id,
          label: g.name ?? "Group",
          description: g.description ?? null,
        });
      }
    }
    return out;
  }, [groupsByOffering]);

  const toggleChapter = (id: string) => {
    setSelectedChapterIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleWholeDoc = (id: string) => {
    setSelectedMaterialIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleCompetency = (id: string) => {
    setSelectedCompetencyIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSubmit = useCallback(async () => {
    if (
      selectionMode === "chapters" &&
      selectedChapterIds.length === 0 &&
      selectedMaterialIds.length === 0
    ) {
      toast.error("Please select at least one chapter or document");
      return;
    }
    if (selectionMode === "competencies" && selectedCompetencyIds.length === 0) {
      toast.error("Please select at least one competency");
      return;
    }
    setGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const fnName = EDGE_FUNCTION_BY_TYPE[type];
      const payload = {
        courseId,
        numQuestions: parseInt(numQuestions, 10),
        difficulty,
        chapterIds: selectionMode === "chapters" ? selectedChapterIds : undefined,
        materialIds: selectionMode === "chapters" ? selectedMaterialIds : undefined,
        competencyIds:
          selectionMode === "competencies" ? selectedCompetencyIds : undefined,
        startHidden,
        specialInstructions: specialInstructions.trim() || undefined,
        group_id: audience.kind === "group" ? audience.groupId : undefined,
        student_user_id:
          audience.kind === "student" ? audience.studentUserId : undefined,
        diagramMode,
      };
      const { data, error } = await supabase.functions.invoke(fnName, {
        body: payload,
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const generated: GeneratedRow[] | undefined = data?.questions;
      if (!generated || generated.length === 0) {
        throw new Error("No questions were generated");
      }
      if (data?.warning) toast.warning(data.warning);

      // The edge functions only generate + return rows — they do not
      // persist. We must insert into `questions` here (and write the
      // chapter / competency junctions + optional auto-assignment),
      // otherwise the success toast lies and the bank stays empty (#630).
      const { insertedCount, autoAssignedLabel, warning } =
        await insertGeneratedQuestions({
          type,
          courseId,
          generated,
          target: data?.target ?? null,
          audience,
        });

      if (warning) toast.warning(warning);

      const suffix = autoAssignedLabel ? ` · assigned to ${autoAssignedLabel}` : "";
      toast.success(
        `Generated ${insertedCount} ${QUESTION_TYPE_LABELS[type]} question${
          insertedCount === 1 ? "" : "s"
        }${suffix}`,
      );
      onGenerated?.();
    } catch (err) {
      console.error("Generation failed", err);
      const msg = err instanceof Error ? err.message : "Generation failed";
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }, [
    type,
    courseId,
    selectionMode,
    selectedChapterIds,
    selectedMaterialIds,
    selectedCompetencyIds,
    numQuestions,
    difficulty,
    startHidden,
    specialInstructions,
    audience,
    diagramMode,
    onGenerated,
  ]);

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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!generating) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            Generate {QUESTION_TYPE_LABELS[type]} questions
          </DialogTitle>
          <DialogDescription>
            {QUESTION_TYPE_DESCRIPTIONS[type]}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup
            value={selectionMode}
            onValueChange={(v) =>
              setSelectionMode(v as "chapters" | "competencies")
            }
            className="grid grid-cols-2 gap-2"
          >
            <label className="flex items-center gap-2 p-2 rounded-md border cursor-pointer">
              <RadioGroupItem value="chapters" />
              <span className="text-sm">From chapters</span>
            </label>
            <label className="flex items-center gap-2 p-2 rounded-md border cursor-pointer">
              <RadioGroupItem value="competencies" />
              <span className="text-sm">From competencies</span>
            </label>
          </RadioGroup>

          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectionMode === "chapters" ? (
            <ScrollArea className="h-48 rounded-md border p-2">
              {Object.keys(groupedChapters).length === 0 && wholeDocs.length === 0 ? (
                <p className="text-sm text-muted-foreground p-2">
                  No chapters available. Upload a course material first.
                </p>
              ) : (
                <>
                  {Object.entries(groupedChapters).map(([mid, group]) => (
                    <div key={mid} className="mb-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                        {group.title}
                      </p>
                      {group.chapters.map((ch) => (
                        <label
                          key={ch.id}
                          className="flex items-start gap-2 py-1 cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedChapterIds.includes(ch.id)}
                            onCheckedChange={() => toggleChapter(ch.id)}
                          />
                          <span className="text-sm">{ch.title}</span>
                        </label>
                      ))}
                    </div>
                  ))}

                  {/* "Other" materials have no chapters, so each one is a
                      single choice: the whole document (#1019). */}
                  {wholeDocs.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                        Other documents
                      </p>
                      {wholeDocs.map((doc) => (
                        <label
                          key={doc.id}
                          className="flex items-start gap-2 py-1 cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedMaterialIds.includes(doc.id)}
                            onCheckedChange={() => toggleWholeDoc(doc.id)}
                          />
                          <span className="text-sm">{doc.title}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </ScrollArea>
          ) : (
            <ScrollArea className="h-48 rounded-md border p-2">
              {competencies.length === 0 ? (
                <p className="text-sm text-muted-foreground p-2">
                  No competencies defined yet.
                </p>
              ) : (
                competencies.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-start gap-2 py-1 cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedCompetencyIds.includes(c.id)}
                      onCheckedChange={() => toggleCompetency(c.id)}
                    />
                    <span className="text-sm">{c.title}</span>
                  </label>
                ))
              )}
            </ScrollArea>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Number of questions</Label>
              <Select value={numQuestions} onValueChange={setNumQuestions}>
                <SelectTrigger>
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
                <SelectTrigger>
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
            <Label htmlFor="unified-diagram-mode">Diagrams</Label>
            <Select
              value={diagramMode}
              onValueChange={(v) => setDiagramMode(v as "off" | "auto" | "force")}
            >
              <SelectTrigger id="unified-diagram-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off — no diagrams</SelectItem>
                <SelectItem value="auto">Auto — when helpful</SelectItem>
                <SelectItem value="force">Force on every question</SelectItem>
              </SelectContent>
            </Select>
            {diagramMode === "force" && (
              <p className="text-xs text-muted-foreground mt-1">
                Useful for testing diagram rendering and storage. Quality on non-visual questions may be lower.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="special-instructions">Special instructions (optional)</Label>
            <Textarea
              id="special-instructions"
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder="e.g. Focus on application-level questions only."
              rows={3}
            />
          </div>

          {classes.length > 0 && (
            <TargetAudienceSelector
              id="unified-generate-audience"
              classes={classes}
              groupOptions={groupOptions}
              value={audience}
              onChange={setAudience}
              enabled={open}
            />
          )}

          <div className="mt-4">
            <Separator />
            <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                After generation
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={startHidden}
                  onCheckedChange={(v) => setStartHidden(v === true)}
                />
                <span className="text-sm">Start as draft (hidden from students)</span>
              </label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onBack} disabled={generating}>
            Back
          </Button>
          <Button onClick={handleSubmit} disabled={generating || loading}>
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
