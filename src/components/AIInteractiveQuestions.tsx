import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { ContentAssignDialog } from "./ContentAssignDialog";
import type { CourseClass } from "@/types/content-assignments";
import { buildClassDisplayName } from "@/lib/greek-school";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

import {
  Sparkles,
  Loader2,
  BookOpen,
  Target,
  GraduationCap,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchAuthorNames } from "@/lib/author-names";
import { OpenQuestionsTable } from "./OpenQuestionsTable";
import { TargetAudienceSelector, type AudienceSelection, type GroupOption } from "./TargetAudienceSelector";
import {
  toOpenUnified,
  openModelAnswerFromAnswerKey,
  openAnsweringModeFromPayload,
  type OpenAnsweringMode,
} from "@/lib/question-payload";
import type { Json } from "@/integrations/supabase/types";
import { useFormatters } from "@/i18n/formatters";
import {
  fetchWholeDocumentMaterials,
  type WholeDocumentMaterial,
} from "@/lib/whole-document-materials";

interface CourseMaterial {
  id: string;
  file_name: string;
  title: string | null;
}

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

interface OpenQuestion {
  id: string;
  question: string;
  modelAnswer: string;
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  chapters: { id: string; title: string; materialId: string; materialTitle: string }[];
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  createdAt?: string;
  createdBy?: string | null;
  authorName?: string | null;
  competencies?: { id: string; title: string }[];
  generationRationale?: string | null;
  answeringMode?: OpenAnsweringMode;
}

interface DbOpenQuestion {
  id: string;
  course_id: string;
  question: string;
  model_answer: string;
  explanation: string | null;
  difficulty: string;
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  created_at: string;
  created_by: string | null;
  generation_rationale: string | null;
  payload?: Json | null;
}

interface StudyGuideOption {
  id: string;
  title: string;
}

interface StudyGuidePiece {
  id: string;
  title: string;
  position: number;
  hasTheory: boolean;
}

type SelectionMode = "chapters" | "competencies" | "studyGuide";

interface AIInteractiveQuestionsProps {
  courseId: string;
  materials: CourseMaterial[];
  isAdmin: boolean;
  classes?: CourseClass[];
}

const mapDbToQuestion = (db: DbOpenQuestion): OpenQuestion => ({
  id: db.id,
  question: db.question,
  modelAnswer: db.model_answer,
  explanation: db.explanation || "",
  difficulty: db.difficulty as "easy" | "medium" | "hard",
  chapters: [],
  upvotes: db.upvotes,
  downvotes: db.downvotes,
  hidden: db.hidden,
  createdAt: db.created_at,
  createdBy: db.created_by,
  generationRationale: db.generation_rationale,
  answeringMode: openAnsweringModeFromPayload(db.payload ?? null),
});

const AIInteractiveQuestions = ({ courseId, materials: _materials, isAdmin, classes = [] }: AIInteractiveQuestionsProps) => {
  const { compareText } = useFormatters();
  const [questions, setQuestions] = useState<OpenQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [numQuestions, setNumQuestions] = useState("1");
  const [difficulty, setDifficulty] = useState<string>("mixed");
  const [startHidden, setStartHidden] = useState(false);
  const [chapters, setChapters] = useState<ChapterWithMaterial[]>([]);
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);

  // "Other" materials (#1019) are never split, so they are selected as whole
  // documents rather than through the chapter tree above.
  const [wholeDocs, setWholeDocs] = useState<WholeDocumentMaterial[]>([]);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [specialInstructions, setSpecialInstructions] = useState("");

  const [selectionMode, setSelectionMode] = useState<SelectionMode>("chapters");
  const [competencies, setCompetencies] = useState<{ id: string; title: string; chapter_id: string | null }[]>([]);
  const [selectedCompetencyIds, setSelectedCompetencyIds] = useState<string[]>([]);
  const [loadingCompetencies, setLoadingCompetencies] = useState(false);

  // Third source: the theory a study guide already generated. The
  // guide's prose is what students actually read, so questions written from it
  // test the same text rather than the raw textbook behind it.
  const [studyGuides, setStudyGuides] = useState<StudyGuideOption[]>([]);
  const [selectedStudyGuideId, setSelectedStudyGuideId] = useState<string>("");
  const [studyGuidePieces, setStudyGuidePieces] = useState<StudyGuidePiece[]>([]);
  const [selectedPieceIds, setSelectedPieceIds] = useState<string[]>([]);
  const [loadingStudyGuides, setLoadingStudyGuides] = useState(false);
  const [loadingPieces, setLoadingPieces] = useState(false);
  // Switching guides twice in a row can land the responses out of order. Only
  // the newest request may write state: an older one resolving last would
  // otherwise pair the selected guide with another guide's sections.
  const pieceRequestSeq = useRef(0);

  const [audience, setAudience] = useState<AudienceSelection>({ kind: "none" });

  const questionIds = useMemo(() => questions.map((q) => q.id), [questions]);
  const contentAssignments = useContentAssignments('open_question', questionIds, classes);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetIds, setAssignTargetIds] = useState<string[]>([]);
  const [assignIsBulk, setAssignIsBulk] = useState(false);

  const handleOpenAssignDialog = useCallback((questionId: string) => {
    setAssignTargetIds([questionId]);
    setAssignIsBulk(false);
    setAssignDialogOpen(true);
  }, []);

  const handleBulkAssign = useCallback((qIds: string[]) => {
    setAssignTargetIds(qIds);
    setAssignIsBulk(true);
    setAssignDialogOpen(true);
  }, []);

  const handleSaveAssign = useCallback(async (selection: Set<string> | import("@/types/content-assignments").AssignSelection) => {
    await contentAssignments.saveAssignments(assignTargetIds, selection, assignIsBulk);
    setAssignDialogOpen(false);
  }, [contentAssignments, assignTargetIds, assignIsBulk]);

  useEffect(() => {
    fetchQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

  const fetchQuestions = async () => {
    try {
      const { data, error } = await supabase
        .from("questions")
        .select(
          "id, course_id, question, answer_key, payload, explanation, difficulty, upvotes, downvotes, hidden, created_at, created_by, generation_rationale",
        )
        .eq("course_id", courseId)
        .eq("type", "open")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const normalized: DbOpenQuestion[] = (data || [])
        .map((q: any) => ({
          id: q.id,
          course_id: q.course_id,
          question: q.question,
          model_answer: openModelAnswerFromAnswerKey(q.answer_key),
          explanation: q.explanation,
          difficulty: q.difficulty,
          upvotes: q.upvotes,
          downvotes: q.downvotes,
          hidden: q.hidden,
          created_at: q.created_at,
          created_by: q.created_by,
          generation_rationale: q.generation_rationale,
          payload: q.payload,
        }))
        // A question's answering mode is fixed when it is created: this tab
        // writes "interactive", the Question Bank's generator writes "single"
        // (#618). Neither can be flipped afterwards, so this tab shows only
        // the interactive rows — the exact inverse of the bank's
        // `excludeInteractiveOpen` filter (#624), keeping the two surfaces
        // disjoint.
        .filter((q) => openAnsweringModeFromPayload(q.payload ?? null) === "interactive");

      const allIds = normalized.map((q) => q.id);

      const voteCounts: Record<string, { up: number; down: number }> = {};
      if (allIds.length > 0) {
        const { data: votes } = await supabase
          .from("question_votes")
          .select("question_id, vote_type")
          .in("question_id", allIds);

        (votes || []).forEach((v: any) => {
          if (!voteCounts[v.question_id]) {
            voteCounts[v.question_id] = { up: 0, down: 0 };
          }
          if (v.vote_type === 'up') {
            voteCounts[v.question_id].up++;
          } else {
            voteCounts[v.question_id].down++;
          }
        });
      }

      const competencyMap: Record<string, { id: string; title: string }[]> = {};
      if (allIds.length > 0) {
        const { data: questionCompetencies } = await supabase
          .from("question_competencies")
          .select(`
            question_id,
            competency_id,
            course_competencies!inner(id, title)
          `)
          .in("question_id", allIds);

        (questionCompetencies || []).forEach((qc: any) => {
          if (!competencyMap[qc.question_id]) {
            competencyMap[qc.question_id] = [];
          }
          competencyMap[qc.question_id].push({
            id: qc.course_competencies.id,
            title: qc.course_competencies.title,
          });
        });
      }

      const chapterMap: Record<string, OpenQuestion["chapters"]> = {};
      if (allIds.length > 0) {
        const { data: questionChapters } = await supabase
          .from("question_chapters")
          .select(`
            question_id,
            chapter_id,
            material_chapters!inner(
              id,
              title,
              material_id,
              course_materials!inner(id, title, file_name)
            )
          `)
          .in("question_id", allIds);

        (questionChapters || []).forEach((qc: any) => {
          const ch = qc.material_chapters;
          const mat = ch?.course_materials;
          if (!ch || !mat) return;
          if (!chapterMap[qc.question_id]) {
            chapterMap[qc.question_id] = [];
          }
          chapterMap[qc.question_id].push({
            id: ch.id,
            title: ch.title,
            materialId: mat.id,
            materialTitle: mat.title || mat.file_name || "Unknown",
          });
        });
      }

      const authorMap = await fetchAuthorNames(normalized.map((q) => q.created_by));

      setQuestions(normalized.map(q => ({
        ...mapDbToQuestion(q),
        upvotes: voteCounts[q.id]?.up || 0,
        downvotes: voteCounts[q.id]?.down || 0,
        competencies: competencyMap[q.id] || [],
        chapters: chapterMap[q.id] || [],
        authorName: q.created_by ? (authorMap[q.created_by] || "Unknown") : null,
      })));
    } catch (error: any) {
      console.error("Error fetching AI interactive questions:", error);
      toast.error("Failed to load questions");
    } finally {
      setLoading(false);
    }
  };

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
      setSelectedChapterIds([]);

      setWholeDocs(await fetchWholeDocumentMaterials(courseId));
      setSelectedMaterialIds([]);
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
      setSelectedCompetencyIds([]);
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
      const { data, error } = await supabase
        .from("study_guides")
        .select("id, title")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      setStudyGuides((data as StudyGuideOption[]) || []);
    } catch (error: any) {
      console.error("Error fetching study guides:", error);
      toast.error("Failed to load study guides");
    } finally {
      setLoadingStudyGuides(false);
    }
  };

  const fetchStudyGuidePieces = async (guideId: string) => {
    const requestId = ++pieceRequestSeq.current;
    const isStale = () => requestId !== pieceRequestSeq.current;

    // Drop the previous guide's sections before the new ones arrive. Keeping
    // them would leave Generate enabled over a selection that belongs to a
    // guide the instructor is no longer looking at, and the request would pair
    // the new guide id with the old piece ids.
    setStudyGuidePieces([]);
    setSelectedPieceIds([]);
    setLoadingPieces(true);
    try {
      const { data, error } = await supabase
        .from("study_guide_pieces")
        .select("id, title, position, theory_html")
        .eq("study_guide_id", guideId)
        .order("position", { ascending: true });

      if (error) throw error;
      if (isStale()) return;

      const pieces: StudyGuidePiece[] = (data || []).map((p: any) => ({
        id: p.id,
        title: p.title,
        position: p.position,
        hasTheory: typeof p.theory_html === "string" && p.theory_html.trim().length > 0,
      }));

      setStudyGuidePieces(pieces);
      // Only sections that actually have theory are usable, so they are what
      // gets pre-selected.
      setSelectedPieceIds(pieces.filter((p) => p.hasTheory).map((p) => p.id));
    } catch (error: any) {
      if (isStale()) return;
      console.error("Error fetching study guide sections:", error);
      toast.error("Failed to load study guide sections");
      setStudyGuidePieces([]);
      setSelectedPieceIds([]);
    } finally {
      if (!isStale()) setLoadingPieces(false);
    }
  };

  useEffect(() => {
    if (generateDialogOpen) {
      fetchChapters();
      fetchCompetencies();
      fetchStudyGuides();
    } else {
      setAudience({ kind: "none" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch when dialog opens
  }, [generateDialogOpen]);

  useEffect(() => {
    if (!generateDialogOpen || !selectedStudyGuideId) {
      // Clearing the guide also invalidates anything still in flight.
      pieceRequestSeq.current++;
      setStudyGuidePieces([]);
      setSelectedPieceIds([]);
      return;
    }
    fetchStudyGuidePieces(selectedStudyGuideId);
  }, [selectedStudyGuideId, generateDialogOpen]);

  const groupOptions = useMemo<GroupOption[]>(() => {
    const opts: GroupOption[] = [];
    for (const cls of classes) {
      const groups = contentAssignments.groupsByOffering[cls.offering_id] ?? [];
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
  }, [classes, contentAssignments.groupsByOffering, compareText]);

  const MAX_COMPETENCIES = 3;

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

  const piecesWithTheory = useMemo(
    () => studyGuidePieces.filter((p) => p.hasTheory),
    [studyGuidePieces],
  );

  const togglePiece = (pieceId: string) => {
    setSelectedPieceIds(prev =>
      prev.includes(pieceId)
        ? prev.filter(id => id !== pieceId)
        : [...prev, pieceId]
    );
  };

  const MAX_PAGES = 400;
  const MAX_SIZE_BYTES = 32 * 1024 * 1024; // 32MB

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
    if (selectionMode === "studyGuide") {
      if (!selectedStudyGuideId) {
        toast.error("Please select a study guide");
        return;
      }
      if (selectedPieceIds.length === 0) {
        toast.error("Please select at least one study guide section with generated theory");
        return;
      }
    }

    setGenerating(true);
    const count = parseInt(numQuestions);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-open-questions`,
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
            studyGuideId: selectionMode === "studyGuide" ? selectedStudyGuideId : undefined,
            pieceIds: selectionMode === "studyGuide" ? selectedPieceIds : undefined,
            startHidden,
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
        throw new Error(errorData.error || "Failed to send a request to the Edge Function");
      }

      const functionData = await response.json();

      if (functionData?.error) {
        throw new Error(functionData.error);
      }

      const questionsToInsert = functionData.questions;

      if (!questionsToInsert || questionsToInsert.length === 0) {
        throw new Error("No questions were generated");
      }

      if (functionData.warning) {
        toast.warning(functionData.warning);
      }

      const { data: { user } } = await supabase.auth.getUser();
      const createdBy = user?.id || null;

      // #618 — this tab always generates Socratic ("interactive") questions.
      // The mode is hardcoded here; no in-dialog toggle.
      const questionRows = questionsToInsert.map((q: any) => ({
        id: q.id,
        course_id: courseId,
        question: q.question,
        explanation: q.explanation ?? "",
        difficulty: q.difficulty,
        hidden: q.hidden,
        upvotes: 0,
        downvotes: 0,
        is_user_generated: false,
        created_by: createdBy,
        competency_id: (q.competency_ids && q.competency_ids[0]) || null,
        generated_for_group_id: q.generated_for_group_id ?? null,
        generation_rationale: q.generation_rationale ?? null,
        ...toOpenUnified({
          model_answer: q.model_answer ?? (q.answer_key as any)?.model_answer ?? "",
          rubric: null,
          explanation: q.explanation ?? null,
          answering_mode: "interactive",
        }),
      }));

      const { data, error } = await supabase
        .from("questions")
        .insert(questionRows)
        .select();

      if (error) throw error;

      const typedData: DbOpenQuestion[] = (data || []).map((q: any) => ({
        id: q.id,
        course_id: q.course_id,
        question: q.question,
        model_answer: openModelAnswerFromAnswerKey(q.answer_key),
        explanation: q.explanation,
        difficulty: q.difficulty,
        upvotes: q.upvotes,
        downvotes: q.downvotes,
        hidden: q.hidden,
        created_at: q.created_at,
        created_by: q.created_by,
        generation_rationale: q.generation_rationale,
        payload: q.payload,
      }));

      const competencyIdToTitle = new Map(competencies.map(c => [c.id, c.title]));

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
        const matIds: string[] = originalQ.material_ids || [];
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

      // Only an individually targeted student is auto-assigned. A group
      // audience steers the prompt and is recorded on the question row as
      // `generated_for_group_id`; publishing stays a separate decision.
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

      const chapterLookup = new Map(
        chapters.map(ch => [ch.id, {
          id: ch.id,
          title: ch.title,
          materialId: ch.material_id,
          materialTitle: ch.material_title,
        }])
      );

      const newQuestions = typedData.map((dbQ, idx) => {
        const originalQ = questionsToInsert[idx];
        const compIds = originalQ.competency_ids || [];
        const chIds: string[] = originalQ.chapter_ids || [];
        const questionCompetencies = compIds
          .map((id: string) => ({ id, title: competencyIdToTitle.get(id) || "" }))
          .filter((c: { id: string; title: string }) => c.title);
        const questionChapters = chIds
          .map((id: string) => chapterLookup.get(id))
          .filter((c): c is NonNullable<typeof c> => Boolean(c));
        return {
          ...mapDbToQuestion(dbQ),
          competencies: questionCompetencies,
          chapters: questionChapters,
        };
      });
      setQuestions(prev => [...newQuestions, ...prev]);

      setGenerating(false);
      setGenerateDialogOpen(false);
      const suffix = autoAssignedLabel ? ` · assigned to ${autoAssignedLabel}` : "";
      toast.success(`Generated ${newQuestions.length} AI interactive questions${suffix}`);
    } catch (error: any) {
      console.error("Generation error:", error);
      setGenerating(false);
      toast.error(error.message || "Failed to generate questions");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
    {isAdmin && (
      <Dialog open={generateDialogOpen} onOpenChange={setGenerateDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate AI Interactive Questions</DialogTitle>
            <DialogDescription>
              Select chapters, competencies, or a study guide's theory — questions will use the Socratic chat tutor
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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
                onValueChange={(v) => setSelectionMode(v as SelectionMode)}
                className="flex flex-wrap gap-4"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="chapters" id="ai-interactive-mode-chapters" />
                  <label htmlFor="ai-interactive-mode-chapters" className="text-sm cursor-pointer flex items-center gap-1.5">
                    <BookOpen className="w-4 h-4" />
                    Chapters
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="competencies" id="ai-interactive-mode-competencies" />
                  <label htmlFor="ai-interactive-mode-competencies" className="text-sm cursor-pointer flex items-center gap-1.5">
                    <Target className="w-4 h-4" />
                    Competencies
                  </label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="studyGuide" id="ai-interactive-mode-study-guide" />
                  <label htmlFor="ai-interactive-mode-study-guide" className="text-sm cursor-pointer flex items-center gap-1.5">
                    <GraduationCap className="w-4 h-4" />
                    Study Guide
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
                                      id={`ai-interactive-${ch.id}`}
                                      checked={isSelected}
                                      onCheckedChange={() => toggleChapter(ch.id)}
                                      disabled={isDisabled}
                                    />
                                    <label
                                      htmlFor={`ai-interactive-${ch.id}`}
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
                                    id={`ai-interactive-doc-${doc.id}`}
                                    checked={isSelected}
                                    onCheckedChange={() => toggleWholeDoc(doc.id)}
                                    disabled={isDisabled}
                                  />
                                  <label
                                    htmlFor={`ai-interactive-doc-${doc.id}`}
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
                            id={`ai-interactive-comp-${comp.id}`}
                            checked={selectedCompetencyIds.includes(comp.id)}
                            onCheckedChange={() => toggleCompetency(comp.id)}
                          />
                          <label
                            htmlFor={`ai-interactive-comp-${comp.id}`}
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

            {selectionMode === "studyGuide" && (
              <div className="space-y-2">
                <Label htmlFor="ai-interactive-study-guide">Select Study Guide</Label>
                {loadingStudyGuides ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : studyGuides.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">
                    No study guides found. Create a study guide and generate its theory first.
                  </p>
                ) : (
                  <>
                    <Select
                      value={selectedStudyGuideId}
                      onValueChange={(guideId) => {
                        if (guideId === selectedStudyGuideId) return;
                        // Cleared in the same tick as the guide id changes, so
                        // the previous guide's sections cannot be submitted
                        // alongside the new id even in the window before the
                        // loading effect runs.
                        pieceRequestSeq.current++;
                        setStudyGuidePieces([]);
                        setSelectedPieceIds([]);
                        setSelectedStudyGuideId(guideId);
                      }}
                    >
                      <SelectTrigger id="ai-interactive-study-guide">
                        <SelectValue placeholder="Choose a study guide" />
                      </SelectTrigger>
                      <SelectContent>
                        {studyGuides.map((guide) => (
                          <SelectItem key={guide.id} value={guide.id}>
                            {guide.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {selectedStudyGuideId && (
                      loadingPieces ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : piecesWithTheory.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-2">
                          This guide has no generated theory yet. Generate the theory for at least one section first.
                        </p>
                      ) : (
                        <>
                          <Label>Sections</Label>
                          <ScrollArea className="h-40 rounded-md border p-3">
                            <div className="space-y-2">
                              {studyGuidePieces.map((piece) => (
                                <div key={piece.id} className="flex items-center space-x-2">
                                  <Checkbox
                                    id={`ai-interactive-piece-${piece.id}`}
                                    checked={selectedPieceIds.includes(piece.id)}
                                    onCheckedChange={() => togglePiece(piece.id)}
                                    disabled={!piece.hasTheory}
                                  />
                                  <label
                                    htmlFor={`ai-interactive-piece-${piece.id}`}
                                    className={`text-sm leading-none ${piece.hasTheory ? "cursor-pointer" : "text-muted-foreground/50 cursor-not-allowed"}`}
                                  >
                                    {piece.title}
                                    {!piece.hasTheory && <span className="ml-1 text-xs">(no theory yet)</span>}
                                  </label>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                          <p className="text-xs text-muted-foreground">
                            {selectedPieceIds.length} of {piecesWithTheory.length} sections selected · questions are written from the guide's theory
                          </p>
                        </>
                      )
                    )}
                  </>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ai-interactive-num-questions">Questions</Label>
                <Select value={numQuestions} onValueChange={setNumQuestions}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select number" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ai-interactive-difficulty">Difficulty</Label>
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
                id="target-audience-ai-interactive"
                classes={classes}
                groupOptions={groupOptions}
                value={audience}
                onChange={setAudience}
                enabled={generateDialogOpen}
              />
            )}
            <div className="space-y-2">
              <Label htmlFor="ai-interactive-special-instructions">Special Instructions (optional)</Label>
              <Textarea
                id="ai-interactive-special-instructions"
                placeholder="e.g., Focus on analytical questions, require step-by-step solutions, include case studies..."
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                rows={2}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Add custom guidance for the AI when generating questions
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="start-hidden-ai-interactive"
                checked={startHidden}
                onCheckedChange={(checked) => setStartHidden(checked === true)}
              />
              <label
                htmlFor="start-hidden-ai-interactive"
                className="text-sm cursor-pointer leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Start as draft, need to make available before can be attached to a class
              </label>
            </div>
          </div>
          <Button
            onClick={handleGenerateQuestions}
            disabled={
              generating ||
              (selectionMode === "chapters" &&
                selectedChapterIds.length === 0 &&
                selectedMaterialIds.length === 0) ||
              (selectionMode === "competencies" && selectedCompetencyIds.length === 0) ||
              (selectionMode === "studyGuide" && (!selectedStudyGuideId || selectedPieceIds.length === 0))
            }
            className="w-full"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Generating with AI...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate {numQuestions} Questions
              </>
            )}
          </Button>
        </DialogContent>
      </Dialog>
    )}

    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            AI Interactive Questions
            {questions.length > 0 && (
              <span className="text-sm font-normal text-muted-foreground">
                ({questions.length})
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <Button onClick={() => setGenerateDialogOpen(true)}>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate AI Interactive Questions
              </Button>
            )}
          </div>
        </div>
        <CardDescription>
          Socratic conversations — the AI tutor asks guiding questions, gives hints, and helps the student reason to the model answer.
          Questions generated here are always AI Interactive; questions generated in the Question Bank are single-answer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {questions.length === 0 ? (
          <div className="py-12 text-center">
            <Sparkles className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground mb-2">No AI interactive questions generated yet</p>
            {isAdmin && (
              <p className="text-sm text-muted-foreground">
                Click "Generate AI Interactive Questions" to create Socratic-chat practice questions
              </p>
            )}
          </div>
        ) : (
          <OpenQuestionsTable
            questions={questions}
            onQuestionsChange={setQuestions}
            isAdmin={isAdmin}
            classes={classes.length > 0 ? classes : undefined}
            assignmentsByQuestionId={classes.length > 0 ? contentAssignments.assignments : undefined}
            groupsByOffering={classes.length > 0 ? contentAssignments.groupsByOffering : undefined}
            onOpenAssignDialog={classes.length > 0 ? handleOpenAssignDialog : undefined}
            onBulkAssign={classes.length > 0 ? handleBulkAssign : undefined}
          />
        )}
      </CardContent>
    </Card>

    {classes.length > 0 && (
      <ContentAssignDialog
        open={assignDialogOpen}
        onOpenChange={setAssignDialogOpen}
        classes={classes}
        currentAssignedTargets={
          !assignIsBulk && assignTargetIds.length === 1
            ? contentAssignments.getAssignedTargets(assignTargetIds[0])
            : []
        }
        groupsByOffering={contentAssignments.groupsByOffering}
        onSave={handleSaveAssign}
        saving={contentAssignments.saving}
        title={assignIsBulk ? `Assign ${assignTargetIds.length} Questions to Classes` : "Assign to Classes"}
      />
    )}
    </>
  );
};

export default AIInteractiveQuestions;
