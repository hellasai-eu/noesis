import { useState, useEffect, useMemo } from "react";
import { processLatexContent } from "@/lib/latex-utils";
import { getDifficultyClass } from "@/lib/difficulty-color";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Target } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  Eye,
  EyeOff,
  ThumbsUp,
  ThumbsDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  X,
  CheckCheck,
  User,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  Loader2,
  BookOpen,
  Users,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AssignedClassesBadges } from "./AssignedClassesBadges";
import { VoteBadges, AuthorCell } from "./QuestionMetaCells";
import type { CourseClass, OfferingAssignment, OfferingGroup } from "@/types/content-assignments";
import { toMcqUnified } from "@/lib/question-payload";
import { useFormatters } from "@/i18n/formatters";

interface ChapterReference {
  id: string;
  title: string;
  materialId: string;
  materialTitle: string;
}

interface Question {
  id: string;
  question: string;
  options: string[];
  // Multi-correct (#592): the set of correct option indices. Single-correct
  // MCQs hold a one-element array.
  correctIndices: number[];
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  chapters: ChapterReference[];
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  createdAt?: string;
  totalAnswers?: number;
  correctAnswers?: number;
  incorrectAnswers?: number;
  isUserGenerated?: boolean;
  createdBy?: string | null;
  authorName?: string | null;
  competencies?: { id: string; title: string }[];
  validationStatus?: "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "INSUFFICIENT_INFORMATION" | null;
  validationConfidence?: number | null;
  validationMessage?: string | null;
  validatedAt?: string | null;
  generationRationale?: string | null;
}

type SortField = "question" | "difficulty" | "hidden" | "createdAt" | "successRate" | "upvotes";
type SortDirection = "asc" | "desc";

interface QuestionsTableProps {
  questions: Question[];
  onQuestionsChange: (questions: Question[]) => void;
  isAdmin: boolean;
  courseId?: string;
  classes?: CourseClass[];
  assignmentsByQuestionId?: Record<string, OfferingAssignment[]>;
  groupsByOffering?: Record<string, OfferingGroup[]>;
  onOpenAssignDialog?: (questionId: string) => void;
  onBulkAssign?: (questionIds: string[]) => void;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export const QuestionsTable = ({
  questions,
  onQuestionsChange,
  isAdmin,
  courseId,
  classes,
  assignmentsByQuestionId,
  groupsByOffering,
  onOpenAssignDialog,
  onBulkAssign,
}: QuestionsTableProps) => {
  const { compareCode, compareText, formatDate, formatTime } = useFormatters();
  const hasAssignments = !!(classes && classes.length > 0 && assignmentsByQuestionId);
  // Sorting state
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<string>("all");
  const [visibilityFilter, setVisibilityFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [competencyFilter, setCompetencyFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [bookFilter, setBookFilter] = useState<string>("all");
  const [chapterFilter, setChapterFilter] = useState<string>("all");
  const [needsReviewFilter, setNeedsReviewFilter] = useState(false);
  const [showStudentQuestions, setShowStudentQuestions] = useState(false);

  // Fetch all course competencies for filter dropdown
  const [availableCompetencies, setAvailableCompetencies] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!courseId) return;
    const fetchCompetencies = async () => {
      const { data, error } = await supabase
        .from("course_competencies")
        .select("id, title")
        .eq("course_id", courseId)
        .order("order_num");
      if (error) {
        console.error("Failed to fetch competencies:", error);
        return;
      }
      if (data) {
        setAvailableCompetencies(data);
      }
    };
    fetchCompetencies();
  }, [courseId]);

  // Extract unique authors from questions for creator filter dropdown
  const availableAuthors = useMemo(() => {
    const authorMap = new Map<string, string>();
    questions.forEach(q => {
      if (q.createdBy && q.authorName) {
        authorMap.set(q.createdBy, q.authorName);
      }
    });
    return Array.from(authorMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => compareText(a.name, b.name));
  }, [questions, compareText]);

  // Check if any questions have null createdBy (system/AI generated)
  const hasSystemQuestions = useMemo(() => {
    return questions.some(q => !q.createdBy);
  }, [questions]);

  const hasStudentQuestions = useMemo(() => {
    return questions.some(q => q.isUserGenerated);
  }, [questions]);

  const availableBooks = useMemo(() => {
    const bookMap = new Map<string, string>();
    questions.forEach(q => {
      (q.chapters || []).forEach(ref => {
        if (ref.materialId && ref.materialTitle) bookMap.set(ref.materialId, ref.materialTitle);
      });
    });
    return Array.from(bookMap.entries())
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => compareText(a.title, b.title));
  }, [questions, compareText]);

  const availableChapters = useMemo(() => {
    const chapterMap = new Map<string, { title: string; materialId: string; materialTitle: string }>();
    questions.forEach(q => {
      (q.chapters || []).forEach(ref => {
        chapterMap.set(ref.id, { title: ref.title, materialId: ref.materialId, materialTitle: ref.materialTitle });
      });
    });
    let chapters = Array.from(chapterMap.entries())
      .map(([id, entry]) => ({ id, ...entry }));
    if (bookFilter !== "all") {
      chapters = chapters.filter(c => c.materialId === bookFilter);
    }
    return chapters.sort((a, b) => compareText(a.title, b.title));
  }, [questions, bookFilter, compareText]);

  // Unique non-individual groups across all offerings in this course.
  // groupsByOffering already excludes is_individual rows (see useContentAssignments).
  const availableGroups = useMemo(() => {
    if (!groupsByOffering) return [] as { id: string; name: string }[];
    const byId = new Map<string, string>();
    for (const groups of Object.values(groupsByOffering)) {
      for (const g of groups) byId.set(g.id, g.name);
    }
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => compareText(a.name, b.name));
  }, [groupsByOffering, compareText]);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [editForm, setEditForm] = useState({
    question: "",
    options: ["", "", "", ""],
    // Multi-correct (#592): set of indices marked correct.
    correctIndices: [0] as number[],
    explanation: "",
    difficulty: "medium" as "easy" | "medium" | "hard",
    competencyIds: [] as string[],
    chapterIds: [] as string[],
  });

  // All course competencies for edit dialog
  const [allCourseCompetencies, setAllCourseCompetencies] = useState<{ id: string; title: string }[]>([]);

  // All course chapters (grouped by material) for edit dialog
  const [allCourseChapters, setAllCourseChapters] = useState<ChapterReference[]>([]);

  // Expanded row for viewing details
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  // Bulk delete state
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  
  // Validation state
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set());

  // Handle sorting
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setCurrentPage(1);
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ChevronsUpDown className="w-4 h-4 ml-1 opacity-50" />;
    }
    return sortDirection === "asc" ? (
      <ChevronUp className="w-4 h-4 ml-1" />
    ) : (
      <ChevronDown className="w-4 h-4 ml-1" />
    );
  };

  // Filter and sort questions
  const filteredAndSortedQuestions = useMemo(() => {
    let result = [...questions];

    // Hide student-generated questions unless explicitly toggled on
    if (!showStudentQuestions) {
      result = result.filter((q) => !q.isUserGenerated);
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (q) =>
          q.question.toLowerCase().includes(query) ||
          q.explanation.toLowerCase().includes(query) ||
          q.options.some((opt) => opt.toLowerCase().includes(query))
      );
    }

    // Apply difficulty filter
    if (difficultyFilter !== "all") {
      result = result.filter((q) => q.difficulty === difficultyFilter);
    }

    // Apply visibility filter
    if (visibilityFilter === "visible") {
      result = result.filter((q) => !q.hidden);
    } else if (visibilityFilter === "hidden") {
      result = result.filter((q) => q.hidden);
    }

    // Apply creator filter
    if (sourceFilter === "system") {
      result = result.filter((q) => !q.createdBy);
    } else if (sourceFilter !== "all") {
      result = result.filter((q) => q.createdBy === sourceFilter);
    }

    // Apply competency filter
    if (competencyFilter !== "all") {
      if (competencyFilter === "none") {
        result = result.filter((q) => !q.competencies || q.competencies.length === 0);
      } else {
        result = result.filter((q) => 
          q.competencies?.some(c => c.id === competencyFilter)
        );
      }
    }

    // Apply book filter
    if (bookFilter !== "all") {
      result = result.filter((q) =>
        q.chapters?.some(ref => ref.materialId === bookFilter)
      );
    }

    // Apply chapter filter
    if (chapterFilter !== "all") {
      result = result.filter((q) =>
        q.chapters?.some(ref => ref.id === chapterFilter)
      );
    }

    // Apply group filter — match questions assigned to the chosen group via
    // offering_questions. Class-wide (group_id NULL) rows are excluded.
    if (groupFilter !== "all") {
      result = result.filter((q) =>
        (assignmentsByQuestionId?.[q.id] || []).some(
          (a) => a.group_id === groupFilter
        )
      );
    }

    // Apply needs review filter (shows questions that failed or need review)
    if (needsReviewFilter) {
      result = result.filter((q) => {
        if (!q.validationStatus) return false;
        const confidence = q.validationConfidence || 0;
        const isVerified = q.validationStatus === "CORRECT" && confidence > 0.7;
        return !isVerified;
      });
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case "question":
          comparison = compareText(a.question, b.question);
          break;
        case "difficulty": {
          const diffOrder = { easy: 1, medium: 2, hard: 3 };
          comparison = diffOrder[a.difficulty] - diffOrder[b.difficulty];
          break;
        }
        case "hidden":
          comparison = (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0);
          break;
        case "createdAt":
          comparison = compareCode((a.createdAt || ""), b.createdAt || "");
          break;
        case "successRate": {
          const aRate = a.totalAnswers ? (a.correctAnswers || 0) / a.totalAnswers : -1;
          const bRate = b.totalAnswers ? (b.correctAnswers || 0) / b.totalAnswers : -1;
          comparison = aRate - bRate;
          break;
        }
        case "upvotes":
          comparison = (a.upvotes || 0) - (b.upvotes || 0);
          break;
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });

    return result;
  }, [questions, searchQuery, difficultyFilter, visibilityFilter, sourceFilter, competencyFilter, groupFilter, bookFilter, chapterFilter, needsReviewFilter, showStudentQuestions, sortField, sortDirection, assignmentsByQuestionId, compareCode, compareText]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedQuestions.length / pageSize);
  const paginatedQuestions = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredAndSortedQuestions.slice(start, start + pageSize);
  }, [filteredAndSortedQuestions, currentPage, pageSize]);

  // Reset to page 1 when filters change
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const handleDifficultyFilterChange = (value: string) => {
    setDifficultyFilter(value);
    setCurrentPage(1);
  };

  const handleVisibilityFilterChange = (value: string) => {
    setVisibilityFilter(value);
    setCurrentPage(1);
  };

  const handleSourceFilterChange = (value: string) => {
    setSourceFilter(value);
    setCurrentPage(1);
  };

  const handleCompetencyFilterChange = (value: string) => {
    setCompetencyFilter(value);
    setCurrentPage(1);
  };

  const handleGroupFilterChange = (value: string) => {
    setGroupFilter(value);
    setCurrentPage(1);
  };

  const handleBookFilterChange = (value: string) => {
    setBookFilter(value);
    setChapterFilter("all");
    setCurrentPage(1);
  };

  const handleChapterFilterChange = (value: string) => {
    if (value.startsWith("book:")) {
      setBookFilter(value.slice(5));
      setChapterFilter("all");
    } else {
      setChapterFilter(value);
    }
    setCurrentPage(1);
  };

  const handlePageSizeChange = (value: string) => {
    setPageSize(parseInt(value));
    setCurrentPage(1);
  };

  // Validate single question
  const handleValidateQuestion = async (questionId: string) => {
    setValidatingIds(prev => new Set(prev).add(questionId));
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/validate-questions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ questionIds: [questionId] }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Validation failed");
      }

      const data = await response.json();
      const result = data.results?.[0];

      if (result) {
        // Update local state with validation result
        onQuestionsChange(
          questions.map((q) =>
            q.id === questionId
              ? {
                  ...q,
                  validationStatus: result.verdict as Question["validationStatus"],
                  validationConfidence: result.confidence,
                  validationMessage: result.message,
                  validatedAt: new Date().toISOString(),
                }
              : q
          )
        );

        if (result.passed) {
          toast.success(`Answer verified as correct (${Math.round(result.confidence * 100)}% confidence)`);
        } else {
          toast.warning(`Answer may be incorrect: ${result.message}`);
        }
      }
    } catch (error: any) {
      toast.error(error.message || "Failed to validate question");
    } finally {
      setValidatingIds(prev => {
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
    }
  };

  // Bulk validate selected questions
  const handleBulkValidate = async () => {
    const idsToValidate = Array.from(selectedIds);
    if (idsToValidate.length === 0) {
      toast.error("No questions selected");
      return;
    }

    setValidatingIds(new Set(idsToValidate));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/validate-questions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
            "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ questionIds: idsToValidate }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Validation failed");
      }

      const data = await response.json();

      // Update local state with all validation results
      const resultMap = new Map<string, { verdict: string; confidence: number; message: string }>(
        data.results?.map((r: any) => [r.questionId, { verdict: r.verdict, confidence: r.confidence, message: r.message }]) || []
      );
      
      onQuestionsChange(
        questions.map((q) => {
          const result = resultMap.get(q.id);
          if (result) {
            return {
              ...q,
              validationStatus: result.verdict as Question["validationStatus"],
              validationConfidence: result.confidence,
              validationMessage: result.message,
              validatedAt: new Date().toISOString(),
            };
          }
          return q;
        })
      );

      setSelectedIds(new Set());
      toast.success(`Validated ${data.summary.total} questions: ${data.summary.valid} passed, ${data.summary.filtered} failed`);
    } catch (error: any) {
      toast.error(error.message || "Failed to validate questions");
    } finally {
      setValidatingIds(new Set());
    }
  };

  // Action handlers
  const handleDeleteQuestion = async (questionId: string) => {
    try {
      const { error } = await supabase
        .from("questions")
        .delete()
        .eq("id", questionId);

      if (error) throw error;

      onQuestionsChange(questions.filter((q) => q.id !== questionId));
      toast.success("Question deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete question");
    }
  };


  const handleToggleVisibility = async (questionId: string) => {
    const question = questions.find((q) => q.id === questionId);
    if (!question) return;

    try {
      const { error } = await supabase
        .from("questions")
        .update({ hidden: !question.hidden })
        .eq("id", questionId);

      if (error) throw error;

      onQuestionsChange(
        questions.map((q) =>
          q.id === questionId ? { ...q, hidden: !q.hidden } : q
        )
      );
      toast.success(question.hidden ? "Question is now visible" : "Question is now hidden");
    } catch (error: any) {
      toast.error("Failed to update visibility");
    }
  };

  // Bulk approve (unhide) selected questions
  const handleBulkApprove = async () => {
    const hiddenSelectedIds = Array.from(selectedIds).filter(
      (id) => questions.find((q) => q.id === id)?.hidden
    );

    if (hiddenSelectedIds.length === 0) {
      toast.error("No hidden questions selected");
      return;
    }

    try {
      const { error } = await supabase
        .from("questions")
        .update({ hidden: false })
        .in("id", hiddenSelectedIds);

      if (error) throw error;

      onQuestionsChange(
        questions.map((q) =>
          hiddenSelectedIds.includes(q.id) ? { ...q, hidden: false } : q
        )
      );
      setSelectedIds(new Set());
      toast.success(`${hiddenSelectedIds.length} question(s) approved`);
    } catch (error: any) {
      toast.error("Failed to approve questions");
    }
  };

  // Bulk hide selected questions
  const handleBulkHide = async () => {
    const visibleSelectedIds = Array.from(selectedIds).filter(
      (id) => !questions.find((q) => q.id === id)?.hidden
    );

    if (visibleSelectedIds.length === 0) {
      toast.error("No visible questions selected");
      return;
    }

    try {
      const { error } = await supabase
        .from("questions")
        .update({ hidden: true })
        .in("id", visibleSelectedIds);

      if (error) throw error;

      onQuestionsChange(
        questions.map((q) =>
          visibleSelectedIds.includes(q.id) ? { ...q, hidden: true } : q
        )
      );
      setSelectedIds(new Set());
      toast.success(`${visibleSelectedIds.length} question(s) hidden`);
    } catch (error: any) {
      toast.error("Failed to hide questions");
    }
  };

  // Bulk delete selected questions
  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;

    setBulkDeleting(true);
    try {
      const idsToDelete = Array.from(selectedIds);
      const { error } = await supabase
        .from("questions")
        .delete()
        .in("id", idsToDelete);

      if (error) throw error;

      onQuestionsChange(
        questions.filter((q) => !idsToDelete.includes(q.id))
      );
      setSelectedIds(new Set());
      setBulkDeleteDialogOpen(false);
      toast.success(`${idsToDelete.length} question(s) deleted`);
    } catch (error: any) {
      toast.error("Failed to delete questions");
    } finally {
      setBulkDeleting(false);
    }
  };

  // Selection helpers
  const hiddenQuestions = useMemo(
    () => filteredAndSortedQuestions.filter((q) => q.hidden),
    [filteredAndSortedQuestions]
  );

  const toggleSelectAll = () => {
    const currentPageIds = paginatedQuestions.map((q) => q.id);
    const allSelected = currentPageIds.every((id) => selectedIds.has(id));
    
    if (allSelected) {
      const newSelected = new Set(selectedIds);
      currentPageIds.forEach((id) => newSelected.delete(id));
      setSelectedIds(newSelected);
    } else {
      const newSelected = new Set(selectedIds);
      currentPageIds.forEach((id) => newSelected.add(id));
      setSelectedIds(newSelected);
    }
  };

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const selectedHiddenCount = Array.from(selectedIds).filter(
    (id) => questions.find((q) => q.id === id)?.hidden
  ).length;

  const selectedVisibleCount = selectedIds.size - selectedHiddenCount;

  const handleChangeDifficulty = async (
    questionId: string,
    newDifficulty: "easy" | "medium" | "hard"
  ) => {
    try {
      const { error } = await supabase
        .from("questions")
        .update({ difficulty: newDifficulty })
        .eq("id", questionId);

      if (error) throw error;

      onQuestionsChange(
        questions.map((q) =>
          q.id === questionId ? { ...q, difficulty: newDifficulty } : q
        )
      );
      toast.success(`Difficulty changed to ${newDifficulty}`);
    } catch (error: any) {
      toast.error("Failed to update difficulty");
    }
  };

  const openEditDialog = async (question: Question) => {
    setEditingQuestion(question);
    setEditForm({
      question: question.question,
      options: [...question.options],
      correctIndices: [...question.correctIndices],
      explanation: question.explanation,
      difficulty: question.difficulty,
      competencyIds: (question.competencies || []).map(c => c.id),
      chapterIds: (question.chapters || []).map(c => c.id),
    });

    try {
      const { data: questionData } = await supabase
        .from("questions")
        .select("course_id")
        .eq("id", question.id)
        .single();

      const resolvedCourseId = questionData?.course_id ?? courseId ?? null;

      if (resolvedCourseId) {
        const [{ data: competencies }, { data: chapters }] = await Promise.all([
          supabase
            .from("course_competencies")
            .select("id, title")
            .eq("course_id", resolvedCourseId)
            .order("order_num"),
          supabase
            .from("material_chapters")
            .select(`
              id,
              title,
              chapter_number,
              material_id,
              course_materials!inner(id, title, file_name, course_id)
            `)
            .eq("course_materials.course_id", resolvedCourseId)
            .order("chapter_number", { ascending: true }).order("id"),
        ]);

        setAllCourseCompetencies(competencies || []);
        setAllCourseChapters(
          (chapters || []).map((ch: any) => ({
            id: ch.id,
            title: ch.title,
            materialId: ch.material_id,
            materialTitle:
              ch.course_materials?.title || ch.course_materials?.file_name || "Unknown",
          }))
        );
      } else {
        setAllCourseCompetencies(availableCompetencies);
        setAllCourseChapters(question.chapters || []);
      }
    } catch (error) {
      console.error("Error fetching edit dialog options:", error);
      setAllCourseCompetencies(availableCompetencies);
      setAllCourseChapters(question.chapters || []);
    }

    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingQuestion) return;

    if (!editForm.question.trim()) {
      toast.error("Question text is required");
      return;
    }

    if (editForm.options.some((opt) => !opt.trim())) {
      toast.error("All answer options are required");
      return;
    }

    if (editForm.correctIndices.length === 0) {
      toast.error("Mark at least one option as correct");
      return;
    }

    const normalizedCorrect = [...new Set(editForm.correctIndices)].sort((a, b) => a - b);

    try {
      // Update question fields. After #582 the unified `payload` /
      // `answer_key` columns are the sole source of MCQ data. After #592 the
      // `answer_key` carries `correct_indices: number[]`.
      const { error } = await supabase
        .from("questions")
        .update({
          question: editForm.question,
          ...toMcqUnified({
            options: editForm.options,
            correct_answers: normalizedCorrect,
          }),
          explanation: editForm.explanation,
          difficulty: editForm.difficulty,
        })
        .eq("id", editingQuestion.id);

      if (error) throw error;

      // Update competency assignments
      // First, delete existing assignments
      const { error: deleteError } = await supabase
        .from("question_competencies")
        .delete()
        .eq("question_id", editingQuestion.id);

      if (deleteError) throw deleteError;

      // Then, insert new assignments
      if (editForm.competencyIds.length > 0) {
        const competencyInserts = editForm.competencyIds.map(compId => ({
          question_id: editingQuestion.id,
          competency_id: compId,
        }));

        const { error: insertError } = await supabase
          .from("question_competencies")
          .insert(competencyInserts);

        if (insertError) throw insertError;
      }

      // Update chapter assignments (delete + insert)
      const { error: deleteChaptersError } = await supabase
        .from("question_chapters")
        .delete()
        .eq("question_id", editingQuestion.id);

      if (deleteChaptersError) throw deleteChaptersError;

      if (editForm.chapterIds.length > 0) {
        const chapterInserts = editForm.chapterIds.map(chapter_id => ({
          question_id: editingQuestion.id,
          chapter_id,
        }));

        const { error: insertChaptersError } = await supabase
          .from("question_chapters")
          .insert(chapterInserts);

        if (insertChaptersError) throw insertChaptersError;
      }

      // Build updated competencies array from all course competencies
      const updatedCompetencies = editForm.competencyIds
        .map(id => allCourseCompetencies.find(c => c.id === id))
        .filter((c): c is { id: string; title: string } => c !== undefined);

      // Build updated chapters array from all course chapters
      const updatedChapters: ChapterReference[] = editForm.chapterIds
        .map(id => allCourseChapters.find(c => c.id === id))
        .filter((c): c is ChapterReference => c !== undefined);

      onQuestionsChange(
        questions.map((q) =>
          q.id === editingQuestion.id
            ? {
                ...q,
                question: editForm.question,
                options: editForm.options,
                correctIndices: normalizedCorrect,
                explanation: editForm.explanation,
                difficulty: editForm.difficulty,
                competencies: updatedCompetencies,
                chapters: updatedChapters,
              }
            : q
        )
      );

      setEditDialogOpen(false);
      setEditingQuestion(null);
      toast.success("Question updated");
    } catch (error: any) {
      toast.error(error.message || "Failed to update question");
    }
  };

  const updateEditOption = (index: number, value: string) => {
    setEditForm((prev) => ({
      ...prev,
      options: prev.options.map((opt, i) => (i === index ? value : opt)),
    }));
  };

  const getDifficultyColor = getDifficultyClass;

  const truncateText = (text: string, maxLength: number) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  };

  // Helper to get validation badge
  const getValidationBadge = (question: Question) => {
    if (validatingIds.has(question.id)) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="bg-muted text-muted-foreground border-muted-foreground/20">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              Validating
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Validation in progress...</TooltipContent>
        </Tooltip>
      );
    }

    if (!question.validationStatus) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-muted-foreground border-muted-foreground/30 text-xs">
              Not validated
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Click "Revalidate Answer" in the actions menu to verify</TooltipContent>
        </Tooltip>
      );
    }

    const confidence = question.validationConfidence || 0;
    const isVerified = question.validationStatus === "CORRECT" && confidence > 0.7;
    const needsReview = question.validationStatus === "PARTIALLY_CORRECT" || 
                        (question.validationStatus === "CORRECT" && confidence <= 0.7);
    const isInvalid = question.validationStatus === "INCORRECT" || 
                      question.validationStatus === "INSUFFICIENT_INFORMATION";

    if (isVerified) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20 text-xs">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Verified
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">Verified ({Math.round(confidence * 100)}% confidence)</p>
            <p className="text-xs text-muted-foreground mt-1">{question.validationMessage}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    if (needsReview) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-xs">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Review
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">{question.validationStatus} ({Math.round(confidence * 100)}% confidence)</p>
            <p className="text-xs text-muted-foreground mt-1">{question.validationMessage}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    if (isInvalid) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/20 text-xs">
              <XCircle className="w-3 h-3 mr-1" />
              Invalid
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">{question.validationStatus} ({Math.round(confidence * 100)}% confidence)</p>
            <p className="text-xs text-muted-foreground mt-1">{question.validationMessage}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    return null;
  };

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search questions..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={difficultyFilter} onValueChange={handleDifficultyFilterChange}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Difficulty" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Difficulties</SelectItem>
            <SelectItem value="easy">Easy</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="hard">Hard</SelectItem>
          </SelectContent>
        </Select>
        <Select value={visibilityFilter} onValueChange={handleVisibilityFilterChange}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="visible">Available</SelectItem>
            <SelectItem value="hidden">Draft</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={handleSourceFilterChange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Created by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Creators</SelectItem>
            {availableAuthors.map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
            {hasSystemQuestions && (
              <SelectItem value="system">System</SelectItem>
            )}
          </SelectContent>
        </Select>
        {availableCompetencies.length > 0 && (
          <Select value={competencyFilter} onValueChange={handleCompetencyFilterChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Competency" />
            </SelectTrigger>
          <SelectContent>
              <SelectItem value="all">All Competencies</SelectItem>
              <SelectItem value="none">No Competency</SelectItem>
              {availableCompetencies.map((comp) => (
                <SelectItem key={comp.id} value={comp.id}>
                  {comp.title.length > 25 ? comp.title.substring(0, 25) + "..." : comp.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {availableGroups.length > 0 && !!assignmentsByQuestionId && (
          <Select value={groupFilter} onValueChange={handleGroupFilterChange}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Groups</SelectItem>
              {availableGroups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name.length > 25 ? g.name.substring(0, 25) + "..." : g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {availableBooks.length > 0 && (
          <Select value={bookFilter} onValueChange={handleBookFilterChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Book" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Books</SelectItem>
              {availableBooks.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.title.length > 25 ? b.title.substring(0, 25) + "..." : b.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {availableChapters.length > 0 && (
          <Select value={chapterFilter} onValueChange={handleChapterFilterChange}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Chapter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Chapters</SelectItem>
              {availableBooks.length > 1 ? (
                availableBooks.map((book) => {
                  const chaptersOfBook = availableChapters.filter(c => c.materialId === book.id);
                  if (chaptersOfBook.length === 0) return null;
                  return (
                    <SelectGroup key={book.id}>
                      <SelectLabel>{book.title}</SelectLabel>
                      <SelectItem value={`book:${book.id}`}>
                        All chapters
                      </SelectItem>
                      {chaptersOfBook.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.title.length > 30 ? c.title.substring(0, 30) + "..." : c.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })
              ) : (
                availableChapters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title.length > 30 ? c.title.substring(0, 30) + "..." : c.title}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="needs-review-filter"
            checked={needsReviewFilter}
            onCheckedChange={(checked) => {
              setNeedsReviewFilter(checked === true);
              setCurrentPage(1);
            }}
          />
          <label
            htmlFor="needs-review-filter"
            className="text-sm cursor-pointer"
          >
            Needs review
          </label>
        </div>
        {hasStudentQuestions && (
          <div className="flex items-center space-x-2">
            <Checkbox
              id="show-student-questions"
              checked={showStudentQuestions}
              onCheckedChange={(checked) => {
                setShowStudentQuestions(checked === true);
                setCurrentPage(1);
              }}
            />
            <label
              htmlFor="show-student-questions"
              className="text-sm cursor-pointer"
            >
              Show student questions
            </label>
          </div>
        )}
      </div>

      {/* Results summary and bulk actions */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing {paginatedQuestions.length} of {filteredAndSortedQuestions.length} questions
          {filteredAndSortedQuestions.length !== questions.length && (
            <span> (filtered from {questions.length} total)</span>
          )}
        </div>
        {isAdmin && selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {selectedIds.size} selected
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBulkValidate}
              disabled={validatingIds.size > 0}
            >
              {validatingIds.size > 0 ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ShieldCheck className="w-4 h-4 mr-2" />
              )}
              Verify ({selectedIds.size})
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBulkHide}
              disabled={selectedVisibleCount === 0}
            >
              <EyeOff className="w-4 h-4 mr-2" />
              Set as Draft ({selectedVisibleCount})
            </Button>
            <Button
              size="sm"
              onClick={handleBulkApprove}
              disabled={selectedHiddenCount === 0}
            >
              <CheckCheck className="w-4 h-4 mr-2" />
              Make Available ({selectedHiddenCount})
            </Button>
            {onBulkAssign && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onBulkAssign(Array.from(selectedIds))}
              >
                <Users className="w-4 h-4 mr-2" />
                Assign ({selectedIds.size})
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setBulkDeleteDialogOpen(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete ({selectedIds.size})
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <TooltipProvider>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              {isAdmin && (
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      paginatedQuestions.length > 0 &&
                      paginatedQuestions.every((q) => selectedIds.has(q.id))
                    }
                    onCheckedChange={toggleSelectAll}
                  />
                </TableHead>
              )}
              <TableHead>
                <button
                  className="flex items-center font-medium hover:text-foreground"
                  onClick={() => handleSort("question")}
                >
                  Question
                  {getSortIcon("question")}
                </button>
              </TableHead>
              <TableHead className="w-[100px]">
                <button
                  className="flex items-center font-medium hover:text-foreground"
                  onClick={() => handleSort("difficulty")}
                >
                  Difficulty
                  {getSortIcon("difficulty")}
                </button>
              </TableHead>
              <TableHead className="w-[110px]">
                <button
                  className="flex items-center font-medium hover:text-foreground"
                  onClick={() => handleSort("upvotes")}
                >
                  Votes
                  {getSortIcon("upvotes")}
                </button>
              </TableHead>
              <TableHead className="hidden md:table-cell">
                <span className="font-medium">Author</span>
              </TableHead>
              <TableHead className="hidden lg:table-cell">
                <span className="font-medium">Competencies</span>
              </TableHead>
              <TableHead className="w-[100px]">
                <button
                  className="flex items-center font-medium hover:text-foreground"
                  onClick={() => handleSort("createdAt")}
                >
                  Created
                  {getSortIcon("createdAt")}
                </button>
              </TableHead>
              {hasAssignments && (
                <TableHead className="hidden lg:table-cell w-[160px]">
                  <span className="font-medium">Classes</span>
                </TableHead>
              )}
              {isAdmin && <TableHead className="w-[60px]">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
              {paginatedQuestions.length === 0 ? (
            <TableRow>
                <TableCell
                  colSpan={(isAdmin ? 8 : 7) + (hasAssignments ? 1 : 0)}
                  className="h-24 text-center text-muted-foreground"
                >
                  No questions found
                </TableCell>
              </TableRow>
            ) : (
              paginatedQuestions.map((question, index) => (
                <>
                  <TableRow
                    key={question.id}
                    className={`cursor-pointer hover:bg-muted/50 ${
                      question.hidden ? "opacity-60" : ""
                    } ${expandedRowId === question.id ? "bg-muted/30" : ""}`}
                    onClick={() =>
                      setExpandedRowId(
                        expandedRowId === question.id ? null : question.id
                      )
                    }
                  >
                    {isAdmin && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(question.id)}
                          onCheckedChange={() => toggleSelect(question.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="max-w-lg">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1">
                          {question.isUserGenerated && (
                            <Badge variant="outline" className="bg-violet-500/10 text-violet-600 border-violet-500/20 text-xs">
                              <User className="w-3 h-3 mr-1" />
                              Student
                            </Badge>
                          )}
                          {question.options.length === 2 && (
                            <Badge variant="outline" className="bg-sky-500/10 text-sky-600 border-sky-500/20 text-xs">
                              T/F
                            </Badge>
                          )}
                        </div>
                        {(() => {
                          const conf = question.validationConfidence || 0;
                          const isVerified = question.validationStatus === "CORRECT" && conf > 0.7;
                          const questionNeedsReview = question.validationStatus && !isVerified;
                          return (
                            <div className="flex items-start gap-2">
                              {question.hidden && (
                                <EyeOff className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                              )}
                              <div>
                                {questionNeedsReview && (
                                  <span className="text-xs font-semibold text-red-600 block mb-0.5">Needs review</span>
                                )}
                                <span
                                  className={`text-sm leading-relaxed ${questionNeedsReview ? "text-red-600" : ""}`}
                                  dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }}
                                />
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={getDifficultyColor(question.difficulty)}
                      >
                        {question.difficulty}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <VoteBadges
                        upvotes={question.upvotes}
                        downvotes={question.downvotes}
                      />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <AuthorCell
                        createdBy={question.createdBy}
                        authorName={question.authorName}
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                      {question.competencies && question.competencies.length > 0 ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <div className="flex flex-wrap gap-1 cursor-pointer">
                              {question.competencies.slice(0, 2).map((comp) => (
                                <Badge 
                                  key={comp.id} 
                                  variant="outline" 
                                  className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs"
                                >
                                  {comp.title.length > 20 ? comp.title.slice(0, 20) + "..." : comp.title}
                                </Badge>
                              ))}
                              {question.competencies.length > 2 && (
                                <Badge variant="outline" className="text-xs text-muted-foreground">
                                  +{question.competencies.length - 2}
                                </Badge>
                              )}
                            </div>
                          </PopoverTrigger>
                          <PopoverContent className="w-80" align="start">
                            <div className="space-y-2">
                              <h4 className="text-sm font-semibold flex items-center gap-2">
                                <Target className="h-4 w-4" />
                                Competencies ({question.competencies.length})
                              </h4>
                              <div className="flex flex-wrap gap-1">
                                {question.competencies.map((comp) => (
                                  <Badge 
                                    key={comp.id} 
                                    variant="outline" 
                                    className="bg-blue-500/10 text-blue-600 border-blue-500/20 text-xs"
                                  >
                                    {comp.title}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {question.createdAt ? (
                        <div className="flex flex-col">
                          <span>
                            {formatDate(question.createdAt, {
                              day: "2-digit",
                              month: "2-digit",
                              year: "2-digit",
                            })}
                          </span>
                          <span className="text-xs">
                            {formatTime(question.createdAt, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    {hasAssignments && (
                      <TableCell className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                        {(() => {
                          const conf = question.validationConfidence || 0;
                          const verified = question.validationStatus === "CORRECT" && conf > 0.7;
                          const canAssign = !question.hidden && !(question.validationStatus && !verified);
                          return canAssign ? (
                            <AssignedClassesBadges
                              classes={classes!}
                              assignedTargets={
                                (assignmentsByQuestionId![question.id] || [])
                                  .filter(a => a.published_at !== null)
                                  .map(a => ({ offering_id: a.offering_id, group_id: a.group_id ?? null }))
                              }
                              groupsByOffering={groupsByOffering}
                              onClickAssign={onOpenAssignDialog ? () => onOpenAssignDialog(question.id) : undefined}
                              compact
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground italic">—</span>
                          );
                        })()}
                      </TableCell>
                    )}
                    {isAdmin && (
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggleVisibility(question.id);
                              }}
                            >
                              {question.hidden ? (
                                <>
                                  <Eye className="w-4 h-4 mr-2" />
                                  Make Available
                                </>
                              ) : (
                                <>
                                  <EyeOff className="w-4 h-4 mr-2" />
                                  Set as Draft
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditDialog(question);
                              }}
                            >
                              <Edit className="w-4 h-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleValidateQuestion(question.id);
                              }}
                              disabled={validatingIds.has(question.id)}
                            >
                              {validatingIds.has(question.id) ? (
                                <>
                                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                  Validating...
                                </>
                              ) : (
                                <>
                                  <ShieldCheck className="w-4 h-4 mr-2" />
                                  Revalidate Answer
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleChangeDifficulty(question.id, "easy");
                              }}
                            >
                              Set Easy
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleChangeDifficulty(question.id, "medium");
                              }}
                            >
                              Set Medium
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleChangeDifficulty(question.id, "hard");
                              }}
                            >
                              Set Hard
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteQuestion(question.id);
                              }}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                  {/* Expanded row details */}
                  {expandedRowId === question.id && (
                    <TableRow>
                      <TableCell colSpan={(isAdmin ? 8 : 7) + (hasAssignments ? 1 : 0)} className="bg-muted/20 p-4">
                        <div className="space-y-4">
                          <div className="flex justify-between items-start">
                            <h4 
                              className="font-medium"
                              dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => setExpandedRowId(null)}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                          <div className="grid gap-2">
                            {question.options.map((option, optIndex) => {
                              const isCorrect = question.correctIndices.includes(optIndex);
                              return (
                                <div
                                  key={optIndex}
                                  className={`flex items-center gap-2 p-2 rounded-md border ${
                                    isCorrect
                                      ? "border-green-500 bg-green-500/10"
                                      : "border-border"
                                  }`}
                                >
                                  <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs font-medium">
                                    {String.fromCharCode(65 + optIndex)}
                                  </span>
                                  <span className="flex-1" dangerouslySetInnerHTML={{ __html: processLatexContent(option) }} />
                                  {isCorrect && (
                                    <CheckCircle className="w-4 h-4 text-green-500" />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {question.explanation && (
                            <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                                  <span className="text-primary text-xs">💡</span>
                                </div>
                                <p className="text-sm font-semibold text-primary">Explanation</p>
                              </div>
                              <div
                                className="prose prose-sm max-w-none text-foreground/90 leading-relaxed whitespace-pre-wrap"
                                dangerouslySetInnerHTML={{ __html: processLatexContent(question.explanation) }}
                              />
                            </div>
                          )}
                          {isAdmin && question.generationRationale && (
                            <div
                              data-testid="generation-rationale"
                              className="bg-muted/50 border border-border rounded-lg p-3"
                            >
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                                Why this question was generated
                              </p>
                              <div
                                className="prose prose-sm max-w-none text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap"
                                dangerouslySetInnerHTML={{ __html: processLatexContent(question.generationRationale) }}
                              />
                            </div>
                          )}
                          <div className="flex items-center gap-6">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">Votes:</span>
                              <span className="text-green-600 flex items-center gap-1">
                                <ThumbsUp className="w-4 h-4" />
                                {question.upvotes}
                              </span>
                              <span className="text-red-600 flex items-center gap-1">
                                <ThumbsDown className="w-4 h-4" />
                                {question.downvotes}
                              </span>
                            </div>
                            {(question.totalAnswers ?? 0) > 0 && (
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">Success Rate:</span>
                                <span className={`font-medium ${
                                  ((question.correctAnswers ?? 0) / (question.totalAnswers ?? 1)) >= 0.7
                                    ? "text-green-600"
                                    : ((question.correctAnswers ?? 0) / (question.totalAnswers ?? 1)) >= 0.4
                                    ? "text-amber-600"
                                    : "text-red-600"
                                }`}>
                                  {Math.round(((question.correctAnswers ?? 0) / (question.totalAnswers ?? 1)) * 100)}%
                                </span>
                                <span className="text-sm text-muted-foreground">
                                  ({question.correctAnswers}/{question.totalAnswers} correct)
                                </span>
                              </div>
                            )}
                          </div>
                          {(question.authorName || question.createdBy) && (
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">Author:</span>
                              <span className="text-sm text-muted-foreground">
                                {question.authorName || "AI Generated"}
                              </span>
                            </div>
                          )}
                          {question.competencies && question.competencies.length > 0 && (
                            <div>
                              <p className="text-sm font-medium mb-2">Competencies</p>
                              <div className="flex flex-wrap gap-2">
                                {question.competencies.map((comp) => (
                                  <Badge key={comp.id} variant="outline" className="text-xs bg-blue-500/10 text-blue-600 border-blue-500/20">
                                    {comp.title}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {question.chapters.length > 0 && (
                            <div>
                              <p className="text-sm font-medium mb-2">Source Chapters</p>
                              <div className="flex flex-wrap gap-2">
                                {question.chapters.map((ref) => (
                                  <Badge key={ref.id} variant="secondary" className="text-xs">
                                    {ref.materialTitle ? `${ref.materialTitle} → ${ref.title}` : ref.title}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      </TooltipProvider>

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rows per page:</span>
          <Select value={pageSize.toString()} onValueChange={handlePageSizeChange}>
            <SelectTrigger className="w-[70px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={size.toString()}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages || 1}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setCurrentPage(1)}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="w-4 h-4" />
              <ChevronLeft className="w-4 h-4 -ml-2" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages || totalPages === 0}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => setCurrentPage(totalPages)}
              disabled={currentPage === totalPages || totalPages === 0}
            >
              <ChevronRight className="w-4 h-4" />
              <ChevronRight className="w-4 h-4 -ml-2" />
            </Button>
          </div>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Edit Question</DialogTitle>
            <DialogDescription>
              Modify the question, answers, and other details
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-4">
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="edit-question">Question</Label>
                <Textarea
                  id="edit-question"
                  value={editForm.question}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, question: e.target.value }))
                  }
                  rows={3}
                />
              </div>

              <div className="space-y-3">
                <Label>Answer Options</Label>
                {editForm.options.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs font-medium flex-shrink-0">
                      {String.fromCharCode(65 + index)}
                    </span>
                    <Input
                      value={option}
                      onChange={(e) => updateEditOption(index, e.target.value)}
                      placeholder={`Option ${String.fromCharCode(65 + index)}`}
                    />
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <Label>Correct Answer(s)</Label>
                <p className="text-xs text-muted-foreground">
                  Mark every correct option. Multi-correct items render with a
                  "Select all that apply." hint automatically.
                </p>
                <div className="flex gap-4 flex-wrap">
                  {editForm.options.map((_, index) => {
                    const checked = editForm.correctIndices.includes(index);
                    return (
                      <div key={index} className="flex items-center space-x-2">
                        <Checkbox
                          id={`correct-${index}`}
                          checked={checked}
                          onCheckedChange={(value) => {
                            setEditForm((prev) => {
                              const next = new Set(prev.correctIndices);
                              if (value) next.add(index);
                              else next.delete(index);
                              return {
                                ...prev,
                                correctIndices: [...next].sort((a, b) => a - b),
                              };
                            });
                          }}
                        />
                        <Label htmlFor={`correct-${index}`} className="font-normal">
                          {String.fromCharCode(65 + index)}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-explanation">Explanation</Label>
                <Textarea
                  id="edit-explanation"
                  value={editForm.explanation}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, explanation: e.target.value }))
                  }
                  rows={3}
                />
              </div>

              <div className="space-y-2">
                <Label>Difficulty</Label>
                <Select
                  value={editForm.difficulty}
                  onValueChange={(val) =>
                    setEditForm((prev) => ({
                      ...prev,
                      difficulty: val as "easy" | "medium" | "hard",
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">Easy</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="hard">Hard</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {allCourseCompetencies.length > 0 && (
                <div className="space-y-2">
                  <Label>Competencies</Label>
                  <div className="border rounded-md p-3 space-y-2 max-h-[200px] overflow-y-auto">
                    {allCourseCompetencies.map((comp) => (
                      <div key={comp.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`comp-${comp.id}`}
                          checked={editForm.competencyIds.includes(comp.id)}
                          onCheckedChange={(checked) => {
                            setEditForm((prev) => ({
                              ...prev,
                              competencyIds: checked
                                ? [...prev.competencyIds, comp.id]
                                : prev.competencyIds.filter((id) => id !== comp.id),
                            }));
                          }}
                        />
                        <Label
                          htmlFor={`comp-${comp.id}`}
                          className="text-sm font-normal cursor-pointer"
                        >
                          {comp.title}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {allCourseChapters.length > 0 && (
                <div className="space-y-2">
                  <Label>Chapters</Label>
                  <div className="border rounded-md p-3 space-y-3 max-h-[240px] overflow-y-auto">
                    {Array.from(
                      allCourseChapters.reduce((map, ch) => {
                        const list = map.get(ch.materialId) || { title: ch.materialTitle, chapters: [] as ChapterReference[] };
                        list.chapters.push(ch);
                        map.set(ch.materialId, list);
                        return map;
                      }, new Map<string, { title: string; chapters: ChapterReference[] }>()).entries()
                    ).map(([materialId, { title, chapters }]) => (
                      <div key={materialId} className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {title}
                        </div>
                        <div className="space-y-2 pl-1">
                          {chapters.map((ch) => (
                            <div key={ch.id} className="flex items-center space-x-2">
                              <Checkbox
                                id={`chap-${ch.id}`}
                                checked={editForm.chapterIds.includes(ch.id)}
                                onCheckedChange={(checked) => {
                                  setEditForm((prev) => ({
                                    ...prev,
                                    chapterIds: checked
                                      ? [...prev.chapterIds, ch.id]
                                      : prev.chapterIds.filter((id) => id !== ch.id),
                                  }));
                                }}
                              />
                              <Label
                                htmlFor={`chap-${ch.id}`}
                                className="text-sm font-normal cursor-pointer"
                              >
                                {ch.title}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit}>Save Changes</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={bulkDeleteDialogOpen} onOpenChange={setBulkDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} Question(s)</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedIds.size} selected question(s)? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleBulkDelete} 
              className="bg-destructive text-destructive-foreground"
              disabled={bulkDeleting}
            >
              {bulkDeleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
