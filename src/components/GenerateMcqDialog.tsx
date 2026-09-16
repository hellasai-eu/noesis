import { useEffect, useMemo, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Sparkles,
  Loader2,
  BookOpen,
  BookOpenCheck,
  Target,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { TargetAudienceSelector, type AudienceSelection, type GroupOption } from "./TargetAudienceSelector";
import type { CourseClass, OfferingGroup } from "@/types/content-assignments";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useFormatters } from "@/i18n/formatters";
import {
  fetchWholeDocumentMaterials,
  type WholeDocumentMaterial,
} from "@/lib/whole-document-materials";
import { guideIsCompleteSource } from "@/lib/study-guide";

interface ChapterWithMaterial {
  id: string;
  title: string;
  content_type: string;
  content?: string | null;
  file_name?: string | null;
  material_id: string;
  material_title: string;
  material_type: string;
  material_page_count: number | null;
  material_file_size: number | null;
  chapter_page_count: number;
  chapter_size_bytes: number;
}

export interface GenerateMcqSeed {
  selectionMode?: "chapters" | "competencies" | "guides";
  selectedChapterIds?: string[];
  selectedCompetencyIds?: string[];
  /** Pre-selected completed study guides ("guides" mode — follow-ups). */
  selectedStudyGuideIds?: string[];
  /** Pre-selected difficulty (easy/medium/hard/mixed). */
  difficulty?: string;
  specialInstructions?: string;
  audience?: AudienceSelection;
  /**
   * Optional explanation of the pre-fill shown as an info note at the top of
   * the dialog (e.g. "Seeded from group X — weak in: A, B, C").
   */
  note?: string;
}

interface StudyGuideOption {
  id: string;
  title: string;
  pieceCount: number;
  /** Every piece has theory and questions — the only guides the API accepts. */
  complete: boolean;
}

interface GenerateMcqDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  classes?: CourseClass[];
  groupsByOffering?: Record<string, OfferingGroup[]>;
  onGenerated?: () => void;
  seed?: GenerateMcqSeed;
}

const MAX_PAGES = 400;
const MAX_SIZE_BYTES = 32 * 1024 * 1024;
const MAX_COMPETENCIES = 3;

export function GenerateMcqDialog({
  open,
  onOpenChange,
  courseId,
  classes = [],
  groupsByOffering = {},
  onGenerated,
  seed,
}: GenerateMcqDialogProps) {
  const { compareText } = useFormatters();
  const [generating, setGenerating] = useState(false);
  const [numQuestions, setNumQuestions] = useState("5");
  const [difficulty, setDifficulty] = useState<string>("mixed");
  const [startHidden, setStartHidden] = useState(false);
  const [enableTrueFalse, setEnableTrueFalse] = useState(false);
  // #627 — 3-mode dropdown threads `diagramMode` to the MCQ generation edge
  // function. Default "off" keeps existing batches byte-for-byte unchanged.
  const [diagramMode, setDiagramMode] = useState<"off" | "auto" | "force">("off");
  const [specialInstructions, setSpecialInstructions] = useState("");

  const [selectionMode, setSelectionMode] = useState<"chapters" | "competencies" | "guides">("chapters");

  const [chapters, setChapters] = useState<ChapterWithMaterial[]>([]);
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);

  // "Other" materials (#1019) are never split, so they are selected as whole
  // documents rather than through the chapter tree above.
  const [wholeDocs, setWholeDocs] = useState<WholeDocumentMaterial[]>([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);

  const [competencies, setCompetencies] = useState<{ id: string; title: string; chapter_id: string | null }[]>([]);
  const [selectedCompetencyIds, setSelectedCompetencyIds] = useState<string[]>([]);
  const [loadingCompetencies, setLoadingCompetencies] = useState(false);

  // Completed study guides as sources: generation is grounded in the guide's
  // stored theory and dedups against the questions the guide already asks.
  // Incomplete guides are listed but disabled — the edge function refuses
  // them anyway, and showing why beats hiding them.
  const [studyGuides, setStudyGuides] = useState<StudyGuideOption[]>([]);
  const [selectedStudyGuideIds, setSelectedStudyGuideIds] = useState<string[]>([]);
  const [loadingStudyGuides, setLoadingStudyGuides] = useState(false);

  const [audience, setAudience] = useState<AudienceSelection>({ kind: "none" });

  const fetchChapters = async () => {
    setLoadingChapters(true);
    try {
      const { data, error } = await supabase
        .from("material_chapters")
        .select(`
          id,
          title,
          content_type,
          content,
          file_name,
          material_id,
          course_materials!inner(
            id,
            title,
            file_name,
            course_id,
            openai_file_id,
            page_count,
            file_size,
            material_type
          )
        `)
        .eq("course_materials.course_id", courseId)
        // "Other" materials are never split, so they have no chapters to list
        // here — they are offered separately as whole documents (#1019).
        .neq("course_materials.material_type", "other")
        .order("chapter_number", { ascending: true }).order("id");

      if (error) throw error;

      const chaptersWithMaterial: ChapterWithMaterial[] = (data || []).map((ch: any) => {
        const fileName: string | null = ch.file_name || null;
        const content: string | null = typeof ch.content === "string" ? ch.content : null;

        let chapterPageCount = 0;
        if (fileName) {
          const match = fileName.match(/Pages\s+(\d+)\s*-\s*(\d+)/i);
          if (match) {
            const start = parseInt(match[1], 10);
            const end = parseInt(match[2], 10);
            if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
              chapterPageCount = end - start + 1;
            }
          }
        }

        const materialPages = ch.course_materials?.page_count || 0;
        const materialSize = ch.course_materials?.file_size || 0;

        let chapterSizeBytes = 0;
        if (chapterPageCount > 0 && materialPages > 0 && materialSize > 0) {
          chapterSizeBytes = Math.round(materialSize * (chapterPageCount / materialPages));
        } else if (content) {
          chapterSizeBytes = new TextEncoder().encode(content).length;
        }

        return {
          id: ch.id,
          title: ch.title,
          content_type: ch.content_type,
          content,
          file_name: fileName,
          material_id: ch.material_id,
          material_title: ch.course_materials?.title || ch.course_materials?.file_name || "Unknown",
          material_type: ch.course_materials?.material_type || "textbook",
          material_page_count: ch.course_materials?.page_count || null,
          material_file_size: ch.course_materials?.file_size || null,
          chapter_page_count: chapterPageCount,
          chapter_size_bytes: chapterSizeBytes,
        };
      });

      setChapters(chaptersWithMaterial);

      setWholeDocs(await fetchWholeDocumentMaterials(courseId));
    } catch (error: any) {
      console.error("Error fetching chapters:", error);
      toast.error("Failed to load chapters");
    } finally {
      setLoadingChapters(false);
    }
  };

  const fetchCompetencies = async () => {
    setLoadingCompetencies(true);
    try {
      const { data, error } = await supabase
        .from("course_competencies")
        .select("id, title, chapter_id")
        .eq("course_id", courseId)
        .order("order_num", { ascending: true });

      if (error) throw error;
      setCompetencies(data || []);
    } catch (error: any) {
      console.error("Error fetching competencies:", error);
      toast.error("Failed to load competencies");
    } finally {
      setLoadingCompetencies(false);
    }
  };

  const fetchStudyGuides = async () => {
    setLoadingStudyGuides(true);
    try {
      const { data: guides, error } = await supabase
        .from("study_guides")
        .select("id, title")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const guideRows = (guides ?? []) as { id: string; title: string }[];
      if (guideRows.length === 0) {
        setStudyGuides([]);
        return;
      }

      // Completeness needs the pieces and their question links — the same
      // bulk shape StudyGuideManager loads for its list badges.
      const { data: pieces, error: piecesError } = await supabase
        .from("study_guide_pieces")
        .select("id, study_guide_id, theory_html")
        .in("study_guide_id", guideRows.map((g) => g.id));
      if (piecesError) throw piecesError;
      const pieceRows = (pieces ?? []) as {
        id: string;
        study_guide_id: string;
        theory_html: string | null;
      }[];

      const withQuestions = new Set<string>();
      if (pieceRows.length > 0) {
        const { data: links, error: linksError } = await supabase
          .from("study_guide_piece_questions")
          .select("piece_id")
          .in("piece_id", pieceRows.map((p) => p.id));
        if (linksError) throw linksError;
        for (const l of links ?? []) {
          withQuestions.add((l as { piece_id: string }).piece_id);
        }
      }

      setStudyGuides(
        guideRows.map((g) => {
          const guidePieces = pieceRows.filter((p) => p.study_guide_id === g.id);
          return {
            id: g.id,
            title: g.title,
            pieceCount: guidePieces.length,
            complete: guideIsCompleteSource(
              guidePieces.map((p) => ({
                theoryHtml: p.theory_html,
                hasQuestions: withQuestions.has(p.id),
              })),
            ),
          };
        }),
      );
    } catch (error) {
      console.error("Error fetching study guides:", error);
      toast.error("Failed to load study guides");
    } finally {
      setLoadingStudyGuides(false);
    }
  };

  // Apply seed and (re-)load options on open transitions.
  useEffect(() => {
    if (open) {
      fetchChapters();
      fetchCompetencies();
      fetchStudyGuides();
      // Apply seed (if any). When no seed is provided, we reset chapter /
      // competency selection and audience but preserve
      // numQuestions/difficulty/startHidden/specialInstructions for parity with
      // the previous CourseQuestions behaviour.
      setSelectionMode(seed?.selectionMode ?? "chapters");
      setSelectedChapterIds(seed?.selectedChapterIds ?? []);
      setSelectedMaterialIds([]);
      setSelectedCompetencyIds(seed?.selectedCompetencyIds ?? []);
      setSelectedStudyGuideIds(seed?.selectedStudyGuideIds ?? []);
      if (seed?.difficulty !== undefined) {
        setDifficulty(seed.difficulty);
      }
      if (seed?.specialInstructions !== undefined) {
        setSpecialInstructions(seed.specialInstructions);
      }
      setAudience(seed?.audience ?? { kind: "none" });
    } else {
      setAudience({ kind: "none" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to open transitions
  }, [open]);

  const groupOptions = useMemo<GroupOption[]>(() => {
    const opts: GroupOption[] = [];
    for (const cls of classes) {
      const groups = groupsByOffering[cls.offering_id] ?? [];
      for (const g of groups) {
        opts.push({
          offering_id: cls.offering_id,
          group_id: g.id,
          label: `${buildClassDisplayName(cls)} → ${g.name}`,
          description: g.description ?? null,
        });
      }
    }
    opts.sort((a, b) => compareText(a.label, b.label));
    return opts;
  }, [classes, groupsByOffering, compareText]);

  const toggleCompetency = (competencyId: string) => {
    setSelectedCompetencyIds(prev => {
      if (prev.includes(competencyId)) {
        return prev.filter(id => id !== competencyId);
      }
      if (prev.length >= MAX_COMPETENCIES) {
        toast.error(`You can select a maximum of ${MAX_COMPETENCIES} competencies`);
        return prev;
      }
      return [...prev, competencyId];
    });
  };

  /**
   * The page/size budget covers everything going into one batch — selected
   * chapters and selected whole documents together — because the edge function
   * adds them up the same way before rejecting an over-large request.
   */
  const getSelectionTotals = (chapterIds: string[], materialIds: string[] = selectedMaterialIds) => {
    let totalPages = 0;
    let totalSize = 0;

    chapters.forEach((ch) => {
      if (!chapterIds.includes(ch.id)) return;
      totalPages += ch.chapter_page_count || 0;
      totalSize += ch.chapter_size_bytes || 0;
    });

    wholeDocs.forEach((doc) => {
      if (!materialIds.includes(doc.id)) return;
      totalPages += doc.page_count || 0;
      totalSize += doc.file_size || 0;
    });

    return { totalPages, totalSize };
  };

  const wouldExceedLimits = (chapterId: string) => {
    const chapter = chapters.find((ch) => ch.id === chapterId);
    if (!chapter) return false;

    const { totalPages, totalSize } = getSelectionTotals(selectedChapterIds);
    const newPages = totalPages + (chapter.chapter_page_count || 0);
    const newSize = totalSize + (chapter.chapter_size_bytes || 0);

    return newPages > MAX_PAGES || newSize > MAX_SIZE_BYTES;
  };

  const materialWouldExceedLimits = (materialId: string) => {
    const doc = wholeDocs.find((m) => m.id === materialId);
    if (!doc) return false;

    const { totalPages, totalSize } = getSelectionTotals(selectedChapterIds);
    const newPages = totalPages + (doc.page_count || 0);
    const newSize = totalSize + (doc.file_size || 0);

    return newPages > MAX_PAGES || newSize > MAX_SIZE_BYTES;
  };

  const toggleChapter = (chapterId: string) => {
    if (!selectedChapterIds.includes(chapterId)) {
      if (wouldExceedLimits(chapterId)) {
        toast.error("Cannot select: would exceed 400 pages or 32MB limit");
        return;
      }
    }

    setSelectedChapterIds(prev =>
      prev.includes(chapterId)
        ? prev.filter(id => id !== chapterId)
        : [...prev, chapterId]
    );
  };

  const toggleStudyGuide = (guideId: string) => {
    setSelectedStudyGuideIds((prev) =>
      prev.includes(guideId) ? prev.filter((id) => id !== guideId) : [...prev, guideId],
    );
  };

  const toggleWholeDoc = (materialId: string) => {
    if (!selectedMaterialIds.includes(materialId) && materialWouldExceedLimits(materialId)) {
      toast.error("Cannot select: would exceed 400 pages or 32MB limit");
      return;
    }

    setSelectedMaterialIds(prev =>
      prev.includes(materialId)
        ? prev.filter(id => id !== materialId)
        : [...prev, materialId]
    );
  };

  const groupedChaptersUnsorted = chapters.reduce((acc, ch) => {
    if (!acc[ch.material_id]) {
      acc[ch.material_id] = {
        title: ch.material_title,
        chapters: [],
        pageCount: ch.material_page_count,
        fileSize: ch.material_file_size,
        materialType: ch.material_type,
      };
    }
    acc[ch.material_id].chapters.push(ch);
    return acc;
  }, {} as Record<string, { title: string; chapters: ChapterWithMaterial[]; pageCount: number | null; fileSize: number | null; materialType: string }>);

  const groupedChapters = Object.fromEntries(
    Object.entries(groupedChaptersUnsorted).sort(([, a], [, b]) => {
      const aIsTextbook = a.materialType === "textbook" ? 0 : 1;
      const bIsTextbook = b.materialType === "textbook" ? 0 : 1;
      if (aIsTextbook !== bIsTextbook) return aIsTextbook - bIsTextbook;
      return compareText(a.title, b.title);
    }),
  );

  const handleGenerateQuestions = async () => {
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
    if (selectionMode === "guides" && selectedStudyGuideIds.length === 0) {
      toast.error("Please select at least one study guide");
      return;
    }

    setGenerating(true);

    const count = parseInt(numQuestions);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-questions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({
            courseId,
            numQuestions: count,
            difficulty,
            chapterIds: selectionMode === "chapters" ? selectedChapterIds : undefined,
            materialIds: selectionMode === "chapters" ? selectedMaterialIds : undefined,
            competencyIds: selectionMode === "competencies" ? selectedCompetencyIds : undefined,
            studyGuideIds: selectionMode === "guides" ? selectedStudyGuideIds : undefined,
            startHidden,
            enableTrueFalse,
            diagramMode,
            specialInstructions: specialInstructions.trim() || undefined,
            group_id: audience.kind === "group" ? audience.groupId : undefined,
            student_user_id: audience.kind === "student" ? audience.studentUserId : undefined,
          }),
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error ${response.status}`);
      }

      const functionData = await response.json();

      if (functionData?.error) {
        throw new Error(functionData.error);
      }

      const questionsToInsert = functionData.questions;
      const validationSummary = functionData.validationSummary;

      if (!questionsToInsert || questionsToInsert.length === 0) {
        throw new Error("No questions were generated");
      }

      if (functionData.warning) {
        toast.warning(functionData.warning);
      }

      const { data, error } = await supabase
        .from("questions")
        .insert(questionsToInsert.map((q: any) => {
          // Junction-only fields are stripped; `generated_for_group_id` IS a
          // column and stays in the row.
          const { competency_ids, chapter_ids, material_ids, ...rest } = q;
          return { ...rest, created_by: session.user.id };
        }))
        .select();

      if (error) throw error;

      const typedData = data as unknown as { id: string }[];

      const competencyLinks = typedData.flatMap((insertedQ, idx) => {
        const originalQ = questionsToInsert[idx];
        const compIds = originalQ.competency_ids || [];
        return compIds.map((compId: string) => ({
          question_id: insertedQ.id,
          competency_id: compId,
        }));
      });

      if (competencyLinks.length > 0) {
        await supabase.from("question_competencies").insert(competencyLinks);
      }

      const chapterLinks = typedData.flatMap((insertedQ, idx) => {
        const originalQ = questionsToInsert[idx];
        const chIds = originalQ.chapter_ids || [];
        return chIds.map((chId: string) => ({
          question_id: insertedQ.id,
          chapter_id: chId,
        }));
      });

      if (chapterLinks.length > 0) {
        const { error: chapterLinkError } = await supabase.from("question_chapters").insert(chapterLinks);
        if (chapterLinkError) throw chapterLinkError;
      }

      // Whole-document sources (#1019). `question_materials` isn't in the
      // generated supabase types yet; the cast matches `offering_questions`.
      const materialLinks = typedData.flatMap((insertedQ, idx) => {
        const originalQ = questionsToInsert[idx];
        const matIds = originalQ.material_ids || [];
        return matIds.map((mId: string) => ({
          question_id: insertedQ.id,
          material_id: mId,
        }));
      });

      if (materialLinks.length > 0) {
        const { error: materialLinkError } = await supabase
          .from("question_materials" as never)
          .insert(materialLinks as never);
        // Partial success, not failure: the questions are already committed,
        // and throwing here would invite a retry that duplicates them.
        if (materialLinkError) {
          console.error("Failed to link source documents:", materialLinkError);
          toast.warning(`Questions saved, but linking their source documents failed: ${materialLinkError.message}`);
        }
      }

      // Auto-assign generated questions to an individually targeted student.
      // A group audience is NOT auto-assigned: it steers the prompt and is
      // recorded on the question as `generated_for_group_id`, and the
      // instructor decides separately what to publish and to whom.
      let autoAssignedLabel: string | null = null;
      let assignTarget: { offering_id: string; group_id: string; label: string } | null = null;
      if (audience.kind === "student" && functionData.target?.kind === "student") {
        const t = functionData.target;
        const studentName = t.student_full_name || audience.label;
        assignTarget = {
          offering_id: t.offering_id,
          group_id: t.group_id,
          label: studentName,
        };
      }
      if (assignTarget) {
        const nowIso = new Date().toISOString();
        const assignRows = typedData.map((q) => ({
          offering_id: assignTarget!.offering_id,
          question_id: q.id,
          group_id: assignTarget!.group_id,
          published_at: nowIso,
        }));
        const { error: assignErr } = await supabase
          .from("offering_questions" as any)
          .insert(assignRows);
        if (assignErr) {
          console.error("Auto-assign failed:", assignErr);
          toast.warning(`Generated questions, but auto-assignment to ${assignTarget.label} failed: ${assignErr.message}`);
        } else {
          autoAssignedLabel = assignTarget.label;
        }
      }

      onGenerated?.();

      setGenerating(false);
      onOpenChange(false);

      const suffix = autoAssignedLabel ? ` · assigned to ${autoAssignedLabel}` : "";
      if (validationSummary) {
        const { valid, needsReview, total } = validationSummary;
        if (needsReview > 0) {
          toast.success(`Generated ${total} questions: ${valid} verified, ${needsReview} need review${suffix}`);
        } else {
          toast.success(`Generated ${total} questions, all verified${suffix}`);
        }
      } else {
        toast.success(`Generated ${typedData.length} questions with AI${suffix}`);
      }
    } catch (error: any) {
      console.error("Generation error:", error);
      setGenerating(false);
      toast.error(error.message || "Failed to generate questions");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* max-h/overflow are required, not cosmetic: DialogContent is
          `position: fixed` centred by transform, so without them an over-tall
          dialog has no scrollable ancestor and the "Generate N Questions"
          button below the fold becomes unreachable — on a 1280x720 viewport it
          could not be clicked at all (#966). Matches the sibling
          UnifiedGenerateDialog. */}
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate Questions with AI</DialogTitle>
          <DialogDescription>
            Select chapters, competencies, or completed study guides to focus on
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {seed?.note && (
            <Alert className="border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
              <Sparkles className="h-4 w-4 !text-sky-600 dark:!text-sky-400" />
              <AlertDescription>{seed.note}</AlertDescription>
            </Alert>
          )}
          {chapters.length > 0 && !chapters.some(ch => ch.material_type === "textbook") && (
            <Alert className="border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4 !text-amber-600 dark:!text-amber-400" />
              <AlertDescription>
                No textbook material found for this course. AI generation will use supplementary materials only (teacher companion, exercises), which may affect output quality.
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label>Generate based on</Label>
            <RadioGroup
              value={selectionMode}
              onValueChange={(v) => setSelectionMode(v as "chapters" | "competencies" | "guides")}
              className="flex flex-wrap gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="chapters" id="mode-chapters" />
                <label htmlFor="mode-chapters" className="text-sm cursor-pointer flex items-center gap-1.5">
                  <BookOpen className="w-4 h-4" />
                  Chapters
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="competencies" id="mode-competencies" />
                <label htmlFor="mode-competencies" className="text-sm cursor-pointer flex items-center gap-1.5">
                  <Target className="w-4 h-4" />
                  Competencies
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="guides" id="mode-guides" />
                <label htmlFor="mode-guides" className="text-sm cursor-pointer flex items-center gap-1.5">
                  <BookOpenCheck className="w-4 h-4" />
                  Study guides
                </label>
              </div>
            </RadioGroup>
          </div>

          {selectionMode === "chapters" && (
            <div className="space-y-2">
              <Label>Select Chapters</Label>
              {loadingChapters ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : chapters.length === 0 && wholeDocs.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No text chapters found. Add text chapters to your materials first.
                </p>
              ) : (
                <ScrollArea className="h-40 rounded-md border p-3">
                  <div className="space-y-4">
                    {Object.entries(groupedChapters).map(([materialId, { title, chapters: materialChapters, pageCount }]) => {
                      const isAnyChapterSelected = materialChapters.some(ch => selectedChapterIds.includes(ch.id));
                      const wouldExceed = !isAnyChapterSelected && wouldExceedLimits(materialChapters[0]?.id);
                      return (
                        <div key={materialId} className="space-y-2">
                          <p className={`text-sm font-medium flex items-center gap-1 ${wouldExceed ? 'text-destructive' : 'text-muted-foreground'}`}>
                            <BookOpen className="w-3.5 h-3.5" />
                            {title}
                            {pageCount && (
                              <span className="text-xs ml-1">({pageCount} pages)</span>
                            )}
                          </p>
                          <div className="space-y-1 pl-4">
                            {materialChapters.map((ch) => {
                              const isSelected = selectedChapterIds.includes(ch.id);
                              const isDisabled = !isSelected && wouldExceedLimits(ch.id);
                              return (
                                <div key={ch.id} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={ch.id}
                                    checked={isSelected}
                                    onCheckedChange={() => toggleChapter(ch.id)}
                                    disabled={isDisabled}
                                  />
                                  <label
                                    htmlFor={ch.id}
                                    className={`text-sm cursor-pointer leading-none ${isDisabled ? 'text-muted-foreground/50 cursor-not-allowed' : ''}`}
                                  >
                                    {ch.title}
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    {/* "Other" materials have no chapters, so each one is a
                        single choice: the whole document (#1019). */}
                    {wholeDocs.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium flex items-center gap-1 text-muted-foreground">
                          <FileText className="w-3.5 h-3.5" />
                          Other documents
                        </p>
                        <div className="space-y-1 pl-4">
                          {wholeDocs.map((doc) => {
                            const isSelected = selectedMaterialIds.includes(doc.id);
                            const isDisabled = !isSelected && materialWouldExceedLimits(doc.id);
                            return (
                              <div key={doc.id} className="flex items-center space-x-2">
                                <Checkbox
                                  id={`doc-${doc.id}`}
                                  checked={isSelected}
                                  onCheckedChange={() => toggleWholeDoc(doc.id)}
                                  disabled={isDisabled}
                                />
                                <label
                                  htmlFor={`doc-${doc.id}`}
                                  className={`text-sm cursor-pointer leading-none ${isDisabled ? 'text-muted-foreground/50 cursor-not-allowed' : ''}`}
                                >
                                  {doc.title}
                                  {doc.page_count ? (
                                    <span className="text-xs text-muted-foreground ml-1">({doc.page_count} pages)</span>
                                  ) : null}
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              )}
              {(() => {
                const { totalPages, totalSize } = getSelectionTotals(selectedChapterIds);
                const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
                const docsNote = selectedMaterialIds.length > 0
                  ? ` · ${selectedMaterialIds.length} document${selectedMaterialIds.length === 1 ? "" : "s"}`
                  : "";
                return (
                  <p className="text-xs text-muted-foreground">
                    {selectedChapterIds.length} chapters selected{docsNote} · {totalPages} / {MAX_PAGES} pages · {sizeMB} / 32 MB
                  </p>
                );
              })()}
            </div>
          )}

          {selectionMode === "guides" && (
            <div className="space-y-2">
              <Label>Select Study Guides</Label>
              {loadingStudyGuides ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : studyGuides.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No study guides found. Create one in the Study Guides tab first.
                </p>
              ) : (
                <ScrollArea className="h-40 rounded-md border p-3">
                  <div className="space-y-2">
                    {studyGuides.map((guide) => (
                      <div key={guide.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`guide-${guide.id}`}
                          checked={selectedStudyGuideIds.includes(guide.id)}
                          onCheckedChange={() => toggleStudyGuide(guide.id)}
                          disabled={!guide.complete}
                        />
                        <label
                          htmlFor={`guide-${guide.id}`}
                          className={`text-sm cursor-pointer leading-none ${!guide.complete ? "text-muted-foreground/50 cursor-not-allowed" : ""}`}
                        >
                          {guide.title}
                          <span className="text-xs text-muted-foreground ml-1">
                            {guide.complete
                              ? `(${guide.pieceCount} piece${guide.pieceCount === 1 ? "" : "s"})`
                              : "(incomplete — every piece needs theory and questions first)"}
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
              <p className="text-xs text-muted-foreground">
                Questions are generated from the guide's theory and won't repeat the questions the guide already asks.
              </p>
            </div>
          )}

          {selectionMode === "competencies" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Select Competencies</Label>
              </div>
              {loadingCompetencies ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : competencies.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  No competencies found. Extract or add competencies from the Materials tab first.
                </p>
              ) : (
                <ScrollArea className="h-40 rounded-md border p-3">
                  <div className="space-y-2">
                    {competencies.map((comp) => (
                      <div key={comp.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`comp-${comp.id}`}
                          checked={selectedCompetencyIds.includes(comp.id)}
                          onCheckedChange={() => toggleCompetency(comp.id)}
                        />
                        <label
                          htmlFor={`comp-${comp.id}`}
                          className="text-sm cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                        >
                          {comp.title}
                        </label>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
              <p className="text-xs text-muted-foreground">
                {selectedCompetencyIds.length} of {competencies.length} competencies selected
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="num-questions">Questions</Label>
              <Select value={numQuestions} onValueChange={setNumQuestions}>
                <SelectTrigger>
                  <SelectValue placeholder="Select number" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1</SelectItem>
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="4">4</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="difficulty">Difficulty</Label>
              <Select value={difficulty} onValueChange={setDifficulty}>
                <SelectTrigger>
                  <SelectValue placeholder="Select difficulty" />
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
          {classes.length > 0 && (
            <TargetAudienceSelector
              id="target-audience"
              classes={classes}
              groupOptions={groupOptions}
              value={audience}
              onChange={setAudience}
              enabled={open}
            />
          )}
          <div className="space-y-2">
            <Label htmlFor="mcq-diagram-mode">Diagrams</Label>
            <Select
              value={diagramMode}
              onValueChange={(v) => setDiagramMode(v as "off" | "auto" | "force")}
            >
              <SelectTrigger id="mcq-diagram-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off — no diagrams</SelectItem>
                <SelectItem value="auto">Auto — when helpful</SelectItem>
                <SelectItem value="force">Force on every question</SelectItem>
              </SelectContent>
            </Select>
            {diagramMode === "force" && (
              <p className="text-xs text-muted-foreground">
                Useful for testing diagram rendering and storage. Quality on non-visual questions may be lower.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="special-instructions">Special Instructions (optional)</Label>
            <Textarea
              id="special-instructions"
              placeholder="e.g., Focus on chapter 3 concepts, avoid theoretical questions, include more calculation-based problems..."
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              rows={2}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Add custom guidance for the AI when generating questions
            </p>
          </div>
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="enable-true-false"
                checked={enableTrueFalse}
                onCheckedChange={(checked) => setEnableTrueFalse(checked === true)}
              />
              <label
                htmlFor="enable-true-false"
                className="text-sm cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Allow True/False questions
              </label>
            </div>
            <p className="pl-6 text-xs text-muted-foreground">
              When enabled, the AI may emit some questions as 2-option True/False items when the source material supports a clean binary claim. Disabled = always 4-option MCQ.
            </p>
          </div>
          <div className="mt-4">
            <Separator />
            <div className="mt-4 rounded-md border border-border bg-muted/40 p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                After generation
              </p>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="start-hidden"
                  checked={startHidden}
                  onCheckedChange={(checked) => setStartHidden(checked === true)}
                />
                <label
                  htmlFor="start-hidden"
                  className="text-sm cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Start as draft, need to make available before can be attached to a class
                </label>
              </div>
            </div>
          </div>
        </div>
        <Button
          onClick={handleGenerateQuestions}
          disabled={
            generating ||
            (selectionMode === "chapters"
              ? selectedChapterIds.length === 0 && selectedMaterialIds.length === 0
              : selectionMode === "competencies"
                ? selectedCompetencyIds.length === 0
                : selectedStudyGuideIds.length === 0)
          }
          className="w-full"
        >
          {generating ? (
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Generating with AI...
              </div>
              <span className="text-xs text-muted-foreground">This may take up to 5 minutes</span>
            </div>
          ) : (
            <>
              <Sparkles className="w-4 h-4 mr-2" />
              Generate {numQuestions} Questions
            </>
          )}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export default GenerateMcqDialog;
