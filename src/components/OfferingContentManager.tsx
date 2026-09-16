import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "@/components/ui/pagination";
import { toast } from "sonner";
import {
  Loader2,
  MessageSquareText,
  Sparkles,
  Users,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Layers,
  FileText,
  ArrowUpDown,
  Filter,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { processLatexContent } from "@/lib/latex-utils";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useFormatters } from "@/i18n/formatters";

interface CourseClass {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
  academic_period: string | null;
  offering_id: string;
}

interface OpenQuestion {
  id: string;
  question: string;
  difficulty: string;
  hidden: boolean;
  created_at: string;
  competency_id: string | null;
}

interface McqQuestion {
  id: string;
  question: string;
  difficulty: string;
  hidden: boolean;
  created_at: string;
  competency_id: string | null;
}

interface Chapter {
  id: string;
  title: string;
  material_title: string | null;
}

interface Competency {
  id: string;
  title: string;
  chapter_id: string | null;
}

interface StudySession {
  id: string;
  title: string;
  topic: string | null;
  status: string;
}

interface ChapterFlashcard {
  id: string;
  title: string;
  flashcard_count: number;
  material_title: string | null;
  flashcards_visible: boolean;
}

interface ChapterCheatsheet {
  id: string;
  title: string;
  material_title: string | null;
  cheat_sheet_visible: boolean;
}

interface OfferingAssignment {
  offering_id: string;
  published_at: string | null;
}

interface OfferingContentManagerProps {
  courseId: string;
  classes: CourseClass[];
  defaultTab?: string;
  singleTab?: boolean;
}

type ContentType = 'open_question' | 'mcq_question' | 'study_session' | 'chapter_flashcard' | 'chapter_cheatsheet';

const ITEMS_PER_PAGE = 10;

export function OfferingContentManager({ courseId, classes, defaultTab = "open-questions", singleTab = false }: OfferingContentManagerProps) {
  const { formatDate } = useFormatters();
  const [loading, setLoading] = useState(true);
  const [openQuestions, setOpenQuestions] = useState<OpenQuestion[]>([]);
  const [mcqQuestions, setMcqQuestions] = useState<McqQuestion[]>([]);
  const [studySessions, setStudySessions] = useState<StudySession[]>([]);
  const [chapterFlashcards, setChapterFlashcards] = useState<ChapterFlashcard[]>([]);
  const [chapterCheatsheets, setChapterCheatsheets] = useState<ChapterCheatsheet[]>([]);
  const [competencies, setCompetencies] = useState<Competency[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  
  // Assignments maps: contentId -> offering assignments
  const [openQuestionAssignments, setOpenQuestionAssignments] = useState<Record<string, OfferingAssignment[]>>({});
  const [mcqQuestionAssignments, setMcqQuestionAssignments] = useState<Record<string, OfferingAssignment[]>>({});
  const [studySessionAssignments, setStudySessionAssignments] = useState<Record<string, OfferingAssignment[]>>({});
  const [chapterFlashcardAssignments, setChapterFlashcardAssignments] = useState<Record<string, OfferingAssignment[]>>({});
  const [chapterCheatsheetAssignments, setChapterCheatsheetAssignments] = useState<Record<string, OfferingAssignment[]>>({});
  
  // Tab state
  const [activeTab, setActiveTab] = useState(defaultTab);
  
  // Pagination state
  const [questionsPage, setQuestionsPage] = useState(1);
  const [mcqQuestionsPage, setMcqQuestionsPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const [flashcardsPage, setFlashcardsPage] = useState(1);
  const [cheatsheetsPage, setCheatsheetsPage] = useState(1);
  
  // MCQ Questions filtering and sorting state
  const [mcqSortOrder, setMcqSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [mcqDifficultyFilter, setMcqDifficultyFilter] = useState<string>('all');
  const [mcqAssignmentFilter, setMcqAssignmentFilter] = useState<'all' | 'assigned' | 'unassigned'>('all');
  const [mcqCompetencyFilter, setMcqCompetencyFilter] = useState<string>('all');
  const [mcqChapterFilter, setMcqChapterFilter] = useState<string>('all');
  const [expandedMcqIds, setExpandedMcqIds] = useState<Set<string>>(new Set());
  
  // Open Questions filtering and sorting state
  const [openSortOrder, setOpenSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [openDifficultyFilter, setOpenDifficultyFilter] = useState<string>('all');
  const [openAssignmentFilter, setOpenAssignmentFilter] = useState<'all' | 'assigned' | 'unassigned'>('all');
  const [openCompetencyFilter, setOpenCompetencyFilter] = useState<string>('all');
  const [openChapterFilter, setOpenChapterFilter] = useState<string>('all');
  const [expandedOpenIds, setExpandedOpenIds] = useState<Set<string>>(new Set());
  
  // Bulk selection state
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
  const [selectedMcqQuestionIds, setSelectedMcqQuestionIds] = useState<Set<string>>(new Set());
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set());
  const [selectedFlashcardIds, setSelectedFlashcardIds] = useState<Set<string>>(new Set());
  const [selectedCheatsheetIds, setSelectedCheatsheetIds] = useState<Set<string>>(new Set());
  
  // Dialog state for assign
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignType, setAssignType] = useState<ContentType>('open_question');
  const [selectedContentId, setSelectedContentId] = useState<string | null>(null);
  const [isBulkAssign, setIsBulkAssign] = useState(false);
  const [selectedOfferings, setSelectedOfferings] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId change
  }, [courseId]);

    const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch competencies for filters (with chapter_id)
      const { data: competenciesData } = await supabase
        .from("course_competencies")
        .select("id, title, chapter_id")
        .eq("course_id", courseId)
        .order("order_num", { ascending: true });
      
      setCompetencies(competenciesData || []);

      // Fetch open questions from the unified `questions` table filtered by
      // `type='open'`. After #582 this is the only source.
      const { data: questionsData } = await supabase
        .from("questions")
        .select("id, question, difficulty, hidden, created_at, competency_id")
        .eq("course_id", courseId)
        .eq("type", "open")
        .eq("hidden", false)
        .order("created_at", { ascending: false });

      // Fetch MCQ questions (non-hidden, non-user-generated) — filter on
      // `type='mcq'` so the open-question siblings (#577) don't show up in
      // the MCQ tab.
      const { data: mcqData } = await supabase
        .from("questions")
        .select("id, question, difficulty, hidden, created_at, competency_id")
        .eq("course_id", courseId)
        .eq("type", "mcq")
        .eq("hidden", false)
        .eq("is_user_generated", false)
        .order("created_at", { ascending: false });

      // Fetch study sessions (course-level ready only)
      const { data: sessionsData } = await supabase
        .from("study_sessions")
        .select("id, title, topic, status")
        .eq("course_id", courseId)
        .eq("status", "ready")
        .order("created_at", { ascending: false });

      // Fetch chapters with flashcards from material_chapters
      const { data: materialsData } = await supabase
        .from("course_materials")
        .select("id, title")
        .eq("course_id", courseId)
        .eq("material_type", "textbook");

      const materialIds = (materialsData || []).map(m => m.id);
      const materialMap = Object.fromEntries((materialsData || []).map(m => [m.id, m.title]));

      let flashcardsData: ChapterFlashcard[] = [];
      let cheatsheetsData: ChapterCheatsheet[] = [];
      let chaptersForFilters: Chapter[] = [];
      if (materialIds.length > 0) {
        const { data: chaptersData } = await supabase
          .from("material_chapters")
          .select("id, title, flashcards, flashcards_visible, cheat_sheet, cheat_sheet_visible, material_id")
          .in("material_id", materialIds);

        // Filter for flashcards
        flashcardsData = (chaptersData || [])
          .filter(ch => ch.flashcards_visible && ch.flashcards !== null)
          .map(ch => ({
            id: ch.id,
            title: ch.title,
            flashcard_count: Array.isArray(ch.flashcards) ? ch.flashcards.length : 0,
            material_title: materialMap[ch.material_id] || null,
            flashcards_visible: ch.flashcards_visible,
          })).filter(ch => ch.flashcard_count > 0);

        // Filter for cheatsheets
        cheatsheetsData = (chaptersData || [])
          .filter(ch => ch.cheat_sheet_visible && ch.cheat_sheet !== null)
          .map(ch => ({
            id: ch.id,
            title: ch.title,
            material_title: materialMap[ch.material_id] || null,
            cheat_sheet_visible: ch.cheat_sheet_visible,
          }));

        // Build chapters list for filtering
        chaptersForFilters = (chaptersData || []).map(ch => ({
          id: ch.id,
          title: ch.title,
          material_title: materialMap[ch.material_id] || null,
        }));
      }

      setChapters(chaptersForFilters);

      setOpenQuestions(questionsData || []);
      setMcqQuestions(mcqData || []);
      setStudySessions(sessionsData || []);
      setChapterFlashcards(flashcardsData);
      setChapterCheatsheets(cheatsheetsData);

      // Fetch all offering assignments
      const offeringIds = classes.map(c => c.offering_id);
      
      if (offeringIds.length > 0 && questionsData && questionsData.length > 0) {
        // After #582 open question assignments live in `offering_questions`
        // (the same table as MCQ assignments), keyed by `question_id`.
        const { data: oqAssignments } = await supabase
          .from("offering_questions")
          .select("question_id, offering_id, published_at")
          .in("offering_id", offeringIds)
          .in("question_id", questionsData.map(q => q.id));

        const oqMap: Record<string, OfferingAssignment[]> = {};
        (oqAssignments || []).forEach(a => {
          if (!oqMap[a.question_id]) oqMap[a.question_id] = [];
          oqMap[a.question_id].push({ offering_id: a.offering_id, published_at: a.published_at });
        });
        setOpenQuestionAssignments(oqMap);
      }

      if (offeringIds.length > 0 && mcqData && mcqData.length > 0) {
        const { data: mqAssignments } = await supabase
          .from("offering_questions")
          .select("question_id, offering_id, published_at")
          .in("offering_id", offeringIds)
          .in("question_id", mcqData.map(q => q.id));

        const mqMap: Record<string, OfferingAssignment[]> = {};
        (mqAssignments || []).forEach((a: any) => {
          if (!mqMap[a.question_id]) mqMap[a.question_id] = [];
          mqMap[a.question_id].push({ offering_id: a.offering_id, published_at: a.published_at });
        });
        setMcqQuestionAssignments(mqMap);
      }

      if (offeringIds.length > 0 && sessionsData && sessionsData.length > 0) {
        const { data: ssAssignments } = await supabase
          .from("offering_study_sessions")
          .select("study_session_id, offering_id, published_at")
          .in("offering_id", offeringIds)
          .in("study_session_id", sessionsData.map(s => s.id));

        const ssMap: Record<string, OfferingAssignment[]> = {};
        (ssAssignments || []).forEach(a => {
          if (!ssMap[a.study_session_id]) ssMap[a.study_session_id] = [];
          ssMap[a.study_session_id].push({ offering_id: a.offering_id, published_at: a.published_at });
        });
        setStudySessionAssignments(ssMap);
      }

      if (offeringIds.length > 0 && flashcardsData && flashcardsData.length > 0) {
        const { data: fsAssignments } = await supabase
          .from("offering_chapter_flashcards")
          .select("chapter_id, offering_id, published_at")
          .in("offering_id", offeringIds)
          .in("chapter_id", flashcardsData.map(f => f.id));

        const fsMap: Record<string, OfferingAssignment[]> = {};
        (fsAssignments || []).forEach((a: any) => {
          if (!fsMap[a.chapter_id]) fsMap[a.chapter_id] = [];
          fsMap[a.chapter_id].push({ offering_id: a.offering_id, published_at: a.published_at });
        });
        setChapterFlashcardAssignments(fsMap);
      }

      if (offeringIds.length > 0 && cheatsheetsData && cheatsheetsData.length > 0) {
        const { data: csAssignments } = await supabase
          .from("offering_chapter_cheatsheets")
          .select("chapter_id, offering_id, published_at")
          .in("offering_id", offeringIds)
          .in("chapter_id", cheatsheetsData.map(c => c.id));

        const csMap: Record<string, OfferingAssignment[]> = {};
        (csAssignments || []).forEach((a: any) => {
          if (!csMap[a.chapter_id]) csMap[a.chapter_id] = [];
          csMap[a.chapter_id].push({ offering_id: a.offering_id, published_at: a.published_at });
        });
        setChapterCheatsheetAssignments(csMap);
      }
    } catch (error: any) {
      console.error("Error fetching content:", error);
      toast.error("Failed to load content");
    } finally {
      setLoading(false);
    }
  };

  // Helper to check if open question is assigned to any class
  const isOpenAssigned = (questionId: string): boolean => {
    const assignments = openQuestionAssignments[questionId] || [];
    return assignments.some(a => a.published_at !== null);
  };

  // Get filtered and sorted open questions
  const getFilteredOpenQuestions = () => {
    let filtered = [...openQuestions];
    
    // Apply difficulty filter
    if (openDifficultyFilter !== 'all') {
      filtered = filtered.filter(q => q.difficulty === openDifficultyFilter);
    }
    
    // Apply chapter filter (filter by competencies that belong to the chapter)
    if (openChapterFilter !== 'all') {
      const chapterCompetencyIds = competencies
        .filter(c => c.chapter_id === openChapterFilter)
        .map(c => c.id);
      filtered = filtered.filter(q => q.competency_id && chapterCompetencyIds.includes(q.competency_id));
    }
    
    // Apply competency filter
    if (openCompetencyFilter !== 'all') {
      filtered = filtered.filter(q => q.competency_id === openCompetencyFilter);
    }
    
    // Apply assignment filter
    if (openAssignmentFilter === 'assigned') {
      filtered = filtered.filter(q => isOpenAssigned(q.id));
    } else if (openAssignmentFilter === 'unassigned') {
      filtered = filtered.filter(q => !isOpenAssigned(q.id));
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();
      return openSortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });
    
    return filtered;
  };

  const filteredOpenQuestions = getFilteredOpenQuestions();

  // Pagination helpers
  const getPaginatedQuestions = () => {
    const start = (questionsPage - 1) * ITEMS_PER_PAGE;
    return filteredOpenQuestions.slice(start, start + ITEMS_PER_PAGE);
  };

  // Helper to check if MCQ is assigned to any class
  const isMcqAssigned = (questionId: string): boolean => {
    const assignments = mcqQuestionAssignments[questionId] || [];
    return assignments.some(a => a.published_at !== null);
  };

  // Get filtered and sorted MCQ questions
  const getFilteredMcqQuestions = () => {
    let filtered = [...mcqQuestions];
    
    // Apply difficulty filter
    if (mcqDifficultyFilter !== 'all') {
      filtered = filtered.filter(q => q.difficulty === mcqDifficultyFilter);
    }
    
    // Apply chapter filter (filter by competencies that belong to the chapter)
    if (mcqChapterFilter !== 'all') {
      const chapterCompetencyIds = competencies
        .filter(c => c.chapter_id === mcqChapterFilter)
        .map(c => c.id);
      filtered = filtered.filter(q => q.competency_id && chapterCompetencyIds.includes(q.competency_id));
    }
    
    // Apply competency filter
    if (mcqCompetencyFilter !== 'all') {
      filtered = filtered.filter(q => q.competency_id === mcqCompetencyFilter);
    }
    
    // Apply assignment filter
    if (mcqAssignmentFilter === 'assigned') {
      filtered = filtered.filter(q => isMcqAssigned(q.id));
    } else if (mcqAssignmentFilter === 'unassigned') {
      filtered = filtered.filter(q => !isMcqAssigned(q.id));
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();
      return mcqSortOrder === 'newest' ? dateB - dateA : dateA - dateB;
    });
    
    return filtered;
  };

  const filteredMcqQuestions = getFilteredMcqQuestions();

  const getPaginatedMcqQuestions = () => {
    const start = (mcqQuestionsPage - 1) * ITEMS_PER_PAGE;
    return filteredMcqQuestions.slice(start, start + ITEMS_PER_PAGE);
  };

  const getPaginatedSessions = () => {
    const start = (sessionsPage - 1) * ITEMS_PER_PAGE;
    return studySessions.slice(start, start + ITEMS_PER_PAGE);
  };

  const getPaginatedFlashcards = () => {
    const start = (flashcardsPage - 1) * ITEMS_PER_PAGE;
    return chapterFlashcards.slice(start, start + ITEMS_PER_PAGE);
  };

  const getPaginatedCheatsheets = () => {
    const start = (cheatsheetsPage - 1) * ITEMS_PER_PAGE;
    return chapterCheatsheets.slice(start, start + ITEMS_PER_PAGE);
  };

  const toggleMcqExpanded = (id: string) => {
    setExpandedMcqIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleOpenExpanded = (id: string) => {
    setExpandedOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalQuestionsPages = Math.ceil(filteredOpenQuestions.length / ITEMS_PER_PAGE);
  const totalMcqQuestionsPages = Math.ceil(filteredMcqQuestions.length / ITEMS_PER_PAGE);
  const totalSessionsPages = Math.ceil(studySessions.length / ITEMS_PER_PAGE);
  const totalFlashcardsPages = Math.ceil(chapterFlashcards.length / ITEMS_PER_PAGE);
  const totalCheatsheetsPages = Math.ceil(chapterCheatsheets.length / ITEMS_PER_PAGE);

  // Bulk selection helpers
  const handleSelectAllQuestions = (checked: boolean) => {
    if (checked) {
      setSelectedQuestionIds(new Set(getPaginatedQuestions().map(q => q.id)));
    } else {
      setSelectedQuestionIds(new Set());
    }
  };

  const handleSelectAllMcqQuestions = (checked: boolean) => {
    if (checked) {
      setSelectedMcqQuestionIds(new Set(getPaginatedMcqQuestions().map(q => q.id)));
    } else {
      setSelectedMcqQuestionIds(new Set());
    }
  };

  const handleSelectAllSessions = (checked: boolean) => {
    if (checked) {
      setSelectedSessionIds(new Set(getPaginatedSessions().map(s => s.id)));
    } else {
      setSelectedSessionIds(new Set());
    }
  };

  const handleSelectAllFlashcards = (checked: boolean) => {
    if (checked) {
      setSelectedFlashcardIds(new Set(getPaginatedFlashcards().map(f => f.id)));
    } else {
      setSelectedFlashcardIds(new Set());
    }
  };

  const handleSelectAllCheatsheets = (checked: boolean) => {
    if (checked) {
      setSelectedCheatsheetIds(new Set(getPaginatedCheatsheets().map(c => c.id)));
    } else {
      setSelectedCheatsheetIds(new Set());
    }
  };

  const toggleQuestionSelection = (id: string) => {
    setSelectedQuestionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMcqQuestionSelection = (id: string) => {
    setSelectedMcqQuestionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSessionSelection = (id: string) => {
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFlashcardSelection = (id: string) => {
    setSelectedFlashcardIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCheatsheetSelection = (id: string) => {
    setSelectedCheatsheetIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openAssignDialog = (type: ContentType, contentId: string | null, bulk: boolean = false) => {
    setAssignType(type);
    setSelectedContentId(contentId);
    setIsBulkAssign(bulk);
    
    if (!bulk && contentId) {
      let assignments: OfferingAssignment[] = [];
      if (type === 'open_question') assignments = openQuestionAssignments[contentId] || [];
      else if (type === 'mcq_question') assignments = mcqQuestionAssignments[contentId] || [];
      else if (type === 'study_session') assignments = studySessionAssignments[contentId] || [];
      else if (type === 'chapter_flashcard') assignments = chapterFlashcardAssignments[contentId] || [];
      else if (type === 'chapter_cheatsheet') assignments = chapterCheatsheetAssignments[contentId] || [];
      
      const currentOfferings = new Set(assignments
        .filter(a => a.published_at !== null)
        .map(a => a.offering_id));
      
      setSelectedOfferings(currentOfferings);
    } else {
      setSelectedOfferings(new Set());
    }
    setAssignDialogOpen(true);
  };

  const handleToggleOffering = (offeringId: string) => {
    setSelectedOfferings(prev => {
      const next = new Set(prev);
      if (next.has(offeringId)) next.delete(offeringId);
      else next.add(offeringId);
      return next;
    });
  };

  const getSelectedIds = (type: ContentType): string[] => {
    if (type === 'open_question') return Array.from(selectedQuestionIds);
    if (type === 'mcq_question') return Array.from(selectedMcqQuestionIds);
    if (type === 'study_session') return Array.from(selectedSessionIds);
    if (type === 'chapter_cheatsheet') return Array.from(selectedCheatsheetIds);
    return Array.from(selectedFlashcardIds);
  };

  const getAssignmentsMap = (type: ContentType): Record<string, OfferingAssignment[]> => {
    if (type === 'open_question') return openQuestionAssignments;
    if (type === 'mcq_question') return mcqQuestionAssignments;
    if (type === 'study_session') return studySessionAssignments;
    if (type === 'chapter_cheatsheet') return chapterCheatsheetAssignments;
    return chapterFlashcardAssignments;
  };

  const getTableName = (type: ContentType): string => {
    // After #582 open + MCQ questions share `offering_questions`.
    if (type === 'open_question' || type === 'mcq_question') return 'offering_questions';
    if (type === 'study_session') return 'offering_study_sessions';
    if (type === 'chapter_cheatsheet') return 'offering_chapter_cheatsheets';
    return 'offering_chapter_flashcards';
  };

  const getIdColumnName = (type: ContentType): string => {
    if (type === 'open_question' || type === 'mcq_question') return 'question_id';
    if (type === 'study_session') return 'study_session_id';
    if (type === 'chapter_cheatsheet') return 'chapter_id';
    return 'chapter_id';
  };

  const handleSaveAssignments = async () => {
    setSaving(true);
    try {
      const contentIds = isBulkAssign 
        ? getSelectedIds(assignType)
        : (selectedContentId ? [selectedContentId] : []);
      
      if (contentIds.length === 0) {
        toast.error("No items selected");
        return;
      }

      const tableName = getTableName(assignType);
      const idColumn = getIdColumnName(assignType);
      const assignmentsMap = getAssignmentsMap(assignType);

      for (const contentId of contentIds) {
        const currentAssignments = assignmentsMap[contentId] || [];
        const currentOfferingIds = new Set(currentAssignments.map(a => a.offering_id));
        const allOfferingIds = classes.map(c => c.offering_id);
        
        for (const offeringId of allOfferingIds) {
          const isCurrentlyAssigned = currentAssignments.find(a => a.offering_id === offeringId && a.published_at !== null);
          const shouldBeAssigned = selectedOfferings.has(offeringId);
          
          if (shouldBeAssigned && !isCurrentlyAssigned) {
            const { error } = await supabase
              .from(tableName as any)
              .upsert({
                [idColumn]: contentId,
                offering_id: offeringId,
                published_at: new Date().toISOString(),
              }, { onConflict: `offering_id,${idColumn}` });
            if (error) throw error;
          } else if (!shouldBeAssigned && !isBulkAssign && currentOfferingIds.has(offeringId)) {
            const { error } = await supabase
              .from(tableName as any)
              .delete()
              .eq(idColumn, contentId)
              .eq("offering_id", offeringId);
            if (error) throw error;
          }
        }
      }
      
      toast.success(isBulkAssign ? `${contentIds.length} items assigned` : "Assignments updated");
      setAssignDialogOpen(false);
      setSelectedQuestionIds(new Set());
      setSelectedMcqQuestionIds(new Set());
      setSelectedSessionIds(new Set());
      setSelectedFlashcardIds(new Set());
      fetchData();
    } catch (error: any) {
      console.error("Error saving assignments:", error);
      toast.error(error.message || "Failed to save assignments");
    } finally {
      setSaving(false);
    }
  };

  const handleBulkUnassign = async (type: ContentType) => {
    const contentIds = getSelectedIds(type);
    
    if (contentIds.length === 0) {
      toast.error("No items selected");
      return;
    }

    const tableName = getTableName(type);
    const idColumn = getIdColumnName(type);

    setSaving(true);
    try {
      for (const contentId of contentIds) {
        const { error } = await supabase
          .from(tableName as any)
          .delete()
          .eq(idColumn, contentId);
        if (error) throw error;
      }
      
      toast.success(`${contentIds.length} items unassigned from all classes`);
      setSelectedQuestionIds(new Set());
      setSelectedMcqQuestionIds(new Set());
      setSelectedSessionIds(new Set());
      setSelectedFlashcardIds(new Set());
      fetchData();
    } catch (error: any) {
      console.error("Error bulk unassigning:", error);
      toast.error(error.message || "Failed to unassign");
    } finally {
      setSaving(false);
    }
  };

  const getPublishedClassNames = (type: ContentType, contentId: string): string[] => {
    const assignmentsMap = getAssignmentsMap(type);
    const assignments = assignmentsMap[contentId] || [];
    
    const publishedOfferingIds = assignments
      .filter(a => a.published_at !== null)
      .map(a => a.offering_id);
    
    return classes
      .filter(c => publishedOfferingIds.includes(c.offering_id))
      .map(c => buildClassDisplayName(c));
  };

  const paginatedQuestions = getPaginatedQuestions();
  const paginatedMcqQuestions = getPaginatedMcqQuestions();
  const paginatedSessions = getPaginatedSessions();
  const paginatedFlashcards = getPaginatedFlashcards();
  const paginatedCheatsheets = getPaginatedCheatsheets();
  const allQuestionsOnPageSelected = paginatedQuestions.length > 0 && paginatedQuestions.every(q => selectedQuestionIds.has(q.id));
  const allMcqQuestionsOnPageSelected = paginatedMcqQuestions.length > 0 && paginatedMcqQuestions.every(q => selectedMcqQuestionIds.has(q.id));
  const allSessionsOnPageSelected = paginatedSessions.length > 0 && paginatedSessions.every(s => selectedSessionIds.has(s.id));
  const allFlashcardsOnPageSelected = paginatedFlashcards.length > 0 && paginatedFlashcards.every(f => selectedFlashcardIds.has(f.id));
  const allCheatsheetsOnPageSelected = paginatedCheatsheets.length > 0 && paginatedCheatsheets.every(c => selectedCheatsheetIds.has(c.id));

  const getDialogTitle = () => {
    if (isBulkAssign) {
      const count = getSelectedIds(assignType).length;
      return `Assign ${count} Items to Classes`;
    }
    return 'Assign to Classes';
  };

  const getDialogDescription = () => {
    const typeLabel = assignType === 'open_question' ? 'open questions' : 
                      assignType === 'mcq_question' ? 'MCQ questions' :
                      assignType === 'study_session' ? 'sessions' : 
                      assignType === 'chapter_cheatsheet' ? 'cheatsheets' : 'flashcard sets';
    if (isBulkAssign) {
      return `Select classes to assign the selected ${typeLabel} to.`;
    }
    return `Select which classes should have access to this content.`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (classes.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Users className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">
            No classes available. Create a class first to assign AI content.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        {!singleTab && (
          <TabsList className="mb-4">
            <TabsTrigger value="mcq-questions" className="flex items-center gap-2">
              <Layers className="w-4 h-4" />
              MCQ Questions ({mcqQuestions.length})
            </TabsTrigger>
            <TabsTrigger value="open-questions" className="flex items-center gap-2">
              <MessageSquareText className="w-4 h-4" />
              Open Questions ({openQuestions.length})
            </TabsTrigger>
            <TabsTrigger value="study-sessions" className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Tutoring Sessions ({studySessions.length})
            </TabsTrigger>
            <TabsTrigger value="flashcards" className="flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Flashcards ({chapterFlashcards.length})
            </TabsTrigger>
            <TabsTrigger value="cheatsheets" className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Cheatsheets ({chapterCheatsheets.length})
            </TabsTrigger>
          </TabsList>
        )}

        {/* MCQ Questions Tab */}
        <TabsContent value="mcq-questions">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Layers className="w-5 h-5" />
                    MCQ Questions
                  </CardTitle>
                  <CardDescription>
                    Publish MCQ questions to specific classes.
                  </CardDescription>
                </div>
                {selectedMcqQuestionIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {selectedMcqQuestionIds.size} selected
                    </span>
                    <Button size="sm" onClick={() => openAssignDialog('mcq_question', null, true)}>
                      <Users className="w-4 h-4 mr-2" />
                      Assign to Classes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleBulkUnassign('mcq_question')} disabled={saving}>
                      Unassign All
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {mcqQuestions.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No MCQ questions available. Create questions in the Content tab first.
                </p>
              ) : (
                <>
                  {/* Filters and Sorting */}
                  <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <ArrowUpDown className="w-4 h-4 text-muted-foreground" />
                      <Select value={mcqSortOrder} onValueChange={(v: 'newest' | 'oldest') => { setMcqSortOrder(v); setMcqQuestionsPage(1); }}>
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="newest">Newest first</SelectItem>
                          <SelectItem value="oldest">Oldest first</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Filter className="w-4 h-4 text-muted-foreground" />
                      <Select value={mcqDifficultyFilter} onValueChange={(v) => { setMcqDifficultyFilter(v); setMcqQuestionsPage(1); }}>
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue placeholder="Difficulty" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All difficulties</SelectItem>
                          <SelectItem value="easy">Easy</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="hard">Hard</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={mcqAssignmentFilter} onValueChange={(v: 'all' | 'assigned' | 'unassigned') => { setMcqAssignmentFilter(v); setMcqQuestionsPage(1); }}>
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="assigned">Assigned</SelectItem>
                          <SelectItem value="unassigned">Unassigned</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {chapters.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Select value={mcqChapterFilter} onValueChange={(v) => { setMcqChapterFilter(v); setMcqQuestionsPage(1); }}>
                          <SelectTrigger className="w-[180px] h-8">
                            <SelectValue placeholder="Chapter" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Chapters</SelectItem>
                            {chapters.map(ch => (
                              <SelectItem key={ch.id} value={ch.id}>
                                {ch.material_title ? `${ch.material_title}: ${ch.title}` : ch.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {competencies.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Select value={mcqCompetencyFilter} onValueChange={(v) => { setMcqCompetencyFilter(v); setMcqQuestionsPage(1); }}>
                          <SelectTrigger className="w-[180px] h-8">
                            <SelectValue placeholder="Competency" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Competencies</SelectItem>
                            {competencies.map(c => (
                              <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <span className="text-sm text-muted-foreground ml-auto">
                      {filteredMcqQuestions.length} of {mcqQuestions.length} questions
                    </span>
                  </div>

                  {filteredMcqQuestions.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No questions match the current filters.
                    </p>
                  ) : (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[50px]">
                              <Checkbox checked={allMcqQuestionsOnPageSelected} onCheckedChange={handleSelectAllMcqQuestions} />
                            </TableHead>
                            <TableHead className="w-[40px]"></TableHead>
                            <TableHead className="w-[35%]">Question</TableHead>
                            <TableHead>Difficulty</TableHead>
                            <TableHead>Classes</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedMcqQuestions.map((question) => (
                            <Collapsible key={question.id} open={expandedMcqIds.has(question.id)} onOpenChange={() => toggleMcqExpanded(question.id)} asChild>
                              <>
                                <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => toggleMcqExpanded(question.id)}>
                                  <TableCell onClick={(e) => e.stopPropagation()}>
                                    <Checkbox checked={selectedMcqQuestionIds.has(question.id)} onCheckedChange={() => toggleMcqQuestionSelection(question.id)} />
                                  </TableCell>
                                  <TableCell>
                                    <CollapsibleTrigger asChild>
                                      <Button variant="ghost" size="sm" className="p-0 h-6 w-6">
                                        {expandedMcqIds.has(question.id) ? (
                                          <ChevronUp className="w-4 h-4" />
                                        ) : (
                                          <ChevronDown className="w-4 h-4" />
                                        )}
                                      </Button>
                                    </CollapsibleTrigger>
                                  </TableCell>
                                  <TableCell className="font-medium">
                                    <p className="line-clamp-2 text-sm" dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }} />
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline">{question.difficulty}</Badge>
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex flex-wrap items-center gap-1">
                                      {getPublishedClassNames('mcq_question', question.id).length > 0 ? (
                                        getPublishedClassNames('mcq_question', question.id).map((name) => (
                                          <Badge key={name} variant="secondary" className="text-xs">{name}</Badge>
                                        ))
                                      ) : (
                                        <span className="text-muted-foreground text-sm">None</span>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                    <Button variant="outline" size="sm" onClick={() => openAssignDialog('mcq_question', question.id)}>
                                      <Users className="w-4 h-4 mr-2" />
                                      Assign
                                    </Button>
                                  </TableCell>
                                </TableRow>
                                <CollapsibleContent asChild>
                                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                                    <TableCell colSpan={6} className="py-4">
                                      <div className="pl-12 pr-4">
                                        <p className="text-sm whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }} />
                                        <p className="text-xs text-muted-foreground mt-2">
                                          Created: {formatDate(question.created_at)}
                                        </p>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                </CollapsibleContent>
                              </>
                            </Collapsible>
                          ))}
                        </TableBody>
                      </Table>
                      
                      {totalMcqQuestionsPages > 1 && (
                        <div className="flex items-center justify-between mt-4">
                          <p className="text-sm text-muted-foreground">Page {mcqQuestionsPage} of {totalMcqQuestionsPages}</p>
                          <Pagination>
                            <PaginationContent>
                              <PaginationItem>
                                <Button variant="outline" size="sm" onClick={() => setMcqQuestionsPage(p => Math.max(1, p - 1))} disabled={mcqQuestionsPage === 1}>
                                  <ChevronLeft className="w-4 h-4" />
                                </Button>
                              </PaginationItem>
                              {Array.from({ length: Math.min(5, totalMcqQuestionsPages) }, (_, i) => (
                                <PaginationItem key={i + 1}>
                                  <PaginationLink onClick={() => setMcqQuestionsPage(i + 1)} isActive={mcqQuestionsPage === i + 1}>{i + 1}</PaginationLink>
                                </PaginationItem>
                              ))}
                              <PaginationItem>
                                <Button variant="outline" size="sm" onClick={() => setMcqQuestionsPage(p => Math.min(totalMcqQuestionsPages, p + 1))} disabled={mcqQuestionsPage === totalMcqQuestionsPages}>
                                  <ChevronRight className="w-4 h-4" />
                                </Button>
                              </PaginationItem>
                            </PaginationContent>
                          </Pagination>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Open Questions Tab */}
        <TabsContent value="open-questions">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <MessageSquareText className="w-5 h-5" />
                    Open Questions
                  </CardTitle>
                  <CardDescription>
                    Publish open questions to specific classes.
                  </CardDescription>
                </div>
                {selectedQuestionIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {selectedQuestionIds.size} selected
                    </span>
                    <Button size="sm" onClick={() => openAssignDialog('open_question', null, true)}>
                      <Users className="w-4 h-4 mr-2" />
                      Assign to Classes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleBulkUnassign('open_question')} disabled={saving}>
                      Unassign All
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {openQuestions.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No open questions available. Create questions in the Content tab first.
                </p>
              ) : (
                <>
                  {/* Filters and Sorting */}
                  <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-muted/50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <ArrowUpDown className="w-4 h-4 text-muted-foreground" />
                      <Select value={openSortOrder} onValueChange={(v: 'newest' | 'oldest') => { setOpenSortOrder(v); setQuestionsPage(1); }}>
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="newest">Newest first</SelectItem>
                          <SelectItem value="oldest">Oldest first</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Filter className="w-4 h-4 text-muted-foreground" />
                      <Select value={openDifficultyFilter} onValueChange={(v) => { setOpenDifficultyFilter(v); setQuestionsPage(1); }}>
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue placeholder="Difficulty" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All difficulties</SelectItem>
                          <SelectItem value="easy">Easy</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="hard">Hard</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Select value={openAssignmentFilter} onValueChange={(v: 'all' | 'assigned' | 'unassigned') => { setOpenAssignmentFilter(v); setQuestionsPage(1); }}>
                        <SelectTrigger className="w-[130px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="assigned">Assigned</SelectItem>
                          <SelectItem value="unassigned">Unassigned</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {chapters.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Select value={openChapterFilter} onValueChange={(v) => { setOpenChapterFilter(v); setQuestionsPage(1); }}>
                          <SelectTrigger className="w-[180px] h-8">
                            <SelectValue placeholder="Chapter" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Chapters</SelectItem>
                            {chapters.map(ch => (
                              <SelectItem key={ch.id} value={ch.id}>
                                {ch.material_title ? `${ch.material_title}: ${ch.title}` : ch.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {competencies.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Select value={openCompetencyFilter} onValueChange={(v) => { setOpenCompetencyFilter(v); setQuestionsPage(1); }}>
                          <SelectTrigger className="w-[180px] h-8">
                            <SelectValue placeholder="Competency" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Competencies</SelectItem>
                            {competencies.map(c => (
                              <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <span className="text-sm text-muted-foreground ml-auto">
                      {filteredOpenQuestions.length} of {openQuestions.length} questions
                    </span>
                  </div>

                  {filteredOpenQuestions.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">
                      No questions match the current filters.
                    </p>
                  ) : (
                    <>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[50px]">
                              <Checkbox checked={allQuestionsOnPageSelected} onCheckedChange={handleSelectAllQuestions} />
                            </TableHead>
                            <TableHead className="w-[40px]"></TableHead>
                            <TableHead className="w-[35%]">Question</TableHead>
                            <TableHead>Difficulty</TableHead>
                            <TableHead>Classes</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedQuestions.map((question) => (
                            <Collapsible key={question.id} open={expandedOpenIds.has(question.id)} onOpenChange={() => toggleOpenExpanded(question.id)} asChild>
                              <>
                                <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => toggleOpenExpanded(question.id)}>
                                  <TableCell onClick={(e) => e.stopPropagation()}>
                                    <Checkbox checked={selectedQuestionIds.has(question.id)} onCheckedChange={() => toggleQuestionSelection(question.id)} />
                                  </TableCell>
                                  <TableCell>
                                    <CollapsibleTrigger asChild>
                                      <Button variant="ghost" size="sm" className="p-0 h-6 w-6">
                                        {expandedOpenIds.has(question.id) ? (
                                          <ChevronUp className="w-4 h-4" />
                                        ) : (
                                          <ChevronDown className="w-4 h-4" />
                                        )}
                                      </Button>
                                    </CollapsibleTrigger>
                                  </TableCell>
                                  <TableCell className="font-medium">
                                    <p className="line-clamp-2 text-sm" dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }} />
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant="outline">{question.difficulty}</Badge>
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex flex-wrap items-center gap-1">
                                      {getPublishedClassNames('open_question', question.id).length > 0 ? (
                                        getPublishedClassNames('open_question', question.id).map((name) => (
                                          <Badge key={name} variant="secondary" className="text-xs">{name}</Badge>
                                        ))
                                      ) : (
                                        <span className="text-muted-foreground text-sm">None</span>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                                    <Button variant="outline" size="sm" onClick={() => openAssignDialog('open_question', question.id)}>
                                      <Users className="w-4 h-4 mr-2" />
                                      Assign
                                    </Button>
                                  </TableCell>
                                </TableRow>
                                <CollapsibleContent asChild>
                                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                                    <TableCell colSpan={6} className="py-4">
                                      <div className="pl-12 pr-4">
                                        <p className="text-sm whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: processLatexContent(question.question) }} />
                                        <p className="text-xs text-muted-foreground mt-2">
                                          Created: {formatDate(question.created_at)}
                                        </p>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                </CollapsibleContent>
                              </>
                            </Collapsible>
                          ))}
                        </TableBody>
                      </Table>
                      
                      {totalQuestionsPages > 1 && (
                        <div className="flex items-center justify-between mt-4">
                          <p className="text-sm text-muted-foreground">Page {questionsPage} of {totalQuestionsPages}</p>
                          <Pagination>
                            <PaginationContent>
                              <PaginationItem>
                                <Button variant="outline" size="sm" onClick={() => setQuestionsPage(p => Math.max(1, p - 1))} disabled={questionsPage === 1}>
                                  <ChevronLeft className="w-4 h-4" />
                                </Button>
                              </PaginationItem>
                              {Array.from({ length: Math.min(5, totalQuestionsPages) }, (_, i) => (
                                <PaginationItem key={i + 1}>
                                  <PaginationLink onClick={() => setQuestionsPage(i + 1)} isActive={questionsPage === i + 1}>{i + 1}</PaginationLink>
                                </PaginationItem>
                              ))}
                              <PaginationItem>
                                <Button variant="outline" size="sm" onClick={() => setQuestionsPage(p => Math.min(totalQuestionsPages, p + 1))} disabled={questionsPage === totalQuestionsPages}>
                                  <ChevronRight className="w-4 h-4" />
                                </Button>
                              </PaginationItem>
                            </PaginationContent>
                          </Pagination>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tutoring Sessions Tab */}
        <TabsContent value="study-sessions">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5" />
                    Tutoring Sessions
                  </CardTitle>
                  <CardDescription>
                    Publish tutoring sessions to specific classes. Only course-level ready sessions are shown.
                  </CardDescription>
                </div>
                {selectedSessionIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{selectedSessionIds.size} selected</span>
                    <Button size="sm" onClick={() => openAssignDialog('study_session', null, true)}>
                      <Users className="w-4 h-4 mr-2" />
                      Assign to Classes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleBulkUnassign('study_session')} disabled={saving}>
                      Unassign All
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {studySessions.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No tutoring sessions available. Create sessions in the Content tab first.
                </p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[50px]">
                          <Checkbox checked={allSessionsOnPageSelected} onCheckedChange={handleSelectAllSessions} />
                        </TableHead>
                        <TableHead className="w-[35%]">Title</TableHead>
                        <TableHead>Topic</TableHead>
                        <TableHead>Classes</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedSessions.map((session) => (
                        <TableRow key={session.id}>
                          <TableCell>
                            <Checkbox checked={selectedSessionIds.has(session.id)} onCheckedChange={() => toggleSessionSelection(session.id)} />
                          </TableCell>
                          <TableCell className="font-medium">{session.title}</TableCell>
                          <TableCell>
                            <span className="text-muted-foreground text-sm">{session.topic || "—"}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1">
                              {getPublishedClassNames('study_session', session.id).length > 0 ? (
                                getPublishedClassNames('study_session', session.id).map((name) => (
                                  <Badge key={name} variant="secondary" className="text-xs">{name}</Badge>
                                ))
                              ) : (
                                <span className="text-muted-foreground text-sm">None</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="outline" size="sm" onClick={() => openAssignDialog('study_session', session.id)}>
                              <Users className="w-4 h-4 mr-2" />
                              Assign
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  
                  {totalSessionsPages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-sm text-muted-foreground">Page {sessionsPage} of {totalSessionsPages}</p>
                      <Pagination>
                        <PaginationContent>
                          <PaginationItem>
                            <Button variant="outline" size="sm" onClick={() => setSessionsPage(p => Math.max(1, p - 1))} disabled={sessionsPage === 1}>
                              <ChevronLeft className="w-4 h-4" />
                            </Button>
                          </PaginationItem>
                          {Array.from({ length: Math.min(5, totalSessionsPages) }, (_, i) => (
                            <PaginationItem key={i + 1}>
                              <PaginationLink onClick={() => setSessionsPage(i + 1)} isActive={sessionsPage === i + 1}>{i + 1}</PaginationLink>
                            </PaginationItem>
                          ))}
                          <PaginationItem>
                            <Button variant="outline" size="sm" onClick={() => setSessionsPage(p => Math.min(totalSessionsPages, p + 1))} disabled={sessionsPage === totalSessionsPages}>
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                          </PaginationItem>
                        </PaginationContent>
                      </Pagination>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Flashcards Tab */}
        <TabsContent value="flashcards">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Layers className="w-5 h-5" />
                    Chapter Flashcards
                  </CardTitle>
                  <CardDescription>
                    Publish chapter flashcards to specific classes. Only visible flashcards are shown.
                  </CardDescription>
                </div>
                {selectedFlashcardIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{selectedFlashcardIds.size} selected</span>
                    <Button size="sm" onClick={() => openAssignDialog('chapter_flashcard', null, true)}>
                      <Users className="w-4 h-4 mr-2" />
                      Assign to Classes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleBulkUnassign('chapter_flashcard')} disabled={saving}>
                      Unassign All
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {chapterFlashcards.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No flashcards available. Generate flashcards from chapters in the AI Tutor tab first.
                </p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[50px]">
                          <Checkbox checked={allFlashcardsOnPageSelected} onCheckedChange={handleSelectAllFlashcards} />
                        </TableHead>
                        <TableHead className="w-[35%]">Chapter</TableHead>
                        <TableHead>Cards</TableHead>
                        <TableHead>Material</TableHead>
                        <TableHead>Classes</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedFlashcards.map((flashcard) => (
                        <TableRow key={flashcard.id}>
                          <TableCell>
                            <Checkbox checked={selectedFlashcardIds.has(flashcard.id)} onCheckedChange={() => toggleFlashcardSelection(flashcard.id)} />
                          </TableCell>
                          <TableCell className="font-medium">{flashcard.title}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{flashcard.flashcard_count} cards</Badge>
                          </TableCell>
                          <TableCell>
                            <span className="text-muted-foreground text-sm">{flashcard.material_title || "—"}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1">
                              {getPublishedClassNames('chapter_flashcard', flashcard.id).length > 0 ? (
                                getPublishedClassNames('chapter_flashcard', flashcard.id).map((name) => (
                                  <Badge key={name} variant="secondary" className="text-xs">{name}</Badge>
                                ))
                              ) : (
                                <span className="text-muted-foreground text-sm">None</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="outline" size="sm" onClick={() => openAssignDialog('chapter_flashcard', flashcard.id)}>
                              <Users className="w-4 h-4 mr-2" />
                              Assign
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  
                  {totalFlashcardsPages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-sm text-muted-foreground">Page {flashcardsPage} of {totalFlashcardsPages}</p>
                      <Pagination>
                        <PaginationContent>
                          <PaginationItem>
                            <Button variant="outline" size="sm" onClick={() => setFlashcardsPage(p => Math.max(1, p - 1))} disabled={flashcardsPage === 1}>
                              <ChevronLeft className="w-4 h-4" />
                            </Button>
                          </PaginationItem>
                          {Array.from({ length: Math.min(5, totalFlashcardsPages) }, (_, i) => (
                            <PaginationItem key={i + 1}>
                              <PaginationLink onClick={() => setFlashcardsPage(i + 1)} isActive={flashcardsPage === i + 1}>{i + 1}</PaginationLink>
                            </PaginationItem>
                          ))}
                          <PaginationItem>
                            <Button variant="outline" size="sm" onClick={() => setFlashcardsPage(p => Math.min(totalFlashcardsPages, p + 1))} disabled={flashcardsPage === totalFlashcardsPages}>
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                          </PaginationItem>
                        </PaginationContent>
                      </Pagination>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Cheatsheets Tab */}
        <TabsContent value="cheatsheets">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="w-5 h-5" />
                    Chapter Cheatsheets
                  </CardTitle>
                  <CardDescription>
                    Publish chapter cheatsheets to specific classes. Only visible cheatsheets are shown.
                  </CardDescription>
                </div>
                {selectedCheatsheetIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">{selectedCheatsheetIds.size} selected</span>
                    <Button size="sm" onClick={() => openAssignDialog('chapter_cheatsheet', null, true)}>
                      <Users className="w-4 h-4 mr-2" />
                      Assign to Classes
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => handleBulkUnassign('chapter_cheatsheet')} disabled={saving}>
                      Unassign All
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {chapterCheatsheets.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">
                  No cheatsheets available. Generate cheatsheets from chapters in the AI Tutor tab first.
                </p>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[50px]">
                          <Checkbox checked={allCheatsheetsOnPageSelected} onCheckedChange={handleSelectAllCheatsheets} />
                        </TableHead>
                        <TableHead className="w-[35%]">Chapter</TableHead>
                        <TableHead>Material</TableHead>
                        <TableHead>Classes</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedCheatsheets.map((cheatsheet) => (
                        <TableRow key={cheatsheet.id}>
                          <TableCell>
                            <Checkbox checked={selectedCheatsheetIds.has(cheatsheet.id)} onCheckedChange={() => toggleCheatsheetSelection(cheatsheet.id)} />
                          </TableCell>
                          <TableCell className="font-medium">{cheatsheet.title}</TableCell>
                          <TableCell>
                            <span className="text-muted-foreground text-sm">{cheatsheet.material_title || "—"}</span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1">
                              {getPublishedClassNames('chapter_cheatsheet', cheatsheet.id).length > 0 ? (
                                getPublishedClassNames('chapter_cheatsheet', cheatsheet.id).map((name) => (
                                  <Badge key={name} variant="secondary" className="text-xs">{name}</Badge>
                                ))
                              ) : (
                                <span className="text-muted-foreground text-sm">None</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="outline" size="sm" onClick={() => openAssignDialog('chapter_cheatsheet', cheatsheet.id)}>
                              <Users className="w-4 h-4 mr-2" />
                              Assign
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  
                  {totalCheatsheetsPages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-sm text-muted-foreground">Page {cheatsheetsPage} of {totalCheatsheetsPages}</p>
                      <Pagination>
                        <PaginationContent>
                          <PaginationItem>
                            <Button variant="outline" size="sm" onClick={() => setCheatsheetsPage(p => Math.max(1, p - 1))} disabled={cheatsheetsPage === 1}>
                              <ChevronLeft className="w-4 h-4" />
                            </Button>
                          </PaginationItem>
                          {Array.from({ length: Math.min(5, totalCheatsheetsPages) }, (_, i) => (
                            <PaginationItem key={i + 1}>
                              <PaginationLink onClick={() => setCheatsheetsPage(i + 1)} isActive={cheatsheetsPage === i + 1}>{i + 1}</PaginationLink>
                            </PaginationItem>
                          ))}
                          <PaginationItem>
                            <Button variant="outline" size="sm" onClick={() => setCheatsheetsPage(p => Math.min(totalCheatsheetsPages, p + 1))} disabled={cheatsheetsPage === totalCheatsheetsPages}>
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                          </PaginationItem>
                        </PaginationContent>
                      </Pagination>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Assign to Classes Dialog */}
      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{getDialogTitle()}</DialogTitle>
            <DialogDescription>{getDialogDescription()}</DialogDescription>
          </DialogHeader>
          
          <ScrollArea className="max-h-[400px]">
            <div className="space-y-3 p-1">
              {classes.map((cls) => {
                const isSelected = selectedOfferings.has(cls.offering_id);
                return (
                  <div
                    key={cls.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Checkbox id={cls.id} checked={isSelected} onCheckedChange={() => handleToggleOffering(cls.offering_id)} />
                      <label htmlFor={cls.id} className="cursor-pointer">
                        <p className="font-medium">{buildClassDisplayName(cls)}</p>
                        {cls.academic_period && (
                          <p className="text-xs text-muted-foreground">{cls.academic_period}</p>
                        )}
                      </label>
                    </div>
                    {isSelected ? (
                      <Check className="w-4 h-4 text-primary" />
                    ) : (
                      <X className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveAssignments} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
