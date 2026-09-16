import { useState, useMemo } from "react";
import { formatQuestionText } from "@/lib/latex-utils";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Eye,
  EyeOff,
  Trash2,
  Edit,
  ChevronUp,
  ChevronDown,
  Search,
  MoreHorizontal,
  ThumbsUp,
  ThumbsDown,
  ArrowUpDown,
  CheckCheck,
  Target,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { AssignedClassesBadges } from "./AssignedClassesBadges";
import { AuthorCell } from "./QuestionMetaCells";
import type { CourseClass, OfferingAssignment, OfferingGroup } from "@/types/content-assignments";
import { toOpenUnified, type OpenAnsweringMode } from "@/lib/question-payload";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFormatters } from "@/i18n/formatters";

interface ChapterReference {
  id: string;
  title: string;
  materialId: string;
  materialTitle: string;
}

interface OpenQuestion {
  id: string;
  question: string;
  modelAnswer: string;
  explanation: string;
  difficulty: "easy" | "medium" | "hard";
  chapters: ChapterReference[];
  upvotes: number;
  downvotes: number;
  hidden: boolean;
  createdAt?: string;
  createdBy?: string | null;
  authorName?: string | null;
  competencies?: { id: string; title: string }[];
  generationRationale?: string | null;
  // #596 — per-question Socratic-vs-single toggle. Optional so callers that
  // don't supply it default to "interactive" via the payload reader.
  answeringMode?: OpenAnsweringMode;
}

interface OpenQuestionsTableProps {
  questions: OpenQuestion[];
  onQuestionsChange: (questions: OpenQuestion[]) => void;
  isAdmin: boolean;
  classes?: CourseClass[];
  assignmentsByQuestionId?: Record<string, OfferingAssignment[]>;
  groupsByOffering?: Record<string, OfferingGroup[]>;
  onOpenAssignDialog?: (questionId: string) => void;
  onBulkAssign?: (questionIds: string[]) => void;
}

// #1084 dropped the Votes column, and with it the only way to sort on votes.
// The counts still show in the per-question view dialog.
type SortKey = "question" | "difficulty" | "createdAt";

export const OpenQuestionsTable = ({ questions, onQuestionsChange, isAdmin, classes, assignmentsByQuestionId, groupsByOffering, onOpenAssignDialog, onBulkAssign }: OpenQuestionsTableProps) => {
  const { compareText, formatDate, formatTime } = useFormatters();
  const hasAssignments = !!(classes && classes.length > 0 && assignmentsByQuestionId);
  const [search, setSearch] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState<string>("all");
  const [competencyFilter, setCompetencyFilter] = useState<string>("all");
  const [creatorFilter, setCreatorFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [bookFilter, setBookFilter] = useState<string>("all");
  const [chapterFilter, setChapterFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  
  const [editingQuestion, setEditingQuestion] = useState<OpenQuestion | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewingQuestion, setViewingQuestion] = useState<OpenQuestion | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [questionToDelete, setQuestionToDelete] = useState<OpenQuestion | null>(null);
  
  // Selection state for bulk operations
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  
  // Bulk delete state
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  
  // Track which questions are expanded to show full text
  const [expandedQuestions, setExpandedQuestions] = useState<Set<string>>(new Set());

  const [editQuestion, setEditQuestion] = useState("");
  const [editModelAnswer, setEditModelAnswer] = useState("");
  const [editExplanation, setEditExplanation] = useState("");
  const [editDifficulty, setEditDifficulty] = useState<string>("medium");
  const [editCompetencyIds, setEditCompetencyIds] = useState<string[]>([]);
  const [allCompetencies, setAllCompetencies] = useState<{ id: string; title: string }[]>([]);
  const [editChapterIds, setEditChapterIds] = useState<string[]>([]);
  const [allChapters, setAllChapters] = useState<ChapterReference[]>([]);
  const [saving, setSaving] = useState(false);

  // Extract unique competencies from questions for filter dropdown
  const availableCompetencies = useMemo(() => {
    const compMap = new Map<string, string>();
    questions.forEach(q => {
      (q.competencies || []).forEach(c => {
        if (!compMap.has(c.id)) {
          compMap.set(c.id, c.title);
        }
      });
    });
    return Array.from(compMap.entries()).map(([id, title]) => ({ id, title }));
  }, [questions]);

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

  const hasSystemQuestions = useMemo(() => {
    return questions.some(q => !q.createdBy);
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

  const handleChapterFilterChange = (value: string) => {
    if (value.startsWith("book:")) {
      setBookFilter(value.slice(5));
      setChapterFilter("all");
    } else {
      setChapterFilter(value);
    }
    setPage(1);
  };

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const filteredQuestions = questions
    .filter((q) => {
      const matchesSearch = q.question.toLowerCase().includes(search.toLowerCase()) ||
        q.modelAnswer.toLowerCase().includes(search.toLowerCase());
      const matchesDifficulty = difficultyFilter === "all" || q.difficulty === difficultyFilter;
      const matchesCompetency = competencyFilter === "all" ||
        (q.competencies || []).some(c => c.id === competencyFilter);
      const matchesCreator = creatorFilter === "all" ||
        (creatorFilter === "system" ? !q.createdBy : q.createdBy === creatorFilter);
      const matchesBook = bookFilter === "all" ||
        (q.chapters || []).some(ref => ref.materialId === bookFilter);
      const matchesChapter = chapterFilter === "all" ||
        (q.chapters || []).some(ref => ref.id === chapterFilter);
      // Group filter — match questions assigned to the chosen group via
      // offering_questions. Class-wide (group_id NULL) rows are excluded.
      const matchesGroup = groupFilter === "all" ||
        (assignmentsByQuestionId?.[q.id] || []).some(
          (a) => a.group_id === groupFilter
        );
      return matchesSearch && matchesDifficulty && matchesCompetency && matchesCreator && matchesBook && matchesChapter && matchesGroup;
    })
    .sort((a, b) => {
      let comparison = 0;
      switch (sortKey) {
        case "question":
          comparison = compareText(a.question, b.question);
          break;
        case "difficulty": {
          const diffOrder = { easy: 0, medium: 1, hard: 2 };
          comparison = diffOrder[a.difficulty] - diffOrder[b.difficulty];
          break;
        }
        case "createdAt":
          comparison = new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
          break;
      }
      return sortAsc ? comparison : -comparison;
    });

  const totalPages = Math.ceil(filteredQuestions.length / pageSize);
  const paginatedQuestions = filteredQuestions.slice((page - 1) * pageSize, page * pageSize);

  const handleToggleVisibility = async (question: OpenQuestion) => {
    try {
      const nextHidden = !question.hidden;
      const { error } = await supabase
        .from("questions")
        .update({ hidden: nextHidden })
        .eq("id", question.id);

      if (error) throw error;

      onQuestionsChange(
        questions.map((q) =>
          q.id === question.id ? { ...q, hidden: !q.hidden } : q
        )
      );
      toast.success(question.hidden ? "Question is now visible" : "Question is now hidden");
    } catch (error: any) {
      toast.error("Failed to update visibility");
    }
  };

  const handleChangeDifficulty = async (
    questionId: string,
    newDifficulty: "easy" | "medium" | "hard"
  ) => {
    const current = questions.find((q) => q.id === questionId);
    if (current?.difficulty === newDifficulty) return;
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

  const handleDelete = async () => {
    if (!questionToDelete) return;

    try {
      const { error } = await supabase
        .from("questions")
        .delete()
        .eq("id", questionToDelete.id);

      if (error) throw error;

      onQuestionsChange(questions.filter((q) => q.id !== questionToDelete.id));
      toast.success("Question deleted");
      setDeleteDialogOpen(false);
      setQuestionToDelete(null);
    } catch (error: any) {
      toast.error("Failed to delete question");
    }
  };

  const openEditDialog = async (question: OpenQuestion) => {
    setEditingQuestion(question);
    setEditQuestion(question.question);
    setEditModelAnswer(question.modelAnswer);
    setEditExplanation(question.explanation);
    setEditDifficulty(question.difficulty);
    setEditCompetencyIds((question.competencies || []).map(c => c.id));
    setEditChapterIds((question.chapters || []).map(c => c.id));

    try {
      const { data: courseData } = await supabase
        .from("questions")
        .select("course_id")
        .eq("id", question.id)
        .single();

      if (courseData?.course_id) {
        const [{ data: competencies }, { data: chapters }] = await Promise.all([
          supabase
            .from("course_competencies")
            .select("id, title")
            .eq("course_id", courseData.course_id)
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
            .eq("course_materials.course_id", courseData.course_id)
            .order("chapter_number", { ascending: true }).order("id"),
        ]);

        setAllCompetencies(competencies || []);
        setAllChapters(
          (chapters || []).map((ch: any) => ({
            id: ch.id,
            title: ch.title,
            materialId: ch.material_id,
            materialTitle:
              ch.course_materials?.title || ch.course_materials?.file_name || "Unknown",
          }))
        );
      } else {
        setAllChapters(question.chapters || []);
        setAllCompetencies([]);
      }
    } catch (error) {
      console.error("Error fetching edit dialog options:", error);
      setAllChapters(question.chapters || []);
      setAllCompetencies([]);
    }

    setEditDialogOpen(true);
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

  // Bulk assign acts on the rows that ACTUALLY EXIST in `questions`, not on
  // `selectedIds` directly: the selection survives changes to the dataset — a
  // delete, or a filter change — so it can hold ids with no row behind them
  // any more.
  const selectedAssignableIds = questions
    .filter((q) => selectedIds.has(q.id))
    .map((q) => q.id);

  const handleSaveEdit = async () => {
    if (!editingQuestion) return;
    setSaving(true);

    try {
      // Open questions live in the unified `questions` table after #582.
      // Model answer + explanation are persisted via `answer_key`. The
      // answering_mode (#596) is part of `payload`, which `toOpenUnified`
      // rebuilds from scratch — so carry the row's existing mode through
      // rather than letting the rewrite drop it. The mode is fixed when the
      // question is created and is not editable from this dialog.
      const openUnified = toOpenUnified({
        model_answer: editModelAnswer,
        rubric: null,
        explanation: editExplanation,
        answering_mode: editingQuestion.answeringMode ?? "interactive",
      });
      const { error } = await supabase
        .from("questions")
        .update({
          question: editQuestion,
          difficulty: editDifficulty,
          explanation: editExplanation,
          payload: openUnified.payload,
          answer_key: openUnified.answer_key,
        })
        .eq("id", editingQuestion.id);

      if (error) throw error;

      // Update competency assignments
      // First delete existing
      await supabase
        .from("question_competencies")
        .delete()
        .eq("question_id", editingQuestion.id);

      // Then insert new competency links
      if (editCompetencyIds.length > 0) {
        const competencyLinks = editCompetencyIds.map(compId => ({
          question_id: editingQuestion.id,
          competency_id: compId,
        }));
        await supabase.from("question_competencies").insert(competencyLinks);
      }

      // Update chapter assignments (delete + insert)
      const { error: deleteChaptersError } = await supabase
        .from("question_chapters")
        .delete()
        .eq("question_id", editingQuestion.id);

      if (deleteChaptersError) throw deleteChaptersError;

      if (editChapterIds.length > 0) {
        const chapterLinks = editChapterIds.map(chapter_id => ({
          question_id: editingQuestion.id,
          chapter_id,
        }));
        const { error: insertChaptersError } = await supabase.from("question_chapters").insert(chapterLinks);
        if (insertChaptersError) throw insertChaptersError;
      }

      // Build the new competencies + chapters arrays for local state
      const newCompetencies = allCompetencies.filter(c => editCompetencyIds.includes(c.id));
      const newChapters = editChapterIds
        .map(id => allChapters.find(c => c.id === id))
        .filter((c): c is ChapterReference => c !== undefined);

      onQuestionsChange(
        questions.map((q) =>
          q.id === editingQuestion.id
            ? {
                ...q,
                question: editQuestion,
                modelAnswer: editModelAnswer,
                explanation: editExplanation,
                difficulty: editDifficulty as "easy" | "medium" | "hard",
                competencies: newCompetencies,
                chapters: newChapters,
              }
            : q
        )
      );
      toast.success("Question updated");
      setEditDialogOpen(false);
      setEditingQuestion(null);
    } catch (error: any) {
      toast.error(error?.message || "Failed to update question");
    } finally {
      setSaving(false);
    }
  };

  const getDifficultyColor = getDifficultyClass;

  const SortHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 px-2 -ml-2"
      onClick={() => handleSort(sortKeyName)}
    >
      {label}
      {sortKey === sortKeyName ? (
        sortAsc ? <ChevronUp className="ml-1 h-4 w-4" /> : <ChevronDown className="ml-1 h-4 w-4" />
      ) : (
        <ArrowUpDown className="ml-1 h-4 w-4 opacity-50" />
      )}
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* Search Row */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search questions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filters Row */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={difficultyFilter} onValueChange={setDifficultyFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Difficulty" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Difficulties</SelectItem>
            <SelectItem value="easy">Easy</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="hard">Hard</SelectItem>
          </SelectContent>
        </Select>
        {availableCompetencies.length > 0 && (
          <Select value={competencyFilter} onValueChange={setCompetencyFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Competency" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Competencies</SelectItem>
              {availableCompetencies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title.length > 25 ? c.title.slice(0, 25) + "..." : c.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {(availableAuthors.length > 0 || hasSystemQuestions) && (
          <Select value={creatorFilter} onValueChange={setCreatorFilter}>
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
        )}
        {availableGroups.length > 0 && !!assignmentsByQuestionId && (
          <Select value={groupFilter} onValueChange={(val) => { setGroupFilter(val); setPage(1); }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Groups</SelectItem>
              {availableGroups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name.length > 25 ? g.name.slice(0, 25) + "..." : g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {availableBooks.length > 0 && (
          <Select value={bookFilter} onValueChange={(val) => { setBookFilter(val); setChapterFilter("all"); setPage(1); }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Book" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Books</SelectItem>
              {availableBooks.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.title.length > 25 ? b.title.slice(0, 25) + "..." : b.title}
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
                        All chapters of {book.title.length > 20 ? book.title.slice(0, 20) + "..." : book.title}
                      </SelectItem>
                      {chaptersOfBook.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.title.length > 30 ? c.title.slice(0, 30) + "..." : c.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })
              ) : (
                availableChapters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title.length > 30 ? c.title.slice(0, 30) + "..." : c.title}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Results Summary */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {paginatedQuestions.length} of {filteredQuestions.length} questions
          {filteredQuestions.length !== questions.length && ` (filtered from ${questions.length} total)`}
        </p>
      </div>

      {/* Bulk Actions */}
      {isAdmin && selectedIds.size > 0 && (
        <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg border">
          <span className="text-sm text-muted-foreground">
            {selectedIds.size} selected
          </span>
          {selectedHiddenCount > 0 && (
            <Button size="sm" variant="outline" onClick={handleBulkApprove}>
              <CheckCheck className="h-4 w-4 mr-1" />
              Make Available ({selectedHiddenCount})
            </Button>
          )}
          {selectedVisibleCount > 0 && (
            <Button size="sm" variant="outline" onClick={handleBulkHide}>
              <EyeOff className="h-4 w-4 mr-1" />
              Set as Draft ({selectedVisibleCount})
            </Button>
          )}
          {onBulkAssign && (
            <Button
              size="sm"
              variant="outline"
              disabled={selectedAssignableIds.length === 0}
              onClick={() => onBulkAssign(selectedAssignableIds)}
              data-testid="bulk-assign"
            >
              <Users className="h-4 w-4 mr-1" />
              Assign ({selectedAssignableIds.length})
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setBulkDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Delete ({selectedIds.size})
          </Button>
          <Button 
            size="sm" 
            variant="ghost" 
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              {isAdmin && (
                <TableHead className="w-[40px]">
                  <Checkbox
                    checked={paginatedQuestions.length > 0 && paginatedQuestions.every((q) => selectedIds.has(q.id))}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </TableHead>
              )}
              <TableHead className="w-[35%]">
                <SortHeader label="Question" sortKeyName="question" />
              </TableHead>
              <TableHead>
                <SortHeader label="Difficulty" sortKeyName="difficulty" />
              </TableHead>
              <TableHead className="hidden md:table-cell">Author</TableHead>
              <TableHead className="hidden lg:table-cell">Competencies</TableHead>
              <TableHead className="hidden sm:table-cell">
                <SortHeader label="Created" sortKeyName="createdAt" />
              </TableHead>
              {hasAssignments && (
                <TableHead className="hidden xl:table-cell w-[160px]">
                  <span className="font-medium">Classes</span>
                </TableHead>
              )}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedQuestions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={(isAdmin ? 7 : 6) + (hasAssignments ? 1 : 0)} className="text-center py-8 text-muted-foreground">
                  No questions found
                </TableCell>
              </TableRow>
            ) : (
              paginatedQuestions.map((question) => (
                <TableRow
                  key={question.id}
                  className={`${question.hidden ? "opacity-60" : ""} cursor-pointer hover:bg-muted/50`}
                  onClick={() => {
                    setViewingQuestion(question);
                    setViewDialogOpen(true);
                  }}
                >
                  {isAdmin && (
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(question.id)}
                        onCheckedChange={() => toggleSelect(question.id)}
                        aria-label={`Select question`}
                      />
                    </TableCell>
                  )}
                  <TableCell className="max-w-[300px]">
                    <div className="space-y-2">
                      <div 
                        className={`text-sm ${!expandedQuestions.has(question.id) ? "line-clamp-3" : ""}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedQuestions(prev => {
                            const newSet = new Set(prev);
                            if (newSet.has(question.id)) {
                              newSet.delete(question.id);
                            } else {
                              newSet.add(question.id);
                            }
                            return newSet;
                          });
                        }}
                        dangerouslySetInnerHTML={{ __html: formatQuestionText(question.question) }}
                      />
                      {!expandedQuestions.has(question.id) && question.question.length > 150 && (
                        <button
                          className="text-xs text-primary hover:underline mt-1"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedQuestions(prev => new Set(prev).add(question.id));
                          }}
                        >
                          Show more
                        </button>
                      )}
                      {expandedQuestions.has(question.id) && (
                        <div className="space-y-3 pt-2" onClick={(e) => e.stopPropagation()}>
                          <div>
                            <Label className="text-muted-foreground text-xs">Model Answer</Label>
                            <div
                              className="mt-1 p-3 bg-muted rounded-md prose prose-sm dark:prose-invert max-w-none text-sm"
                              dangerouslySetInnerHTML={{ __html: formatQuestionText(question.modelAnswer) }}
                            />
                          </div>
                          {question.explanation && (
                            <div>
                              <Label className="text-muted-foreground text-xs">Explanation</Label>
                              <div
                                className="mt-1 p-3 bg-muted rounded-md prose prose-sm dark:prose-invert max-w-none text-sm"
                                dangerouslySetInnerHTML={{ __html: formatQuestionText(question.explanation) }}
                              />
                            </div>
                          )}
                          {isAdmin && question.generationRationale && (
                            <div data-testid="generation-rationale">
                              <Label className="text-muted-foreground text-xs">Why this question was generated</Label>
                              <div
                                className="mt-1 p-3 bg-muted/50 border border-border rounded-md prose prose-sm dark:prose-invert max-w-none text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap"
                                dangerouslySetInnerHTML={{ __html: formatQuestionText(question.generationRationale) }}
                              />
                            </div>
                          )}
                          {question.competencies && question.competencies.length > 0 && (
                            <div>
                              <Label className="text-muted-foreground text-xs">Competencies</Label>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {question.competencies.map((c) => (
                                  <Badge key={c.id} variant="secondary" className="flex items-center gap-1 text-xs">
                                    <Target className="h-3 w-3" />
                                    {c.title}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                          {question.chapters && question.chapters.length > 0 && (
                            <div>
                              <Label className="text-muted-foreground text-xs">Source Chapters</Label>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {question.chapters.map((ref) => (
                                  <Badge key={ref.id} variant="secondary" className="text-xs">
                                    {ref.materialTitle ? `${ref.materialTitle} → ${ref.title}` : ref.title}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={getDifficultyColor(question.difficulty)}>
                      {question.difficulty}
                    </Badge>
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
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {question.createdAt ? (
                      <div className="flex flex-col">
                        <span className="text-sm">
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
                    <TableCell className="hidden xl:table-cell" onClick={(e) => e.stopPropagation()}>
                      {!question.hidden ? (
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
                      )}
                    </TableCell>
                  )}
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleToggleVisibility(question)}>
                            {question.hidden ? (
                              <>
                                <Eye className="h-4 w-4 mr-2" />
                                Make Available
                              </>
                            ) : (
                              <>
                                <EyeOff className="h-4 w-4 mr-2" />
                                Set as Draft
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openEditDialog(question)}>
                            <Edit className="h-4 w-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleChangeDifficulty(question.id, "easy")}>
                            Set Easy
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleChangeDifficulty(question.id, "medium")}>
                            Set Medium
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleChangeDifficulty(question.id, "hard")}>
                            Set Hard
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => {
                              setQuestionToDelete(question);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rows per page:</span>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
            <SelectTrigger className="w-[70px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10</SelectItem>
              <SelectItem value="25">25</SelectItem>
              <SelectItem value="50">50</SelectItem>
              <SelectItem value="100">100</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page === 1}
            >
              Previous
            </Button>
            <span className="text-sm">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page === totalPages}
            >
              Next
            </Button>
          </div>
        )}
      </div>

      {/* View Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Question Details</DialogTitle>
          </DialogHeader>
          {viewingQuestion && (
            <div className="space-y-4">
              <div>
                <Label className="text-muted-foreground text-xs">Question</Label>
                <div 
                  className="mt-1 prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: formatQuestionText(viewingQuestion.question) }}
                />
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">Model Answer</Label>
                <div 
                  className="mt-1 p-4 bg-muted rounded-md prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: formatQuestionText(viewingQuestion.modelAnswer) }}
                />
              </div>
              {viewingQuestion.explanation && (
                <div>
                  <Label className="text-muted-foreground text-xs">Explanation</Label>
                  <div
                    className="mt-1 p-4 bg-muted rounded-md prose prose-sm dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: formatQuestionText(viewingQuestion.explanation) }}
                  />
                </div>
              )}
              {isAdmin && viewingQuestion.generationRationale && (
                <div>
                  <Label className="text-muted-foreground text-xs">Why this question was generated</Label>
                  <div
                    className="mt-1 p-4 bg-muted/50 border border-border rounded-md prose prose-sm dark:prose-invert max-w-none text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{ __html: formatQuestionText(viewingQuestion.generationRationale) }}
                  />
                </div>
              )}
              {/* Competencies */}
              {viewingQuestion.competencies && viewingQuestion.competencies.length > 0 && (
                <div>
                  <Label className="text-muted-foreground text-xs">Competencies</Label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {viewingQuestion.competencies.map((c) => (
                      <Badge key={c.id} variant="secondary" className="flex items-center gap-1">
                        <Target className="h-3 w-3" />
                        {c.title}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {/* Source Chapters */}
              {viewingQuestion.chapters && viewingQuestion.chapters.length > 0 && (
                <div>
                  <Label className="text-muted-foreground text-xs">Source Chapters</Label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {viewingQuestion.chapters.map((ref) => (
                      <Badge key={ref.id} variant="secondary" className="text-xs">
                        {ref.materialTitle ? `${ref.materialTitle} \u2192 ${ref.title}` : ref.title}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-4 flex-wrap">
                <Badge className={getDifficultyColor(viewingQuestion.difficulty)}>
                  {viewingQuestion.difficulty}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {viewingQuestion.hidden ? "Hidden" : "Visible"}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Votes:</span>
                  <span className="text-green-600 flex items-center gap-1">
                    <ThumbsUp className="w-4 h-4" />
                    {viewingQuestion.upvotes}
                  </span>
                  <span className="text-red-600 flex items-center gap-1">
                    <ThumbsDown className="w-4 h-4" />
                    {viewingQuestion.downvotes}
                  </span>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Question</DialogTitle>
            <DialogDescription>
              Modify the question, answer, and explanation
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Question</Label>
              <Textarea
                value={editQuestion}
                onChange={(e) => setEditQuestion(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Model Answer</Label>
              <Textarea
                value={editModelAnswer}
                onChange={(e) => setEditModelAnswer(e.target.value)}
                rows={5}
              />
            </div>
            <div className="space-y-2">
              <Label>Explanation</Label>
              <Textarea
                value={editExplanation}
                onChange={(e) => setEditExplanation(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Difficulty</Label>
              <Select value={editDifficulty} onValueChange={setEditDifficulty}>
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
            {allCompetencies.length > 0 && (
              <div className="space-y-2">
                <Label>Competencies</Label>
                <ScrollArea className="h-[150px] border rounded-md p-3">
                  <div className="space-y-2">
                    {allCompetencies.map((comp) => (
                      <div key={comp.id} className="flex items-center space-x-2">
                        <Checkbox
                          id={`comp-${comp.id}`}
                          checked={editCompetencyIds.includes(comp.id)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setEditCompetencyIds([...editCompetencyIds, comp.id]);
                            } else {
                              setEditCompetencyIds(editCompetencyIds.filter(id => id !== comp.id));
                            }
                          }}
                        />
                        <Label htmlFor={`comp-${comp.id}`} className="text-sm font-normal cursor-pointer">
                          {comp.title}
                        </Label>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
            {allChapters.length > 0 && (
              <div className="space-y-2">
                <Label>Chapters</Label>
                <ScrollArea className="h-[200px] border rounded-md p-3">
                  <div className="space-y-3">
                    {Array.from(
                      allChapters.reduce((map, ch) => {
                        const entry = map.get(ch.materialId) || { title: ch.materialTitle, chapters: [] as ChapterReference[] };
                        entry.chapters.push(ch);
                        map.set(ch.materialId, entry);
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
                                checked={editChapterIds.includes(ch.id)}
                                onCheckedChange={(checked) => {
                                  if (checked) {
                                    setEditChapterIds([...editChapterIds, ch.id]);
                                  } else {
                                    setEditChapterIds(editChapterIds.filter(id => id !== ch.id));
                                  }
                                }}
                              />
                              <Label htmlFor={`chap-${ch.id}`} className="text-sm font-normal cursor-pointer">
                                {ch.title}
                              </Label>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSaveEdit} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Question</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this question? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
              {bulkDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
