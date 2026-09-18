import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useUserInstitution } from "@/hooks/useUserInstitution";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { InstructorHomeButton } from "@/components/InstructorHomeButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  DialogTrigger,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  BookOpen,
  BookText,
  Edit,
  FileText,
  Upload,
  Trash2,
  Download,
  Loader2,
  File,
  Eye,
  Plus,
  Check,
  Users,
  HelpCircle,
  History,
  Layers,
  Trophy,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Link as LinkIcon,
  Image,
  FileType,
  ClipboardList,
  MessagesSquare,
  Sparkles,
  GraduationCap,
  Languages,
  Cloud,
  CloudOff,
  PenLine,
  Power,
  CheckCircle,
  Clock,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Database,
  Target,
  BarChart2,
  School,
  UsersRound,
  Settings2,
  ThumbsUp,
  TrendingUp,
  Megaphone,
  StickyNote,
  Bot,
  Link2,
  Globe,
  Youtube,
  ImagePlus,
} from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import AIInteractiveQuestions from "@/components/AIInteractiveQuestions";
import UnifiedQuestionBank from "@/components/UnifiedQuestionBank";
import OpenQuestionChatHistory from "@/components/OpenQuestionChatHistory";
import QuizHistory from "@/components/QuizHistory";
import MaterialChaptersWizard from "@/components/MaterialChaptersWizard";
import {
  MaterialUploadDialog,
  MATERIAL_TYPE_LABELS,
  MATERIAL_TYPE_ORDER,
  CHAPTERLESS_MATERIAL_TYPES,
  WHOLE_DOCUMENT_MATERIAL_TYPE,
  type MaterialType,
} from "@/components/MaterialUploadDialog";
import {
  asModerationStatus,
  moderationPatch,
  MODERATION_APPROVED,
  type ModerationStatus,
} from "@/lib/material-moderation";
import { ImageUploadDialog } from "@/components/ImageUploadDialog";
import { GenerateImageDialog } from "@/components/GenerateImageDialog";
import { UrlImportDialog } from "@/components/UrlImportDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IMPORT_KIND_COPY, type ImportKind } from "@/lib/url-import";
import { MarkdownContent } from "@/components/announcements/MarkdownContent";
import { isImageFile, isTextMaterial, opensInPdfViewer } from "@/lib/material-files";
import { QuizManager } from "@/components/QuizManager";
import CheatSheetViewer from "@/components/CheatSheetViewer";
import { StudyGuideManager } from "@/components/StudyGuideManager";
import FlashcardViewer from "@/components/FlashcardViewer";
import { toast } from "sonner";
import { StudySessionManager } from "@/components/StudySessionManager";
import { FlashcardManager } from "@/components/FlashcardManager";
import Student360 from "@/components/Student360";
import { QuizPerformanceList } from "@/components/class-performance/QuizPerformanceList";
import { StudyGuidePerformanceList } from "@/components/class-performance/StudyGuidePerformanceList";
import { CourseEvaluationsReport } from "@/components/course-evaluations/CourseEvaluationsReport";
import QuestionFeedback from "@/components/QuestionFeedback";
import { LANGUAGE_OPTIONS, getLanguageName } from "@/lib/language-options";
import { buildClassDisplayName } from "@/lib/greek-school";
import { useInstitutionGradeLevels } from "@/hooks/useInstitutionGradeLevels";

import { HandwrittenTestGrading } from "@/components/HandwrittenTestGrading";
import { InstructorAnnouncementsTab } from "@/components/announcements";
import { InstructorNotesTab } from "@/components/course-notes";
import { EditableChapterTitle } from "@/components/EditableChapterTitle";
import CourseCompetencies from "@/components/CourseCompetencies";
import { TestBuilder } from "@/components/TestBuilder";
import { TestsAssignmentView } from "@/components/TestsAssignmentView";
import { ChapterStudyMaterialsManager } from "@/components/ChapterStudyMaterialsManager";
import { OfferingGroupsPanel } from "@/components/OfferingGroupsPanel";
import { PdfViewerWithExtract } from "@/components/PdfViewerWithExtract";
import { CourseProgress } from "@/components/CourseProgress";
import { StudentQuestionSettingsSection } from "@/components/StudentQuestionSettings";
import { CourseJobsIndicator } from "@/components/CourseJobsIndicator";
import { BarChart3 } from "lucide-react";
import { useFormatters } from "@/i18n/formatters";


interface Course {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
  institution_id: string;
  created_at: string;
  leaderboard_enabled: boolean;
  student_questions_enabled: boolean;
  restrict_to_completed_chapters: boolean;
  show_difficulty_to_students: boolean;
  language: string | null;
  grade_level_id: string | null;
}

interface CourseMaterial {
  id: string;
  file_name: string;
  file_url: string;
  file_size: number | null;
  created_at: string;
  title: string | null;
  author: string | null;
  year: number | null;
  description: string | null;
  material_type: MaterialType;
  openai_file_id: string | null;
  ai_description: string | null;
  page_count: number | null;
  thumbnail_url: string | null;
  moderation_status: ModerationStatus;
}

interface UserWithAccess {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  institution_role: string;
  sections?: string[];
}

interface CourseClass {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
  academic_period: string | null;
  offering_id: string;
  is_active: boolean;
  student_count?: number;
  instructor_count?: number;
}

interface MaterialChapter {
  id: string;
  material_id: string;
  chapter_number: number;
  title: string;
  content_type: string;
  content: string | null;
  file_url: string | null;
  file_name: string | null;
  cheat_sheet: string | null;
  flashcards: any | null;
  cheat_sheet_visible: boolean;
  flashcards_visible: boolean;
}

const CoursePage = () => {
  const { compareCode, compareText, formatDate } = useFormatters();
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, profile, loading: authLoading } = useAuth();
  const { institutionId, isAdmin: actualIsAdmin, isInstructor: actualIsInstructor, loading: institutionLoading } = useUserInstitution(user?.id);
  const institutionGradeLevels = useInstitutionGradeLevels(institutionId);
  
  // Check if viewing as instructor (admins can simulate instructor view)
  const viewAsInstructor = searchParams.get("view") === "instructor";  const isAdmin = actualIsAdmin && !viewAsInstructor;
  
  // Instructors with proper course access should be able to manage the course
  // canManageCourse = true for admins OR instructors (real instructors have tag access checked by RLS)
  const canManageCourse = isAdmin || actualIsInstructor || viewAsInstructor;

  // Deep links from the instructor home: /course/:id?tab=assessments&sub=quizzes
  // lands on a specific workspace tab. The top-level tab is gated on
  // canManageCourse — the linked tabs only render triggers for managers, and
  // Radix shows an empty body for an unmatched value — and both levels are
  // gated on the known lists, so a stale or copied link degrades to the normal
  // page. Sub-tabs are not gated here: non-managers always land on classwork,
  // and each call site passes only the sub-tabs its viewer can see. Safe to
  // read at first render: the page shows a spinner until the course fetch
  // completes, which itself waits for the institution role to resolve, so
  // canManageCourse is settled by the time the Tabs mount and capture their
  // defaultValue.
  const tabParam = searchParams.get("tab");
  const subParam = searchParams.get("sub");
  const initialTab =
    canManageCourse &&
    tabParam &&
    ["my-unit", "classwork", "ai-tutoring", "assessments", "progress-analytics"].includes(tabParam)
      ? tabParam
      : "classwork";
  const initialSubTab = (parent: string, valid: string[], fallback: string) =>
    initialTab === parent && subParam && valid.includes(subParam)
      ? subParam
      : fallback;
  // Third level, for the tabs nested inside a sub-tab (course-materials →
  // notes, and my-unit → class-performance). Same gating story as above.
  const sub2Param = searchParams.get("sub2");
  const initialSub2Tab = (parent: string, sub: string, valid: string[], fallback: string) =>
    canManageCourse &&
    initialTab === parent &&
    subParam === sub &&
    sub2Param &&
    valid.includes(sub2Param)
      ? sub2Param
      : fallback;
  // ?guide=<id> / ?quiz=<id> open that item's analytics dialog on arrival —
  // the home page's "Analysis & Follow-up" / "See results" prompts. Only meaningful alongside the
  // matching sub-tab; the managers validate the id against their own lists.
  const initialResultsGuideId = canManageCourse ? searchParams.get("guide") : null;
  const initialReportQuizId = canManageCourse ? searchParams.get("quiz") : null;
  // Once a manager consumes its deep link, the param is stripped from the URL
  // (replace, so back-navigation isn't polluted). The managers unmount on
  // every tab switch, so a param left in place would reopen the analytics
  // dialog on each return to the tab — the "keeps popping up" bug.
  const clearAnalyticsDeepLink = useCallback(
    (key: "guide" | "quiz") => {
      setSearchParams(
        (prev) => {
          if (!prev.has(key)) return prev;
          const next = new URLSearchParams(prev);
          next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  
  const [course, setCourse] = useState<Course | null>(null);
  const [materials, setMaterials] = useState<CourseMaterial[]>([]);
  const [usersWithAccess, setUsersWithAccess] = useState<UserWithAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewMaterial, setPreviewMaterial] = useState<CourseMaterial | null>(null);
  /** Set instead of `previewUrl` for a Markdown material, which has no PDF to view. */
  const [previewMarkdown, setPreviewMarkdown] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [imageThumbUrls, setImageThumbUrls] = useState<Record<string, string>>({});
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTheme, setEditTheme] = useState("");
  const [editLeaderboardEnabled, setEditLeaderboardEnabled] = useState(false);
  const [editShowDifficultyToStudents, setEditShowDifficultyToStudents] = useState(true);
  // Upload/Edit dialog state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [imageUploadDialogOpen, setImageUploadDialogOpen] = useState(false);
  const [generateImageDialogOpen, setGenerateImageDialogOpen] = useState(false);
  /**
   * Which import the instructor picked, or null when the dialog is closed.
   *
   * One piece of state rather than an open flag plus a kind: the two cannot
   * then disagree, and the dialog is remounted per kind, which is what clears
   * a half-finished import of the other sort.
   */
  const [urlImportKind, setUrlImportKind] = useState<ImportKind | null>(null);
  const [newMaterialDialogOpen, setNewMaterialDialogOpen] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<CourseMaterial | null>(null);
  
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialAuthor, setMaterialAuthor] = useState("");
  const [materialYear, setMaterialYear] = useState("");
  const [materialDescription, setMaterialDescription] = useState("");
  
  // Chapter wizard state
  const [chaptersWizardOpen, setChaptersWizardOpen] = useState(false);
  const [selectedMaterialForChapters, setSelectedMaterialForChapters] = useState<CourseMaterial | null>(null);
  
  // Chapter viewing state
  const [materialChapters, setMaterialChapters] = useState<Record<string, MaterialChapter[]>>({});
  const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
  const [loadingChapters, setLoadingChapters] = useState<Set<string>>(new Set());
  const [syncingMaterial, setSyncingMaterial] = useState<string | null>(null);
  const [studyMaterialsRefreshKey, setStudyMaterialsRefreshKey] = useState(0);
  const [moderatingImage, setModeratingImage] = useState<string | null>(null);
  const [materialChapterCounts, setMaterialChapterCounts] = useState<Record<string, number>>({});
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [resyncingMetadata, setResyncingMetadata] = useState(false);
  const [generatingThumbnail, setGeneratingThumbnail] = useState<string | null>(null);
  
  // Vector store status state
  const [vectorStoreId, setVectorStoreId] = useState<string | null>(null);
  const [vectorStoreStatuses, setVectorStoreStatuses] = useState<Record<string, {
    inVectorStore: boolean;
    status: string | null;
    lastError: any;
    loading: boolean;
  }>>({});
  const [checkingVectorStatus, setCheckingVectorStatus] = useState<string | null>(null);

  // Classes state
  // null while unknown — the "no competencies" flag on the tab must not
  // flash before the count has actually been read.
  const [competencyCount, setCompetencyCount] = useState<number | null>(null);
  // The count query below is only a bootstrap for the tab before the panel is
  // mounted. Once the panel has spoken for a course it is authoritative — it
  // sees writes this page never learns about — so a slower query that started
  // earlier must not overwrite what the panel already reported.
  const panelReportedForRef = useRef<string | null>(null);

  const handleCompetencyCount = useCallback(
    (count: number) => {
      panelReportedForRef.current = courseId ?? null;
      setCompetencyCount(count);
    },
    [courseId]
  );

  const [classes, setClasses] = useState<CourseClass[]>([]);
  const [classesLoading, setClassesLoading] = useState(false);
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [classEnrollments, setClassEnrollments] = useState<Record<string, { students: Array<{ user_id: string; full_name: string | null; email: string | null; role: string }>; loading: boolean }>>({});

  // Attach to class state
  const [attachToClassDialogOpen, setAttachToClassDialogOpen] = useState(false);
  const [availableClassesForAttach, setAvailableClassesForAttach] = useState<{id: string; name: string; grade_level_id: string | null; section_name: string | null; academic_period: string | null}[]>([]);
  const [selectedClassIdForAttach, setSelectedClassIdForAttach] = useState<string>("");
  const [attachingToClass, setAttachingToClass] = useState(false);

  // isAdmin now comes from useUserInstitution hook

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  // Check super admin status
  useEffect(() => {
    const checkSuperAdmin = async () => {
      if (!user) return;
      const { data } = await supabase.rpc("is_super_admin", { _user_id: user.id });
      setIsSuperAdmin(data || false);
    };
    if (user) checkSuperAdmin();
  }, [user]);

  useEffect(() => {
    if (courseId && institutionId && !institutionLoading) {
      fetchCourseData();
      fetchClasses();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/institutionId change
  }, [courseId, institutionId, institutionLoading]);

  // Cheap count so the Class Management row can flag an empty competency set
  // without mounting the (lazy, tab-gated) CourseCompetencies panel first.
  useEffect(() => {
    // Start every visit from nothing known. This page is not remounted when
    // courseId changes, so the previous course's count would otherwise decide
    // the marker until the new read lands, and a read that fails would leave
    // it wrong indefinitely. null means "not known yet", which shows no marker
    // either way. Clearing the stamp too is what lets a course revisited later
    // (A → B → A) accept a fresh read instead of standing on what the panel
    // said the first time round.
    panelReportedForRef.current = null;
    setCompetencyCount(null);

    if (!courseId || !canManageCourse) return;
    let cancelled = false;

    (async () => {
      const { count, error } = await supabase
        .from("course_competencies")
        .select("id", { count: "exact", head: true })
        .eq("course_id", courseId);

      if (cancelled || panelReportedForRef.current === courseId) return;
      setCompetencyCount(error ? null : count ?? 0);
    })();

    return () => {
      cancelled = true;
    };
  }, [courseId, canManageCourse]);

  useEffect(() => {
    const imageMaterials = materials.filter((m) => m.material_type === "images" && !!m.file_url);
    const missing = imageMaterials.filter((m) => !imageThumbUrls[m.id]);

    if (missing.length === 0) return;

    let cancelled = false;

    (async () => {
      const results = await Promise.all(
        missing.map(async (m) => {
          const { data, error } = await supabase.storage
            .from("course-materials")
            .createSignedUrl(m.file_url, 60 * 60);

          if (error || !data?.signedUrl) return null;
          return { id: m.id, url: data.signedUrl };
        })
      );

      if (cancelled) return;

      setImageThumbUrls((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (!r) continue;
          next[r.id] = r.url;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [materials, imageThumbUrls]);

  const fetchCourseData = async () => {
    if (!courseId || !institutionId) return;
    setLoading(true);

    try {
      // Fetch course
      const { data: courseData, error: courseError } = await supabase
        .from("courses")
        .select("*")
        .eq("id", courseId)
        .maybeSingle();

      if (courseError) throw courseError;
      if (!courseData) {
        toast.error("Course not found");
        navigate("/dashboard");
        return;
      }

      setCourse(courseData);
      setEditTitle(courseData.title);
      setEditDescription(courseData.description || "");
      setEditTheme(courseData.theme || "");
      setEditLeaderboardEnabled(courseData.leaderboard_enabled || false);
      setEditShowDifficultyToStudents(courseData.show_difficulty_to_students === true);

      // Fetch materials
      const { data: materialsData } = await supabase
        .from("course_materials")
        .select("*")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (materialsData) {
        setMaterials(materialsData.map(m => ({
          ...m,
          material_type: (m.material_type as MaterialType) || 'textbook',
          moderation_status: asModerationStatus(m.moderation_status)
        })));
        
        // Fetch chapter counts for every material that can have chapters
        const chapteredMaterialIds = materialsData
          .filter(m => !CHAPTERLESS_MATERIAL_TYPES.includes(m.material_type as MaterialType))
          .map(m => m.id);

        if (chapteredMaterialIds.length > 0) {
          const { data: chaptersData } = await supabase
            .from("material_chapters")
            .select("material_id")
            .in("material_id", chapteredMaterialIds);
          
          if (chaptersData) {
            const counts: Record<string, number> = {};
            chaptersData.forEach(ch => {
              counts[ch.material_id] = (counts[ch.material_id] || 0) + 1;
            });
            setMaterialChapterCounts(counts);
          }
        }
      }

      // Fetch institution's vector_store_id
      const { data: institutionData } = await supabase
        .from("institutions")
        .select("vector_store_id")
        .eq("id", institutionId)
        .single();
      
      if (institutionData?.vector_store_id) {
        setVectorStoreId(institutionData.vector_store_id);
      }

      // Fetch course instructors from course_instructors table + class enrollments
      if (canManageCourse) {
        // Source 1: explicit course_instructors assignments
        const { data: ciData } = await supabase
          .from("course_instructors")
          .select("user_id")
          .eq("course_id", courseId);

        // Source 2: instructors enrolled in classes that offer this course
        const { data: offeringsData } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("course_id", courseId);

        const classIds = (offeringsData || []).map(o => o.class_id).filter(Boolean);
        let allEnrollData: { user_id: string; class_id: string }[] = [];
        if (classIds.length > 0) {
          const { data: enrollData } = await supabase
            .from("class_enrollments")
            .select("user_id, class_id")
            .in("class_id", classIds)
            .eq("role", "instructor");
          allEnrollData = (enrollData || []) as { user_id: string; class_id: string }[];
        }
        const enrolledInstructorIds = allEnrollData.map(e => e.user_id);

        // Merge both sources
        const allUserIds = [...new Set([
          ...(ciData || []).map(ci => ci.user_id),
          ...enrolledInstructorIds,
        ])];

        if (allUserIds.length > 0) {
          // Get profiles for all instructors
          const { data: profilesData } = await supabase
            .from("profiles")
            .select("id, user_id, full_name, email")
            .in("user_id", allUserIds)
            .order("full_name", { ascending: true });

          // Get section restrictions from course_instructor_sections
          const { data: sectionData } = await supabase
            .from("course_instructor_sections")
            .select("user_id, class_id, classes:class_id ( section_name )")
            .eq("course_id", courseId);

          // Build map: user_id -> section names from explicit restrictions
          const sectionMap = new Map<string, string[]>();
          for (const row of sectionData || []) {
            const arr = sectionMap.get(row.user_id) || [];
            const sectionName = (row.classes as any)?.section_name;
            if (sectionName) arr.push(sectionName);
            sectionMap.set(row.user_id, arr);
          }

          // For instructors from class_enrollments without explicit section restrictions,
          // determine their sections from which classes they're enrolled in
          if (classIds.length > 0) {
            const { data: classesData } = await supabase
              .from("classes")
              .select("id, section_name")
              .in("id", classIds);
            const classNameMap = new Map((classesData || []).map(c => [c.id, c.section_name]));

            const explicitlyRestrictedUsers = new Set(
              (sectionData || []).map(r => r.user_id)
            );

            for (const row of allEnrollData) {
              if (!explicitlyRestrictedUsers.has(row.user_id)) {
                const arr = sectionMap.get(row.user_id) || [];
                const name = classNameMap.get(row.class_id);
                if (name && !arr.includes(name)) arr.push(name);
                sectionMap.set(row.user_id, arr);
              }
            }
          }

          if (profilesData) {
            const instructors = profilesData.map(p => ({
              ...p,
              institution_role: 'instructor' as string,
              sections: sectionMap.get(p.user_id) || [],
            }));
            setUsersWithAccess(instructors);
          } else {
            setUsersWithAccess([]);
          }
        } else {
          setUsersWithAccess([]);
        }
      } else {
        setUsersWithAccess([]);
      }
    } catch (error: any) {
      console.error("Error fetching course data:", error);
      toast.error("Failed to load course");
    } finally {
      setLoading(false);
    }
  };

  const fetchClasses = async () => {
    if (!courseId || !institutionId) return;
    setClassesLoading(true);

    try {
      // Fetch offerings for this course with their class info
      const { data: offeringsData, error: offeringsError } = await supabase
        .from("offerings")
        .select(`
          id,
          is_active,
          classes:class_id (
            id,
            name,
            grade_level_id,
            section_name,
            category,
            academic_period,
            is_active
          )
        `)
        .eq("course_id", courseId);

      if (offeringsError) throw offeringsError;

      if (offeringsData) {
        // Only show classes where the class is active (for content assignment)
        let classesWithOfferings: CourseClass[] = offeringsData
          .filter(o => o.classes && (o.classes as any).is_active === true)
          .map(o => ({
            id: (o.classes as any).id,
            name: (o.classes as any).name,
            grade_level_id: (o.classes as any).grade_level_id,
            section_name: (o.classes as any).section_name,
            category: (o.classes as any).category,
            academic_period: (o.classes as any).academic_period,
            offering_id: o.id,
            is_active: o.is_active ?? true,
          }));

        // Filter by section restrictions for non-admin instructors
        if (!isAdmin && user?.id) {
          const { data: sectionRestrictions } = await supabase
            .from("course_instructor_sections")
            .select("class_id")
            .eq("course_id", courseId)
            .eq("user_id", user.id);

          if (sectionRestrictions && sectionRestrictions.length > 0) {
            const allowedClassIds = new Set(sectionRestrictions.map(r => r.class_id));
            classesWithOfferings = classesWithOfferings.filter(c => allowedClassIds.has(c.id));
          }
        }

        // Sort by grade_level_id first (FK identity), then by section name.
        // Institution ordering could be applied later via a grade_levels join.
        classesWithOfferings.sort((a, b) => {
          const gradeCompare = compareCode((a.grade_level_id || ''), b.grade_level_id || '');
          if (gradeCompare !== 0) return gradeCompare;
          return compareText((a.section_name || ''), b.section_name || '');
        });
        setClasses(classesWithOfferings);
      }
    } catch (error: any) {
      console.error("Error fetching classes:", error);
      toast.error("Failed to load classes");
    } finally {
      setClassesLoading(false);
    }
  };

  const fetchClassEnrollments = async (classId: string) => {
    if (classEnrollments[classId]?.students) return; // Already fetched

    setClassEnrollments(prev => ({
      ...prev,
      [classId]: { students: [], loading: true }
    }));

    try {
      // Fetch enrollments
      const { data: enrollmentData, error: enrollmentError } = await supabase
        .from("class_enrollments")
        .select("user_id, role")
        .eq("class_id", classId);

      if (enrollmentError) throw enrollmentError;

      if (!enrollmentData || enrollmentData.length === 0) {
        setClassEnrollments(prev => ({
          ...prev,
          [classId]: { students: [], loading: false }
        }));
        return;
      }

      // Fetch profiles for enrolled users
      const userIds = enrollmentData.map(e => e.user_id);
      const { data: profilesData, error: profilesError } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", userIds);

      if (profilesError) throw profilesError;

      // Check which users are super-admins to exclude from display
      const superAdminChecks = await Promise.all(
        userIds.map(async (userId) => {
          const { data } = await supabase.rpc("is_super_admin", { _user_id: userId });
          return { userId, isSuperAdmin: data === true };
        })
      );
      const superAdminIds = new Set(
        superAdminChecks.filter(c => c.isSuperAdmin).map(c => c.userId)
      );

      const profilesMap = new Map((profilesData || []).map(p => [p.user_id, p]));

      const students = enrollmentData
        .filter((enrollment) => !superAdminIds.has(enrollment.user_id)) // Exclude super-admins from display
        .map((enrollment) => {
          const profile = profilesMap.get(enrollment.user_id);
          return {
            user_id: enrollment.user_id,
            full_name: profile?.full_name || null,
            email: profile?.email || null,
            role: enrollment.role,
          };
        });

      setClassEnrollments(prev => ({
        ...prev,
        [classId]: { students, loading: false }
      }));
    } catch (error: any) {
      console.error("Error fetching class enrollments:", error);
      setClassEnrollments(prev => ({
        ...prev,
        [classId]: { students: [], loading: false }
      }));
    }
  };

  const toggleClassExpanded = (classId: string) => {
    setExpandedClasses(prev => {
      const newSet = new Set(prev);
      if (newSet.has(classId)) {
        newSet.delete(classId);
      } else {
        newSet.add(classId);
        fetchClassEnrollments(classId);
      }
      return newSet;
    });
  };

  const handleOpenAttachToClass = async () => {
    if (!institutionId || !courseId) return;

    try {
      // Get IDs of classes already attached to this course
      const attachedClassIds = classes.map(c => c.id);

      let availableClasses: {id: string; name: string; grade_level_id: string | null; section_name: string | null; academic_period: string | null}[] = [];

      if (isAdmin || isSuperAdmin) {
        // Admins see all active institution section classes (not parent grade-level classes) not already attached
        const { data, error } = await supabase
          .from("classes")
          .select("id, name, grade_level_id, section_name, academic_period")
          .eq("institution_id", institutionId)
          .eq("is_active", true)
          .not("section_name", "is", null)
          .order("name");

        if (error) throw error;
        availableClasses = (data || []).filter(c => !attachedClassIds.includes(c.id));
      } else if (actualIsInstructor && user?.id) {
        // Instructors see only their classes not already attached
        const { data: enrollments, error } = await supabase
          .from("class_enrollments")
          .select("class_id, classes:class_id(id, name, grade_level_id, section_name, academic_period, is_active, institution_id)")
          .eq("user_id", user.id)
          .eq("role", "instructor");

        if (error) throw error;
        availableClasses = (enrollments || [])
          .map(e => e.classes as any)
          .filter(c => c && c.is_active && c.section_name && c.institution_id === institutionId && !attachedClassIds.includes(c.id))
          .map(c => ({ id: c.id, name: c.name, grade_level_id: c.grade_level_id, section_name: c.section_name, academic_period: c.academic_period }));
      }

      setAvailableClassesForAttach(availableClasses);
      setSelectedClassIdForAttach("");
      setAttachToClassDialogOpen(true);
    } catch (error: any) {
      console.error("Error fetching available classes:", error);
      toast.error("Failed to load available classes");
    }
  };

  const handleAttachToClass = async () => {
    if (!courseId || !selectedClassIdForAttach) return;

    setAttachingToClass(true);
    try {
      const { error } = await supabase
        .from("offerings")
        .insert({
          class_id: selectedClassIdForAttach,
          course_id: courseId,
          is_active: true,
        });

      if (error) throw error;

      toast.success("Course attached to class successfully");
      setAttachToClassDialogOpen(false);
      setSelectedClassIdForAttach("");
      fetchClasses(); // Refresh the classes list
    } catch (error: any) {
      console.error("Error attaching to class:", error);
      toast.error(error.message || "Failed to attach course to class");
    } finally {
      setAttachingToClass(false);
    }
  };

  const handleUpdateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!course) return;

    setIsEditing(true);
    try {
      const { error } = await supabase
        .from("courses")
        .update({
          title: editTitle,
          description: editDescription || null,
          theme: editTheme || null,
          leaderboard_enabled: editLeaderboardEnabled,
        })
        .eq("id", course.id);

      if (error) throw error;

      setCourse({
        ...course,
        title: editTitle,
        description: editDescription || null,
        theme: editTheme || null,
        leaderboard_enabled: editLeaderboardEnabled,
      });
      toast.success("Course updated");
      setEditDialogOpen(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to update course");
    } finally {
      setIsEditing(false);
    }
  };

  const handleToggleLeaderboard = async (enabled: boolean) => {
    if (!course) return;

    try {
      const { error } = await supabase
        .from("courses")
        .update({ leaderboard_enabled: enabled })
        .eq("id", course.id);

      if (error) throw error;

      setCourse({ ...course, leaderboard_enabled: enabled });
      setEditLeaderboardEnabled(enabled);
      toast.success(enabled ? "Leaderboard enabled" : "Leaderboard disabled");
    } catch (error: any) {
      toast.error(error.message || "Failed to update leaderboard setting");
    }
  };

  const handleToggleShowDifficulty = async (enabled: boolean) => {
    if (!course) return;

    try {
      const { error } = await supabase
        .from("courses")
        .update({ show_difficulty_to_students: enabled })
        .eq("id", course.id);

      if (error) throw error;

      setCourse({ ...course, show_difficulty_to_students: enabled });
      setEditShowDifficultyToStudents(enabled);
      toast.success(enabled ? "Difficulty levels visible to students" : "Difficulty levels hidden from students");
    } catch (error: any) {
      toast.error(error.message || "Failed to update setting");
    }
  };

  const handleLanguageChange = async (newLanguage: string) => {
    if (!course) return;

    try {
      // Use null if "inherit" to inherit from institution
      const languageValue = newLanguage === "inherit" ? null : newLanguage;
      const { error } = await supabase
        .from("courses")
        .update({ language: languageValue })
        .eq("id", course.id);

      if (error) throw error;

      setCourse({ ...course, language: languageValue });
      toast.success(newLanguage === "inherit" 
        ? "Course will use institution default language" 
        : `Course language set to ${getLanguageName(newLanguage)}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to update language");
    }
  };

  const handleResetLeaderboard = async () => {
    if (!course) return;

    try {
      const { error } = await supabase
        .from("quiz_answers")
        .delete()
        .eq("course_id", course.id);

      if (error) throw error;

      toast.success("Leaderboard reset successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to reset leaderboard");
    }
  };

  const triggerPdfUpload = () => {
    setNewMaterialDialogOpen(true);
  };

  const openEditMaterialDialog = (material: CourseMaterial) => {
    setEditingMaterial(material);
    setMaterialTitle(material.title || material.file_name);
    setMaterialAuthor(material.author || "");
    setMaterialYear(material.year?.toString() || "");
    setMaterialDescription(material.description || "");
    setUploadDialogOpen(true);
  };

  const handleUpdateMaterial = async () => {
    if (!editingMaterial) return;

    setUploading(true);
    try {
      // Metadata only. The type is not editable here — see the dialog — so the
      // reclassification this used to have to refuse (#1019: retyping a split
      // textbook stranded its chapters) can no longer be asked for.
      const { data, error } = await supabase
        .from("course_materials")
        .update({
          title: materialTitle || null,
          author: materialAuthor || null,
          year: materialYear ? parseInt(materialYear) : null,
          description: materialDescription || null,
        })
        .eq("id", editingMaterial.id)
        .select();

      if (error) throw error;
      if (!data || data.length === 0) throw new Error("Failed to update material");

      // The type comes back from the row that was just written, not from what
      // this dialog was opened with. This write no longer touches it, so the
      // database is the only one who knows it — and someone else may have
      // changed it (`CourseDetail` still reclassifies) while the dialog sat
      // open. Preferring the captured value would file the material under the
      // wrong group until a reload.
      setMaterials(materials.map(m => m.id === editingMaterial.id
        ? {
            ...data[0],
            material_type: (data[0].material_type as MaterialType) || editingMaterial.material_type,
            moderation_status: asModerationStatus(data[0].moderation_status),
          }
        : m));
      toast.success("Material updated");
      setUploadDialogOpen(false);
      setEditingMaterial(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to update material");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteMaterial = async (material: CourseMaterial) => {
    if (!confirm("Are you sure you want to delete this file?")) return;

    try {
      // Delete from OpenAI if synced (also removes from vector store).
      //
      // This must succeed before anything local is removed. `delete-from-openai`
      // resolves the file's owner from the `course_materials` row, so deleting
      // the row after a failed cleanup would strand the OpenAI file and its
      // vector-store attachment with nothing left to attribute them to. Keeping
      // the material intact is what makes the delete retryable.
      if (material.openai_file_id) {
        const { error: openaiError } = await supabase.functions.invoke("delete-from-openai", {
          body: { openaiFileId: material.openai_file_id, courseId },
        });
        if (openaiError) throw new Error("Could not remove the file from OpenAI, so nothing was deleted. Please try again.");
      }

      await supabase.storage
        .from("course-materials")
        .remove([material.file_url]);

      const { error: dbError } = await supabase
        .from("course_materials")
        .delete()
        .eq("id", material.id);

      if (dbError) throw dbError;

      setMaterials(materials.filter((m) => m.id !== material.id));
      toast.success("File deleted");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete file");
    }
  };

  const handleSyncToOpenAI = async (material: CourseMaterial) => {
    setSyncingMaterial(material.id);
    try {
      const { data, error } = await supabase.functions.invoke("upload-to-openai", {
        body: {
          materialId: material.id,
          filePath: material.file_url,
          fileName: material.file_name,
        },
      });

      if (error) throw error;
      
      if (data?.openaiFileId) {
        setMaterials(prev => prev.map(m => 
          m.id === material.id ? { ...m, openai_file_id: data.openaiFileId } : m
        ));
        toast.success("Synced to OpenAI successfully");
      }
    } catch (error: any) {
      console.error("Error syncing to OpenAI:", error);
      toast.error(error.message || "Failed to sync to OpenAI");
    } finally {
      setSyncingMaterial(null);
    }
  };

  const handleResyncMetadata = async () => {
    if (!user || !courseId) return;
    setResyncingMetadata(true);
    try {
      const { data, error } = await supabase.functions.invoke("manage-vector-store", {
        body: { 
          action: "resync-metadata", 
          courseId, 
          userId: user.id 
        },
      });

      if (error) throw error;
      
      if (data?.success) {
        toast.success(data.message || "Metadata resync complete");
      } else {
        throw new Error(data?.error || "Resync failed");
      }
    } catch (error: any) {
      console.error("Error resyncing metadata:", error);
      toast.error(error.message || "Failed to resync metadata");
    } finally {
      setResyncingMetadata(false);
    }
  };

  const fetchChaptersForMaterial = async (materialId: string, force = false) => {
    if (!force && materialChapters[materialId]) return; // Already loaded
    
    setLoadingChapters(prev => new Set(prev).add(materialId));
    
    try {
      const { data, error } = await supabase
        .from("material_chapters")
        .select("*")
        .eq("material_id", materialId)
        .order("chapter_number", { ascending: true }).order("id");

      if (error) throw error;
      
      setMaterialChapters(prev => ({
        ...prev,
        [materialId]: data || []
      }));
    } catch (error: any) {
      console.error("Error fetching chapters:", error);
      toast.error("Failed to load chapters");
    } finally {
      setLoadingChapters(prev => {
        const next = new Set(prev);
        next.delete(materialId);
        return next;
      });
    }
  };

  const toggleMaterialExpanded = async (materialId: string) => {
    const isExpanded = expandedMaterials.has(materialId);
    
    if (!isExpanded) {
      await fetchChaptersForMaterial(materialId);
    }
    
    setExpandedMaterials(prev => {
      const next = new Set(prev);
      if (isExpanded) {
        next.delete(materialId);
      } else {
        next.add(materialId);
      }
      return next;
    });
  };

  const getChapterTypeIcon = (contentType: string) => {
    switch (contentType) {
      case 'html_link':
        return <LinkIcon className="w-4 h-4" />;
      case 'pdf':
        return <FileText className="w-4 h-4" />;
      case 'image':
        return <Image className="w-4 h-4" />;
      case 'text':
      default:
        return <FileType className="w-4 h-4" />;
    }
  };

  const getChapterTypeBadge = (contentType: string) => {
    switch (contentType) {
      case 'html_link':
        return 'Link';
      case 'pdf':
        return 'PDF';
      case 'image':
        return 'Image';
      case 'text':
      default:
        return 'Text';
    }
  };

  const handleDownload = async (material: CourseMaterial) => {
    try {
      const { data, error } = await supabase.storage
        .from("course-materials")
        .download(material.file_url);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const link = document.createElement("a");
      link.href = url;
      link.download = material.file_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast.error("Failed to download file");
    }
  };

  const handlePreview = async (material: CourseMaterial) => {
    // For images, open directly in a new browser tab
    const isImage = isImageFile(material.file_name);

    // Imported links are stored as Markdown (see UrlImportDialog), which the
    // PDF viewer cannot open — they get rendered as text instead.
    if (isTextMaterial(material.file_name)) {
      setPreviewMaterial(material);
      setPreviewLoading(true);
      try {
        const { data, error } = await supabase.storage
          .from("course-materials")
          .download(material.file_url);

        if (error) throw error;

        setPreviewMarkdown(await data.text());
      } catch {
        toast.error("Failed to load preview");
        setPreviewMaterial(null);
      } finally {
        setPreviewLoading(false);
      }
      return;
    }

    if (isImage) {
      try {
        const { data, error } = await supabase.storage
          .from("course-materials")
          .createSignedUrl(material.file_url, 60 * 10); // 10 minutes

        if (error) throw error;

        window.open(data.signedUrl, '_blank');
      } catch (error: any) {
        toast.error("Failed to open image");
      }
      return;
    }

    // For PDFs, use the preview dialog
    setPreviewMaterial(material);
    setPreviewLoading(true);
    
    try {
      const { data, error } = await supabase.storage
        .from("course-materials")
        .download(material.file_url);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      setPreviewUrl(url);
    } catch (error: any) {
      toast.error("Failed to load preview");
      setPreviewMaterial(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewMaterial(null);
    setPreviewUrl(null);
    setPreviewMarkdown(null);
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "Unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const openChaptersWizard = (material: CourseMaterial) => {
    setSelectedMaterialForChapters(material);
    setChaptersWizardOpen(true);
  };

  const handleModerateImage = async (material: CourseMaterial) => {
    if (!material.file_url) {
      toast.error("No image file to moderate");
      return;
    }

    setModeratingImage(material.id);

    try {
      // Get a signed URL for the image
      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from("course-materials")
        .createSignedUrl(material.file_url, 60 * 5); // 5 min validity

      if (signedUrlError || !signedUrlData?.signedUrl) {
        throw new Error("Failed to get image URL");
      }

      // Call the moderation edge function
      const { data, error } = await supabase.functions.invoke("moderate-study-image", {
        body: {
          fileUrl: signedUrlData.signedUrl,
          lang: course?.language || "English",
        },
      });

      if (error) throw error;

      // Both outcomes write the same columns, so the patch is built in one
      // place — see `moderationPatch`. It records the outcome in
      // `moderation_status` and leaves `openai_file_id` alone, which is what
      // makes a moderated image deletable: the delete path only calls
      // `delete-from-openai` for a material that has a real file id. On an
      // approval it also carries a `description`, overriding the uploader's.
      const patch = moderationPatch(data);

      const { error: updateError } = await supabase
        .from("course_materials")
        .update(patch)
        .eq("id", material.id);

      if (updateError) throw updateError;

      setMaterials((prev) =>
        prev.map((m) =>
          m.id === material.id
            ? {
                ...m,
                moderation_status: patch.moderation_status,
                ai_description: patch.ai_description,
                description: patch.description ?? m.description,
              }
            : m
        )
      );

      if (patch.moderation_status === MODERATION_APPROVED) {
        toast.success("Image enabled successfully", {
          description: data.description || undefined,
        });
      } else {
        toast.error("Image rejected", {
          description: `Reason: ${data.reason_category}. ${data.notes || ""}`,
        });
      }
    } catch (error: any) {
      console.error("Error moderating image:", error);
      toast.error(error.message || "Failed to moderate image");
    } finally {
      setModeratingImage(null);
    }
  };

  // Generate PDF thumbnail using ConvertAPI
  const handleGenerateThumbnail = async (material: CourseMaterial) => {
    if (!material.file_url || material.material_type === 'images') {
      return;
    }

    setGeneratingThumbnail(material.id);

    try {
      const { data, error } = await supabase.functions.invoke("generate-pdf-thumbnail", {
        body: {
          filePath: material.file_url,
          bucketName: "course-materials",
        },
      });

      if (error) throw error;

      if (data?.thumbnailUrl) {
        // Save to database
        const { error: updateError } = await supabase
          .from("course_materials")
          .update({ thumbnail_url: data.thumbnailUrl })
          .eq("id", material.id);

        if (updateError) throw updateError;

        // Update local state
        setMaterials((prev) =>
          prev.map((m) =>
            m.id === material.id
              ? { ...m, thumbnail_url: data.thumbnailUrl }
              : m
          )
        );

        toast.success("Thumbnail generated successfully");
      }
    } catch (error: any) {
      console.error("Error generating thumbnail:", error);
      toast.error(error.message || "Failed to generate thumbnail");
    } finally {
      setGeneratingThumbnail(null);
    }
  };

  // Check vector store status for a material
  const checkVectorStoreStatus = async (material: CourseMaterial) => {
    if (!material.openai_file_id || !vectorStoreId) return;
    
    setCheckingVectorStatus(material.id);
    setVectorStoreStatuses(prev => ({
      ...prev,
      [material.id]: { ...prev[material.id], loading: true }
    }));

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-vector-store-file`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            openaiFileId: material.openai_file_id,
            vectorStoreId: vectorStoreId,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to check status');
      }

      const data = await response.json();
      
      setVectorStoreStatuses(prev => ({
        ...prev,
        [material.id]: {
          inVectorStore: data.inVectorStore,
          status: data.status,
          lastError: data.lastError,
          loading: false,
        }
      }));
    } catch (error: any) {
      console.error("Error checking vector store status:", error);
      toast.error(error.message || "Failed to check vector store status");
      setVectorStoreStatuses(prev => ({
        ...prev,
        [material.id]: { inVectorStore: false, status: null, lastError: error.message, loading: false }
      }));
    } finally {
      setCheckingVectorStatus(null);
    }
  };

  // Helper to render vector store status icon
  const renderVectorStoreStatus = (material: CourseMaterial) => {
    const status = vectorStoreStatuses[material.id];
    
    // If no status checked yet, show clickable Cloud icon to check
    if (!status) {
      return (
        <Button
          variant="ghost"
          size="icon"
          className="text-green-600"
          title="Synced to OpenAI - Click to check Vector Store status"
          onClick={() => checkVectorStoreStatus(material)}
          disabled={checkingVectorStatus === material.id}
        >
          {checkingVectorStatus === material.id ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Cloud className="w-4 h-4" />
          )}
        </Button>
      );
    }

    // If loading
    if (status.loading) {
      return (
        <Button variant="ghost" size="icon" disabled>
          <Loader2 className="w-4 h-4 animate-spin" />
        </Button>
      );
    }

    // Not in vector store
    if (!status.inVectorStore) {
      return (
        <Button
          variant="ghost"
          size="icon"
          className="text-amber-600"
          title="File uploaded to OpenAI but NOT in Vector Store. Click to re-check."
          onClick={() => checkVectorStoreStatus(material)}
        >
          <Database className="w-4 h-4" />
          <span className="absolute -top-1 -right-1 text-[10px]">!</span>
        </Button>
      );
    }

    // In vector store - check status
    switch (status.status) {
      case 'completed':
        return (
          <Button
            variant="ghost"
            size="icon"
            className="text-green-600"
            title="Indexed in Vector Store ✓"
            onClick={() => checkVectorStoreStatus(material)}
          >
            <Cloud className="w-4 h-4" />
            <CheckCircle className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5 text-green-600" />
          </Button>
        );
      case 'in_progress':
        return (
          <Button
            variant="ghost"
            size="icon"
            className="text-amber-500"
            title="Indexing in progress..."
            onClick={() => checkVectorStoreStatus(material)}
          >
            <Cloud className="w-4 h-4" />
            <Clock className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5 animate-pulse" />
          </Button>
        );
      case 'failed':
        return (
          <Button
            variant="ghost"
            size="icon"
            className="text-red-500"
            title={`Indexing failed: ${status.lastError?.message || 'Unknown error'}`}
            onClick={() => checkVectorStoreStatus(material)}
          >
            <Cloud className="w-4 h-4" />
            <XCircle className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5" />
          </Button>
        );
      default:
        return (
          <Button
            variant="ghost"
            size="icon"
            className="text-green-600"
            title={`Vector Store status: ${status.status || 'unknown'}`}
            onClick={() => checkVectorStoreStatus(material)}
          >
            <Cloud className="w-4 h-4" />
          </Button>
        );
    }
  };

  // Extraction happens inside the PDF preview (PdfViewerWithExtract), so only
  // PDFs can be a source — never an image, never a Markdown import.
  const extractableMaterials = materials.filter(m => opensInPdfViewer(m.file_name));

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!course) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Course not found</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <nav className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <BrandMark />
            <InstructorHomeButton />
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-6 py-8">
        {/* Course Header */}
        <div className="mb-8">
          <div className="flex items-start justify-between mb-4">
            <div className="flex-1">
              {course.theme && (
                <span className="text-xs px-2 py-1 bg-gold/10 text-gold-dark rounded-full mb-2 inline-block">
                  {course.theme}
                </span>
              )}
              <h1 className="text-3xl font-display font-bold text-foreground mb-2">
                {course.title}
                {course.grade_level_id && (
                  <span className="text-lg font-normal text-muted-foreground ml-2">
                    ({institutionGradeLevels.getLabelById(course.grade_level_id, "el")})
                  </span>
                )}
              </h1>
              <p className="text-muted-foreground max-w-2xl">
                {course.description || "No description provided"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {(actualIsAdmin || actualIsInstructor) && (
                <Select
                  value={actualIsAdmin 
                    ? (viewAsInstructor ? "instructor" : "admin")
                    : "instructor"
                  }
                  onValueChange={(value) => {
                    if (value === "student") {
                      navigate(`/student/course/${courseId}?view=student`);
                    } else if (value === "instructor") {
                      navigate(`/course/${courseId}?view=instructor`);
                    } else if (actualIsAdmin) {
                      navigate(`/course/${courseId}`);
                    }
                  }}
                >
                  <SelectTrigger className={`w-[180px] ${
                    viewAsInstructor 
                      ? "bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300" 
                      : ""
                  }`}>
                    <Eye className={`w-4 h-4 mr-2 ${viewAsInstructor ? "text-amber-600 dark:text-amber-400" : ""}`} />
                    <SelectValue placeholder="View as..." />
                  </SelectTrigger>
                  <SelectContent>
                    {actualIsAdmin && <SelectItem value="admin">View as Admin</SelectItem>}
                    <SelectItem value="instructor">View as Instructor</SelectItem>
                    <SelectItem value="student">View as Student</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {isAdmin && (
                <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline">
                      <Edit className="w-4 h-4 mr-2" />
                      Edit Course
                    </Button>
                  </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Edit Course</DialogTitle>
                    <DialogDescription>
                      Update course details
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleUpdateCourse} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="edit-title">Course Title</Label>
                      <Input
                        id="edit-title"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-description">Description</Label>
                      <Textarea
                        id="edit-description"
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        rows={3}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-theme">Theme</Label>
                      <Input
                        id="edit-theme"
                        value={editTheme}
                        onChange={(e) => setEditTheme(e.target.value)}
                      />
                    </div>
                    <Button type="submit" className="w-full" disabled={isEditing}>
                      {isEditing ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          Saving...
                        </>
                      ) : (
                        "Save Changes"
                      )}
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
              )}
            </div>
          </div>
        </div>

        {canManageCourse && (
          <div className="mb-4">
            <CourseJobsIndicator courseId={course.id} />
          </div>
        )}

        <div>
          {/* Main Content - Tabs */}
          <div>
            <Tabs defaultValue={initialTab} className="w-full">
              <TabsList className="mb-4">
                {canManageCourse && (
                  <TabsTrigger value="my-unit" className="flex items-center gap-2">
                    <Target className="w-4 h-4" />
                    My Class
                  </TabsTrigger>
                )}
                <TabsTrigger value="classwork" className="flex items-center gap-2">
                  <School className="w-4 h-4" />
                  Class Management
                </TabsTrigger>
                {canManageCourse && (
                  <TabsTrigger value="ai-tutoring" className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4" />
                    Learning Design
                  </TabsTrigger>
                )}
                {canManageCourse && (
                  <TabsTrigger value="assessments" className="flex items-center gap-2">
                    <ClipboardList className="w-4 h-4" />
                    Assessments
                  </TabsTrigger>
                )}
                {canManageCourse && (
                  <TabsTrigger value="progress-analytics" className="flex items-center gap-2">
                    <BarChart3 className="w-4 h-4" />
                    Data Bank
                  </TabsTrigger>
                )}
              </TabsList>
              
              <TabsContent value="classwork">
                <Tabs
                  defaultValue={initialSubTab(
                    "classwork",
                    canManageCourse
                      ? ["course-materials", "competencies", "progress", "announcements", "about"]
                      : ["course-materials", "about"],
                    "course-materials",
                  )}
                  className="w-full"
                >
                  <TabsList className="mb-4 flex-wrap">
                    <TabsTrigger value="course-materials" className="flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      Course Materials
                    </TabsTrigger>
                    {canManageCourse && (
                      <TabsTrigger value="competencies" className="flex items-center gap-2">
                        <GraduationCap className="w-4 h-4" />
                        Competencies
                        {/*
                          The tab is easy to overlook, and a course with no
                          competencies silently degrades everything downstream
                          (analytics, study-guide scoring). Flag the empty state
                          on the trigger itself. The icon carries no accessible
                          text on purpose — the tab's name stays "Competencies".
                        */}
                        {competencyCount === 0 && (
                          <span
                            title="No competencies defined yet"
                            data-testid="competencies-empty-indicator"
                            className="flex items-center"
                          >
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                          </span>
                        )}
                      </TabsTrigger>
                    )}
                    {canManageCourse && (
                      <TabsTrigger value="progress" className="flex items-center gap-2">
                        <TrendingUp className="w-4 h-4" />
                        Section Progress
                      </TabsTrigger>
                    )}
                    {canManageCourse && (
                      <TabsTrigger value="announcements" className="flex items-center gap-2">
                        <Megaphone className="w-4 h-4" />
                        Announcements
                      </TabsTrigger>
                    )}
                    <TabsTrigger value="about" className="flex items-center gap-2">
                      <Settings2 className="w-4 h-4" />
                      Settings
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="course-materials">
                    <Tabs
                      defaultValue={initialSub2Tab(
                        "classwork",
                        "course-materials",
                        ["textbooks-images", "notes"],
                        "textbooks-images",
                      )}
                      className="w-full"
                    >
                      <TabsList className="mb-4">
                        <TabsTrigger value="textbooks-images" className="flex items-center gap-2">
                          <FileText className="w-4 h-4" />
                          Textbooks & Images
                        </TabsTrigger>
                        {canManageCourse && (
                          <TabsTrigger value="notes" className="flex items-center gap-2">
                            <StickyNote className="w-4 h-4" />
                            Notes
                          </TabsTrigger>
                        )}
                      </TabsList>

                      <TabsContent value="textbooks-images">
                        <Card>
                          <CardHeader>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <CardTitle className="flex items-center gap-2">
                                <FileText className="w-5 h-5" />
                                Course Materials
                              </CardTitle>
                              <div className="flex flex-wrap items-center justify-end gap-2">
                                <span className="text-sm text-muted-foreground">
                                  {materials.length} file{materials.length !== 1 ? "s" : ""}
                                </span>
                                {canManageCourse && (
                                  <>
                                    <Button size="sm" onClick={triggerPdfUpload}>
                                      <Upload className="w-4 h-4 mr-2" />
                                      Upload PDF
                                    </Button>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button size="sm" variant="outline">
                                          <Image className="w-4 h-4 mr-2" />
                                          Add Image
                                          <ChevronDown className="w-3 h-3 ml-1" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onSelect={() => setImageUploadDialogOpen(true)}>
                                          <Image className="w-4 h-4 mr-2" />
                                          Upload
                                        </DropdownMenuItem>
                                        {extractableMaterials.length === 0 ? (
                                          <DropdownMenuItem disabled>
                                            <ImagePlus className="w-4 h-4 mr-2" />
                                            Extract images from text
                                          </DropdownMenuItem>
                                        ) : extractableMaterials.length === 1 ? (
                                          <DropdownMenuItem onSelect={() => handlePreview(extractableMaterials[0])}>
                                            <ImagePlus className="w-4 h-4 mr-2" />
                                            Extract images from text
                                          </DropdownMenuItem>
                                        ) : (
                                          <DropdownMenuSub>
                                            <DropdownMenuSubTrigger>
                                              <ImagePlus className="w-4 h-4 mr-2" />
                                              Extract images from text
                                            </DropdownMenuSubTrigger>
                                            <DropdownMenuSubContent>
                                              {extractableMaterials.map(m => (
                                                <DropdownMenuItem key={m.id} onSelect={() => handlePreview(m)}>
                                                  <span className="truncate max-w-[16rem]">
                                                    {m.title || m.file_name}
                                                  </span>
                                                </DropdownMenuItem>
                                              ))}
                                            </DropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )}
                                        <DropdownMenuItem onSelect={() => setGenerateImageDialogOpen(true)}>
                                          <Sparkles className="w-4 h-4 mr-2" />
                                          Generate with AI
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                    {/* Imports a link's text as an "Other"
                                        material — see UrlImportDialog, which
                                        writes WHOLE_DOCUMENT_MATERIAL_TYPE. */}
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button size="sm" variant="outline">
                                          <Link2 className="w-4 h-4 mr-2" />
                                          From a link
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onSelect={() => setUrlImportKind("youtube")}>
                                          <Youtube className="w-4 h-4 mr-2" />
                                          {IMPORT_KIND_COPY.youtube.action}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => setUrlImportKind("web")}>
                                          <Globe className="w-4 h-4 mr-2" />
                                          {IMPORT_KIND_COPY.web.action}
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </>
                                )}
                              </div>
                            </div>
                          </CardHeader>
                          <CardContent>
                            {/* Materials List */}
                            {materials.length === 0 ? (
                              <div className="py-8 text-center">
                                <FileText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                                <p className="text-sm text-muted-foreground">
                                  No materials uploaded yet
                                </p>
                                {isAdmin && (
                                  <div className="flex items-center gap-2 mt-4">
                                    <Button variant="outline" onClick={() => setImageUploadDialogOpen(true)}>
                                      <Image className="w-4 h-4 mr-2" />
                                      Add Image
                                    </Button>
                                    <Button variant="outline" onClick={triggerPdfUpload}>
                                      <Upload className="w-4 h-4 mr-2" />
                                      Upload PDF
                                    </Button>
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="outline">
                                          <Link2 className="w-4 h-4 mr-2" />
                                          From a link
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem onSelect={() => setUrlImportKind("youtube")}>
                                          <Youtube className="w-4 h-4 mr-2" />
                                          {IMPORT_KIND_COPY.youtube.action}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => setUrlImportKind("web")}>
                                          <Globe className="w-4 h-4 mr-2" />
                                          {IMPORT_KIND_COPY.web.action}
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="space-y-3">
                                {(() => {
                                  // Group materials by type - always show all types
                                  const typeOrder: MaterialType[] = MATERIAL_TYPE_ORDER;
                                  const grouped = typeOrder.map(type => ({
                                    type,
                                    items: materials.filter(m => m.material_type === type)
                                  }));

                                  return grouped.map((group, groupIndex) => (
                                    <div key={group.type}>
                                      {groupIndex > 0 && (
                                        <hr className="border-border/30 my-4" />
                                      )}
                                      <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                                          {MATERIAL_TYPE_LABELS[group.type]}
                                        </p>
                                      </div>
                                      {group.items.length === 0 ? (
                                        <p className="text-xs text-muted-foreground/60 italic py-2">
                                          No {MATERIAL_TYPE_LABELS[group.type].toLowerCase()}{group.type === WHOLE_DOCUMENT_MATERIAL_TYPE ? ' materials' : ''} uploaded
                                        </p>
                                      ) : (
                                      <div className="space-y-2">
                                        {group.items.map((material) => {
                                          const isExpanded = expandedMaterials.has(material.id);
                                          const chapters = materialChapters[material.id] || [];
                                          const isLoadingChapters = loadingChapters.has(material.id);
                                          const isImageType = material.material_type === 'images';
                                          // Imported links are stored as Markdown, which has no page to
                                          // render a thumbnail from.
                                          const isTextType = isTextMaterial(material.file_name);
                                          // Images and chapterless "Other" PDFs are never split into
                                          // chapters, so every chapter affordance is hidden for both.
                                          const isChapterless = CHAPTERLESS_MATERIAL_TYPES.includes(material.material_type);

                                          return (
                                            <div key={material.id} className="rounded-xl bg-secondary/50 overflow-hidden">
                                              <div className="flex items-center gap-4 p-4 hover:bg-secondary transition-colors group">
                                                {/* Expand button - only for chaptered materials */}
                                                {!isChapterless ? (
                                                  <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8 flex-shrink-0"
                                                    onClick={() => toggleMaterialExpanded(material.id)}
                                                    title="View chapters"
                                                  >
                                                    {isLoadingChapters ? (
                                                      <Loader2 className="w-4 h-4 animate-spin" />
                                                    ) : isExpanded ? (
                                                      <ChevronDown className="w-4 h-4" />
                                                    ) : (
                                                      <ChevronRight className="w-4 h-4" />
                                                    )}
                                                  </Button>
                                                ) : (
                                                  <div className="w-8 flex-shrink-0" />
                                                )}
                                                <div 
                                                  className={`w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden ${isImageType ? 'bg-primary/10' : 'bg-destructive/10'} ${!isImageType && !isTextType && !material.thumbnail_url ? 'cursor-pointer hover:bg-destructive/20 transition-colors' : ''}`}
                                                  onClick={() => {
                                                    if (!isImageType && !isTextType && !material.thumbnail_url && generatingThumbnail !== material.id) {
                                                      handleGenerateThumbnail(material);
                                                    }
                                                  }}
                                                  title={!isImageType && !isTextType && !material.thumbnail_url ? "Click to generate thumbnail" : undefined}
                                                >
                                                  {generatingThumbnail === material.id ? (
                                                    <Loader2 className="w-6 h-6 text-destructive animate-spin" />
                                                  ) : isImageType && imageThumbUrls[material.id] ? (
                                                    <img 
                                                      src={imageThumbUrls[material.id]}
                                                      alt={material.title || material.file_name}
                                                      loading="lazy"
                                                      className="w-full h-full object-cover"
                                                    />
                                                  ) : isImageType ? (
                                                    <Image className="w-6 h-6 text-primary" />
                                                  ) : material.thumbnail_url ? (
                                                    <img 
                                                      src={material.thumbnail_url}
                                                      alt={material.title || material.file_name}
                                                      loading="lazy"
                                                      className="w-full h-full object-cover"
                                                    />
                                                  ) : (
                                                    <File className="w-6 h-6 text-destructive" />
                                                  )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                  <div className="flex items-center gap-2">
                                                    <p className="font-medium text-foreground truncate">
                                                      {material.title || material.file_name}
                                                    </p>
                                                    {/* Moderation status badge for images */}
                                                    {isImageType && (
                                                      material.moderation_status === "rejected" ? (
                                                        <div className="flex flex-col gap-1">
                                                          <Badge variant="secondary" className="bg-red-500/10 text-red-600 border-red-500/20 gap-1 text-xs">
                                                            <XCircle className="w-3 h-3" />
                                                            Rejected
                                                          </Badge>
                                                          {(material as any).ai_description && (
                                                            <p className="text-xs text-red-500/80 max-w-xs break-words">
                                                              {(material as any).ai_description.replace("REJECTED: ", "")}
                                                            </p>
                                                          )}
                                                          <p className="text-xs text-muted-foreground break-all max-w-xs font-mono">
                                                            {imageThumbUrls[material.id] || material.file_url}
                                                          </p>
                                                        </div>
                                                      ) : material.moderation_status === "approved" ? (
                                                        <Badge variant="secondary" className="bg-green-500/10 text-green-600 border-green-500/20 gap-1 text-xs">
                                                          <CheckCircle className="w-3 h-3" />
                                                          Approved
                                                        </Badge>
                                                      ) : (
                                                        <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 border-amber-500/20 gap-1 text-xs">
                                                          <Clock className="w-3 h-3" />
                                                          Pending
                                                        </Badge>
                                                      )
                                                    )}
                                                  </div>
                                                  <p className="text-xs text-muted-foreground">
                                                    {material.author && <span>{material.author}</span>}
                                                    {material.author && material.year && <span> • </span>}
                                                    {material.year && <span>{material.year}</span>}
                                                    {(material.author || material.year) && <span> • </span>}
                                                    {formatFileSize(material.file_size)}
                                                    {!isImageType && material.page_count && ` • ${material.page_count} pages`}
                                                    {!isChapterless && chapters.length > 0 && ` • ${chapters.length} chapter${chapters.length !== 1 ? 's' : ''}`}
                                                  </p>
                                                  {/* Warning for chaptered materials without chapters */}
                                                  {!isChapterless && (materialChapterCounts[material.id] || 0) === 0 && (
                                                    <div className="flex items-center gap-1.5 mt-1">
                                                      <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20 gap-1 text-xs">
                                                        <AlertTriangle className="w-3 h-3" />
                                                        No chapters defined
                                                      </Badge>
                                                      <span className="text-xs text-muted-foreground">— Click "Chapters" to define them</span>
                                                    </div>
                                                  )}
                                                  {material.description && (
                                                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                                                      {material.description}
                                                    </p>
                                                  )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                  {material.file_url && (
                                                    <>
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => handlePreview(material)}
                                                        title="Preview"
                                                      >
                                                        <Eye className="w-4 h-4" />
                                                      </Button>
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => handleDownload(material)}
                                                        title="Download"
                                                      >
                                                        <Download className="w-4 h-4" />
                                                      </Button>
                                                    </>
                                                  )}
                                                  {canManageCourse && (
                                                    <>
                                                      {/* Enable button for images */}
                                                      {isImageType && (
                                                        <Button
                                                          variant="ghost"
                                                          size="icon"
                                                          onClick={() => handleModerateImage(material)}
                                                          disabled={moderatingImage === material.id}
                                                          title={material.moderation_status === "pending" ? "Enable image" : "Re-moderate image"}
                                                          className={material.moderation_status === "approved" ? "text-green-600" : ""}
                                                        >
                                                          {moderatingImage === material.id ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                          ) : (
                                                            <Power className="w-4 h-4" />
                                                          )}
                                                        </Button>
                                                      )}
                                                      {/* Cloud sync - only for non-image materials */}
                                                      {!isImageType && (
                                                        material.openai_file_id ? (
                                                          <div className="relative">
                                                            {renderVectorStoreStatus(material)}
                                                          </div>
                                                        ) : (
                                                          <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => handleSyncToOpenAI(material)}
                                                            title="Sync to OpenAI"
                                                            disabled={syncingMaterial === material.id}
                                                          >
                                                            {syncingMaterial === material.id ? (
                                                              <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                              <CloudOff className="w-4 h-4 text-muted-foreground" />
                                                            )}
                                                          </Button>
                                                        )
                                                      )}
                                                      {/* Chapters button - only for chaptered materials */}
                                                      {!isChapterless && material.file_url && (
                                                        <Button
                                                          variant="ghost"
                                                          size="sm"
                                                          onClick={() => openChaptersWizard(material)}
                                                          title="Create Chapters"
                                                          className="gap-1"
                                                        >
                                                          <Layers className="w-4 h-4" />
                                                          <span className="hidden sm:inline">Chapters</span>
                                                        </Button>
                                                      )}
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => openEditMaterialDialog(material)}
                                                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                                                        title="Edit"
                                                      >
                                                        <Edit className="w-4 h-4" />
                                                      </Button>
                                                      <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => handleDeleteMaterial(material)}
                                                        className="text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                                                        title="Delete"
                                                      >
                                                        <Trash2 className="w-4 h-4" />
                                                      </Button>
                                                    </>
                                                  )}
                                                </div>
                                              </div>
                                              
                                              {/* Chapters List */}
                                              {isExpanded && !isChapterless && (
                                                <div className="border-t border-border/50 bg-background/50">
                                                  {chapters.length === 0 ? (
                                                    <div className="px-4 py-6 text-center border-2 border-dashed border-amber-500/30 bg-amber-500/5 rounded-lg m-3">
                                                      <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-3">
                                                        <BookOpen className="w-6 h-6 text-amber-600" />
                                                      </div>
                                                      <p className="text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">No chapters defined</p>
                                                      <p className="text-xs text-muted-foreground mb-3">
                                                        Define chapters to enable question generation and study materials
                                                      </p>
                                                      {canManageCourse && (
                                                        <Button 
                                                          variant="outline" 
                                                          size="sm" 
                                                          className="border-amber-500/50 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                                                          onClick={() => openChaptersWizard(material)}
                                                        >
                                                          <Plus className="w-4 h-4 mr-2" />
                                                          Create Chapters
                                                        </Button>
                                                      )}
                                                    </div>
                                                  ) : (
                                                    <div className="divide-y divide-border/30">
                                                      {chapters.map((chapter) => (
                                                        <div 
                                                          key={chapter.id}
                                                          className="px-4 py-3 hover:bg-secondary/30 transition-colors"
                                                        >
                                                          <div className="flex items-center gap-3">
                                                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 text-primary">
                                                              {getChapterTypeIcon(chapter.content_type)}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                              <div className="flex items-center gap-2">
                                                                <span className="text-xs font-medium text-muted-foreground">
                                                                  Ch. {chapter.chapter_number}
                                                                </span>
                                                                <EditableChapterTitle
                                                                  chapterId={chapter.id}
                                                                  title={chapter.title}
                                                                  canEdit={canManageCourse}
                                                                  onSaved={(newTitle) => {
                                                                    setMaterialChapters(prev => ({
                                                                      ...prev,
                                                                      [material.id]: (prev[material.id] || []).map(ch =>
                                                                        ch.id === chapter.id ? { ...ch, title: newTitle } : ch
                                                                      ),
                                                                    }));
                                                                  }}
                                                                  className="font-medium text-foreground text-sm"
                                                                />
                                                                {getChapterTypeBadge(chapter.content_type)}
                                                              </div>
                                                              <div className="flex items-center gap-3 mt-1">
                                                                {chapter.cheat_sheet && (
                                                                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                                                                    <BookOpen className="w-3 h-3" />
                                                                    Cheat sheet
                                                                  </span>
                                                                )}
                                                                {chapter.flashcards && Array.isArray(chapter.flashcards) && chapter.flashcards.length > 0 && (
                                                                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                                                                    <Layers className="w-3 h-3" />
                                                                    {chapter.flashcards.length} flashcards
                                                                  </span>
                                                                )}
                                                              </div>
                                                            </div>
                                                            {canManageCourse && (
                                                              <ChapterStudyMaterialsManager
                                                                chapterId={chapter.id}
                                                                chapterTitle={chapter.title}
                                                                hasCheatSheet={!!chapter.cheat_sheet}
                                                                hasFlashcards={!!chapter.flashcards && Array.isArray(chapter.flashcards) && chapter.flashcards.length > 0}
                                                                flashcardCount={Array.isArray(chapter.flashcards) ? chapter.flashcards.length : 0}
                                                                materialType={material.material_type}
                                                              />
                                                            )}
                                                          </div>
                                                        </div>
                                                      ))}
                                                    </div>
                                                  )}
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                      )}
                                    </div>
                                  ));
                                })()}
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </TabsContent>

                      {canManageCourse && (
                        <TabsContent value="notes">
                          <InstructorNotesTab
                            courseId={course.id}
                            sections={classes
                              .filter((c) => Boolean(c.offering_id))
                              .map((c) => ({
                                id: c.id,
                                offeringId: c.offering_id!,
                                label: buildClassDisplayName(c),
                              }))}
                          />
                        </TabsContent>
                      )}


                    </Tabs>
                  </TabsContent>

                  {canManageCourse && (
                    <TabsContent value="progress">
                      <CourseProgress
                        courseId={course.id}
                        canManage={canManageCourse}
                      />
                    </TabsContent>
                  )}

                  {canManageCourse && (
                    <TabsContent value="announcements">
                      <InstructorAnnouncementsTab
                        courseId={course.id}
                        sections={classes
                          .filter((c) => Boolean(c.offering_id))
                          .map((c) => ({
                            id: c.id,
                            offeringId: c.offering_id!,
                            label: buildClassDisplayName(c),
                          }))}
                      />
                    </TabsContent>
                  )}

                  {canManageCourse && (
                    <TabsContent value="competencies">
                      {/*
                        Keyed so a course change gives the panel a fresh
                        instance rather than a new courseId on one still holding
                        the previous course's rows and in-flight requests. The
                        page's own loading gate already unmounts this subtree on
                        navigation; the key states the invariant regardless of
                        that, and the panel guards its deferred writes itself.
                      */}
                      <CourseCompetencies 
                        key={course.id}
                        courseId={course.id} 
                        courseTitle={course.title}
                        courseDescription={course.description || undefined}
                        courseLanguage={course.language || undefined}
                        onCountChange={handleCompetencyCount}
                      />
                    </TabsContent>
                  )}
                  <TabsContent value="about" className="space-y-4">
                    <Card>
                      <CardContent className="p-0 divide-y">
                        {/* Course Info */}
                        <section className="p-6 space-y-3">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <BookOpen className="w-4 h-4" />
                            Course Info
                          </CardTitle>
                          <div className="flex flex-wrap gap-x-12 gap-y-3 text-sm">
                            <div className="space-y-1">
                              <p className="text-muted-foreground">Created</p>
                              <p className="font-medium">{formatDate(course.created_at)}</p>
                            </div>
                            <div className="space-y-1">
                              <p className="text-muted-foreground">Materials</p>
                              <p className="font-medium">{materials.length}</p>
                            </div>
                          </div>
                        </section>

                        {/* Sections */}
                        {canManageCourse && (
                          <section className="p-6 space-y-3">
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <CardTitle className="flex items-center gap-2 text-base">
                                  <UsersRound className="w-4 h-4" />
                                  Sections
                                </CardTitle>
                                <Badge variant="secondary">
                                  {classes.length}
                                </Badge>
                              </div>
                              <CardDescription>
                                Sections where this course is offered
                              </CardDescription>
                            </div>
                            {classesLoading ? (
                              <div className="flex items-center justify-center py-4">
                                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                              </div>
                            ) : classes.length === 0 ? (
                              <p className="text-sm text-muted-foreground py-4 text-center">
                                No sections attached yet
                              </p>
                            ) : (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {classes.map((cls) => (
                                  <div
                                    key={cls.id}
                                    className="flex items-center gap-3 p-2 rounded-lg bg-primary/5 border border-primary/20"
                                  >
                                    <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-sm font-medium text-primary">
                                      <School className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate">
                                        {buildClassDisplayName(cls)}
                                      </p>
                                      <Badge variant={cls.is_active ? "default" : "secondary"} className="text-[10px]">
                                        {cls.is_active ? "Active" : "Inactive"}
                                      </Badge>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </section>
                        )}

                        {/* Instructors (Admin/Instructor) */}
                        {canManageCourse && (
                          <section className="p-6 space-y-3">
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <CardTitle className="flex items-center gap-2 text-base">
                                  <Users className="w-4 h-4" />
                                  Course Instructors
                                </CardTitle>
                                <Badge variant="secondary">
                                  {usersWithAccess.length}
                                </Badge>
                              </div>
                              <CardDescription>
                                Instructors with access can manage materials and questions
                              </CardDescription>
                            </div>
                            {usersWithAccess.length === 0 ? (
                              <p className="text-sm text-muted-foreground py-4 text-center">
                                No instructors assigned to this course
                              </p>
                            ) : (
                              <div className="space-y-3">
                                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                  {usersWithAccess
                                    .slice(0, 5)
                                    .map((userAccess) => (
                                      <div
                                        key={userAccess.id}
                                        className="flex items-center gap-3 p-2 rounded-lg bg-primary/5 border border-primary/20"
                                      >
                                        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-sm font-medium text-primary">
                                          {(userAccess.full_name || userAccess.email || "?")[0].toUpperCase()}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-sm font-medium truncate">
                                            {userAccess.full_name || "Unnamed"}
                                          </p>
                                          <p className="text-xs text-muted-foreground truncate">
                                            {userAccess.sections && userAccess.sections.length > 0
                                              ? userAccess.sections.join(", ")
                                              : "All sections"}
                                          </p>
                                        </div>
                                      </div>
                                    ))}
                                </div>
                                {usersWithAccess.length > 5 && (
                                  <Button
                                    variant="link"
                                    className="w-full text-sm"
                                    onClick={() => navigate("/users")}
                                  >
                                    View all {usersWithAccess.length} instructors →
                                  </Button>
                                )}
                              </div>
                            )}
                          </section>
                        )}

                      </CardContent>
                    </Card>

                    {/* All course settings grouped in a single box */}
                    {canManageCourse && (
                      <Card>
                        <CardContent className="p-0 divide-y">
                          {/* Course Settings */}
                          <section className="p-6 space-y-6">
                            <CardTitle className="flex items-center gap-2 text-base">
                              <Edit className="w-4 h-4" />
                              Course Settings
                            </CardTitle>

                            {/* Show Difficulty Toggle */}
                            <div className="space-y-2 max-w-2xl">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <HelpCircle className="w-4 h-4" />
                                  <Label htmlFor="show-difficulty-toggle" className="cursor-pointer font-medium">
                                    Show Difficulty
                                  </Label>
                                </div>
                                <Switch
                                  id="show-difficulty-toggle"
                                  checked={course.show_difficulty_to_students}
                                  onCheckedChange={handleToggleShowDifficulty}
                                />
                              </div>
                              <p className="text-xs text-muted-foreground pl-6">
                                Display question difficulty level (easy/medium/hard) to students
                              </p>
                            </div>

                            <div className="border-t max-w-2xl" />

                            {/* Language Override */}
                            <div className="space-y-2 max-w-2xl">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Languages className="w-4 h-4" />
                                  <Label className="font-medium">
                                    Language
                                  </Label>
                                </div>
                                <Select
                                  value={course.language || "inherit"}
                                  onValueChange={handleLanguageChange}
                                >
                                  <SelectTrigger className="w-[180px]">
                                    <SelectValue placeholder="Inherit from institution" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="inherit">
                                      <span className="text-muted-foreground">Inherit from institution</span>
                                    </SelectItem>
                                    {LANGUAGE_OPTIONS.map((lang) => (
                                      <SelectItem key={lang.code} value={lang.code}>
                                        {lang.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <p className="text-xs text-muted-foreground pl-6">
                                Override institution default for AI-generated content in this course
                              </p>
                            </div>
                          </section>

                          {/* Student Question Generation */}
                          <StudentQuestionSettingsSection
                            courseId={course.id}
                            canManage={canManageCourse}
                            studentQuestionsEnabled={course.student_questions_enabled}
                            restrictToCompletedChapters={course.restrict_to_completed_chapters}
                            onSettingsChange={(next) => setCourse({ ...course, ...next })}
                          />
                        </CardContent>
                      </Card>
                    )}
                  </TabsContent>

                </Tabs>
              </TabsContent>

              {canManageCourse && (
                <TabsContent value="ai-tutoring">
                  <Tabs
                    defaultValue={initialSubTab(
                      "ai-tutoring",
                      ["question-bank", "practice-review", "ai-chatbots", "study-guides"],
                      "question-bank",
                    )}
                    className="w-full"
                  >
                    <TabsList className="mb-4 justify-start overflow-x-auto">
                      <TabsTrigger value="question-bank" className="flex items-center gap-2">
                        <Database className="w-4 h-4" />
                        Question Bank
                      </TabsTrigger>
                      <TabsTrigger value="practice-review" className="flex items-center gap-2">
                        <RefreshCw className="w-4 h-4" />
                        Practice & Review
                      </TabsTrigger>
                      <TabsTrigger value="ai-chatbots" className="flex items-center gap-2">
                        <Bot className="w-4 h-4" />
                        AI Chatbots
                      </TabsTrigger>
                      <TabsTrigger value="study-guides" className="flex items-center gap-2">
                        <BookText className="w-4 h-4" />
                        Study Guides
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="question-bank">
                      {/* #621 — single unified table across all 5 question types. */}
                      <UnifiedQuestionBank
                        courseId={course.id}
                        materials={materials}
                        isAdmin={canManageCourse}
                        classes={classes.map(c => ({
                          id: c.id,
                          name: c.name,
                          grade_level_id: c.grade_level_id,
                          section_name: c.section_name,
                          category: c.category,
                          academic_period: c.academic_period,
                          offering_id: c.offering_id,
                        }))}
                      />
                    </TabsContent>

                    <TabsContent value="practice-review">
                      <Tabs defaultValue="flashcards" className="w-full">
                        <TabsList className="mb-4">
                          <TabsTrigger value="flashcards" className="flex items-center gap-2">
                            <Layers className="w-4 h-4" />
                            Flashcards
                          </TabsTrigger>
                          <TabsTrigger value="cheat-sheets" className="flex items-center gap-2">
                            <BookOpen className="w-4 h-4" />
                            Cheat Sheets
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="flashcards">
                          <FlashcardManager courseId={course.id} classes={classes.map(c => ({
                            id: c.id, name: c.name, grade_level_id: c.grade_level_id,
                            section_name: c.section_name, category: c.category,
                            academic_period: c.academic_period, offering_id: c.offering_id,
                          }))} />
                        </TabsContent>

                        <TabsContent value="cheat-sheets">
                          <CheatSheetViewer courseId={course.id} isAdmin={true} refreshKey={studyMaterialsRefreshKey} classes={classes.map(c => ({
                            id: c.id, name: c.name, grade_level_id: c.grade_level_id,
                            section_name: c.section_name, category: c.category,
                            academic_period: c.academic_period, offering_id: c.offering_id,
                          }))} />
                        </TabsContent>
                      </Tabs>
                    </TabsContent>

                    {/* #660 — Tutoring Sessions and AI Interactive Questions
                        grouped under a single "AI Chatbots" sub-tab. */}
                    <TabsContent value="ai-chatbots">
                      <Tabs defaultValue="study-sessions" className="w-full">
                        <TabsList className="mb-4">
                          <TabsTrigger value="study-sessions" className="flex items-center gap-2">
                            <GraduationCap className="w-4 h-4" />
                            Tutoring Sessions
                          </TabsTrigger>
                          <TabsTrigger value="ai-interactive" className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4" />
                            AI Interactive Questions
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="study-sessions">
                          <StudySessionManager courseId={course.id} classes={classes.map(c => ({
                            id: c.id, name: c.name, grade_level_id: c.grade_level_id,
                            section_name: c.section_name, category: c.category,
                            academic_period: c.academic_period, offering_id: c.offering_id,
                          }))} />
                        </TabsContent>

                        {/* #618 — AI Interactive (Socratic) questions, decoupled
                            from the single-answer Open Questions sub-tab inside
                            Question Bank. */}
                        <TabsContent value="ai-interactive">
                          <AIInteractiveQuestions
                            courseId={course.id}
                            materials={materials}
                            isAdmin={canManageCourse}
                            classes={classes.map(c => ({
                              id: c.id,
                              name: c.name,
                              grade_level_id: c.grade_level_id,
                              section_name: c.section_name,
                              category: c.category,
                              academic_period: c.academic_period,
                              offering_id: c.offering_id,
                            }))}
                          />
                        </TabsContent>
                      </Tabs>
                    </TabsContent>

                    <TabsContent value="study-guides">
                      {/* #979 — AI-decomposed sequential learning paths (epic #976). */}
                      <StudyGuideManager
                        courseId={course.id}
                        initialResultsGuideId={initialResultsGuideId}
                        onInitialResultsConsumed={() => clearAnalyticsDeepLink("guide")}
                        materials={materials}
                        classes={classes.map(c => ({
                          id: c.id,
                          name: c.name,
                          grade_level_id: c.grade_level_id,
                          section_name: c.section_name,
                          category: c.category,
                          academic_period: c.academic_period,
                          offering_id: c.offering_id,
                        }))}
                      />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
              )}

              {canManageCourse && (
                <TabsContent value="assessments">
                  <Tabs
                    defaultValue={initialSubTab(
                      "assessments",
                      ["quizzes", "tests", "grading-offline"],
                      "quizzes",
                    )}
                    className="w-full"
                  >
                    <TabsList className="mb-4">
                      <TabsTrigger value="quizzes" className="flex items-center gap-2">
                        <ClipboardList className="w-4 h-4" />
                        Quizzes (Online)
                      </TabsTrigger>
                      <TabsTrigger value="tests" className="flex items-center gap-2">
                        <PenLine className="w-4 h-4" />
                        Tests (Printed & Take-Home)
                      </TabsTrigger>
                      <TabsTrigger value="grading-offline" className="flex items-center gap-2">
                        <PenLine className="w-4 h-4" />
                        Offline Test Grading
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="quizzes">
                      {/* One study-guide-style table: per-class tracking &
                          management lives in each row's manage dialog. */}
                      <QuizManager
                        courseId={course.id}
                        isAdmin={canManageCourse}
                        initialReportQuizId={initialReportQuizId}
                        onInitialReportConsumed={() => clearAnalyticsDeepLink("quiz")}
                        classes={classes.map(c => ({
                          id: c.id,
                          name: c.name,
                          grade_level_id: c.grade_level_id,
                          section_name: c.section_name,
                          category: c.category,
                          academic_period: c.academic_period,
                          offering_id: c.offering_id,
                        }))}
                      />
                    </TabsContent>

                    <TabsContent value="tests">
                      <TestBuilder courseId={course.id} />
                    </TabsContent>

                    <TabsContent value="grading-offline">
                      <HandwrittenTestGrading courseId={course.id} />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
              )}

              {canManageCourse && (
                <TabsContent value="my-unit">
                  <Tabs
                    defaultValue={initialSubTab(
                      "my-unit",
                      ["student-360", "groups", "class-performance"],
                      "student-360",
                    )}
                    className="w-full"
                  >
                    <TabsList className="mb-4 flex-wrap">
                      <TabsTrigger value="student-360" className="flex items-center gap-2">
                        <Users className="w-4 h-4" />
                        Student 360
                      </TabsTrigger>
                      {classes.length > 0 && (
                        <TabsTrigger value="groups" className="flex items-center gap-2">
                          <UsersRound className="w-4 h-4" />
                          Student Groups
                        </TabsTrigger>
                      )}
                      <TabsTrigger value="class-performance" className="flex items-center gap-2">
                        <BarChart2 className="w-4 h-4" />
                        Class Performance
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="student-360">
                      <Student360 courseId={course.id} panels={["evaluations"]} />
                    </TabsContent>
                    {classes.length > 0 && (
                      <TabsContent value="groups">
                        <Card>
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                              <UsersRound className="w-5 h-5" />
                              Student Groups
                            </CardTitle>
                            <CardDescription>
                              Define sub-groups within a class to assign differentiated content,
                              or let AI propose groups based on performance.
                            </CardDescription>
                          </CardHeader>
                          <CardContent>
                            <OfferingGroupsPanel
                              courseId={course.id}
                              classes={classes.map(c => ({
                                id: c.id,
                                name: c.name,
                                grade_level_id: c.grade_level_id,
                                section_name: c.section_name,
                                category: c.category,
                                academic_period: c.academic_period,
                                offering_id: c.offering_id,
                              }))}
                            />
                          </CardContent>
                        </Card>
                      </TabsContent>
                    )}
                    <TabsContent value="class-performance">
                      {/* Class Performance groups the three "how is the class
                          doing?" views: competency analytics plus read-only
                          quiz / study-guide rosters that shortcut to the same
                          analytics dialogs their managers open. */}
                      <Tabs
                        defaultValue={initialSub2Tab(
                          "my-unit",
                          "class-performance",
                          ["competencies", "quizzes", "study-guides"],
                          "competencies",
                        )}
                        className="w-full"
                      >
                        <TabsList className="mb-4">
                          <TabsTrigger value="competencies" className="flex items-center gap-2">
                            <BarChart2 className="w-4 h-4" />
                            Competencies
                          </TabsTrigger>
                          <TabsTrigger value="quizzes" className="flex items-center gap-2">
                            <ClipboardList className="w-4 h-4" />
                            Quizzes
                          </TabsTrigger>
                          <TabsTrigger value="study-guides" className="flex items-center gap-2">
                            <BookText className="w-4 h-4" />
                            Study Guides
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="competencies">
                          <Student360 courseId={course.id} panels={["competencies"]} />
                        </TabsContent>

                        <TabsContent value="quizzes">
                          <QuizPerformanceList
                            courseId={course.id}
                            classes={classes.map(c => ({
                              id: c.id,
                              name: c.name,
                              grade_level_id: c.grade_level_id,
                              section_name: c.section_name,
                              category: c.category,
                              academic_period: c.academic_period,
                              offering_id: c.offering_id,
                            }))}
                          />
                        </TabsContent>

                        <TabsContent value="study-guides">
                          <StudyGuidePerformanceList
                            courseId={course.id}
                            classes={classes.map(c => ({
                              id: c.id,
                              name: c.name,
                              grade_level_id: c.grade_level_id,
                              section_name: c.section_name,
                              category: c.category,
                              academic_period: c.academic_period,
                              offering_id: c.offering_id,
                            }))}
                          />
                        </TabsContent>
                      </Tabs>
                    </TabsContent>
                  </Tabs>
                </TabsContent>
              )}

              {canManageCourse && (
                <TabsContent value="progress-analytics">
                  <Tabs defaultValue="interactions" className="w-full">
                    <TabsList className="mb-4">
                      <TabsTrigger value="interactions" className="flex items-center gap-2">
                        <MessagesSquare className="w-4 h-4" />
                        Interactions
                      </TabsTrigger>
                      <TabsTrigger value="evaluations" className="flex items-center gap-2">
                        <ClipboardList className="w-4 h-4" />
                        Evaluations
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="interactions">
                      <Student360 courseId={course.id} panels={["interactions"]} />
                    </TabsContent>
                    <TabsContent value="evaluations">
                      <CourseEvaluationsReport courseId={course.id} />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
              )}

            </Tabs>
          </div>

        </div>
      </main>

      {/* Edit Material Dialog */}
      <Dialog open={uploadDialogOpen && !!editingMaterial} onOpenChange={(open) => {
        if (!open && !uploading) {
          setUploadDialogOpen(false);
          setEditingMaterial(null);
        }
      }}>
        <DialogContent className="sm:max-w-xl w-[95vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Material</DialogTitle>
            <DialogDescription>
              Update the metadata for this material
            </DialogDescription>
          </DialogHeader>
          
          <form onSubmit={(e) => { 
            e.preventDefault(); 
            handleUpdateMaterial(); 
          }} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="material-title">Title *</Label>
              <Input
                id="material-title"
                value={materialTitle}
                onChange={(e) => setMaterialTitle(e.target.value)}
                placeholder="Material title"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="material-author">Author</Label>
              <Input
                id="material-author"
                value={materialAuthor}
                onChange={(e) => setMaterialAuthor(e.target.value)}
                placeholder="Author name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="material-year">Year</Label>
              <Input
                id="material-year"
                type="number"
                min="1900"
                max={new Date().getFullYear() + 1}
                value={materialYear}
                onChange={(e) => setMaterialYear(e.target.value)}
                placeholder="Publication year"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="material-description">Description</Label>
              <Textarea
                id="material-description"
                value={materialDescription}
                onChange={(e) => setMaterialDescription(e.target.value)}
                placeholder="Brief description of the material"
                rows={2}
              />
            </div>
            {/* Shown, not editable.
                A material's type decides how it is prepared, not merely how it
                is labelled: a textbook is split into chapters and synced
                chapter by chapter, while "Images" and "Other" are never split
                and are attached whole. Retyping a material after the fact
                leaves it prepared for the kind it no longer is, and the
                derived content — chapters, split PDFs, vector-store files —
                keeps pointing at a shape nothing agrees on any more. Upload it
                as what it is; to change it, delete and re-upload. */}
            <div className="space-y-2">
              <Label htmlFor="material-type">Material Type</Label>
              <p
                id="material-type"
                data-testid="edit-material-type"
                className="text-sm rounded-md border bg-muted/40 px-3 py-2"
              >
                {MATERIAL_TYPE_LABELS[editingMaterial?.material_type ?? "textbook"]}
              </p>
              <p className="text-xs text-muted-foreground">
                Set when the material was added, and fixed afterwards — it decides how the
                material is prepared for AI, not just how it is filed.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setUploadDialogOpen(false);
                  setEditingMaterial(null);
                }}
                disabled={uploading}
              >
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="flex-1" 
                disabled={uploading || !materialTitle}
              >
                {uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4 mr-2" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* PDF Preview Dialog with Image Extraction */}
      <Dialog open={!!previewMaterial} onOpenChange={(open) => !open && closePreview()}>
        <DialogContent className="max-w-5xl h-[90vh] flex flex-col p-0">
          <DialogHeader className="px-6 py-4 border-b">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-lg font-medium truncate pr-4">
                {previewMaterial?.file_name}
              </DialogTitle>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => previewMaterial && handleDownload(previewMaterial)}
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden bg-muted">
            {previewLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
              </div>
            ) : previewMarkdown !== null ? (
              <div className="h-full overflow-y-auto bg-background p-6">
                <MarkdownContent className="max-w-3xl mx-auto">
                  {previewMarkdown}
                </MarkdownContent>
              </div>
            ) : previewUrl && previewMaterial && courseId ? (
              <PdfViewerWithExtract
                fileUrl={previewUrl}
                storagePath={previewMaterial.file_url}
                fileName={previewMaterial.file_name}
                courseId={courseId}
                onImagesExtracted={() => {
                  fetchCourseData();
                }}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* New Material Upload Dialog (with OpenAI sync) */}
      {course && (
        <MaterialUploadDialog
          courseId={course.id}
          open={newMaterialDialogOpen}
          onOpenChange={setNewMaterialDialogOpen}
          onSuccess={() => {
            fetchCourseData();
          }}
        />
      )}

      {/* Image Upload Dialog */}
      {course && (
        <ImageUploadDialog
          courseId={course.id}
          courseLanguage={course.language || "en"}
          open={imageUploadDialogOpen}
          onOpenChange={setImageUploadDialogOpen}
          onSuccess={() => {
            fetchCourseData();
          }}
        />
      )}

      {course && (
        <GenerateImageDialog
          courseId={course.id}
          courseTitle={course.title}
          materials={materials}
          open={generateImageDialogOpen}
          onOpenChange={setGenerateImageDialogOpen}
          onSuccess={() => {
            fetchCourseData();
          }}
        />
      )}

      {/* Link import — a video's transcript or a page's text, saved as an
          "Other" material. Keyed by kind so switching between the two starts
          clean rather than inheriting the previous link. */}
      {course && urlImportKind && (
        <UrlImportDialog
          key={urlImportKind}
          courseId={course.id}
          kind={urlImportKind}
          courseLanguage={course.language || undefined}
          open
          onOpenChange={(next) => {
            if (!next) setUrlImportKind(null);
          }}
          onSuccess={() => {
            fetchCourseData();
          }}
        />
      )}

      {/* Chapter Wizard */}
      {selectedMaterialForChapters && (
        <MaterialChaptersWizard
          materialId={selectedMaterialForChapters.id}
          materialTitle={selectedMaterialForChapters.title || selectedMaterialForChapters.file_name}
          materialFileUrl={selectedMaterialForChapters.file_url}
          materialType={selectedMaterialForChapters.material_type}
          openaiFileId={selectedMaterialForChapters.openai_file_id}
          courseId={courseId}
          vectorStoreId={vectorStoreId}
          pageCount={selectedMaterialForChapters.page_count}
          open={chaptersWizardOpen}
          onOpenChange={setChaptersWizardOpen}
          canEdit={canManageCourse}
          onChaptersUpdated={async () => {
            // Refresh chapters for this material
            setMaterialChapters(prev => {
              const next = { ...prev };
              delete next[selectedMaterialForChapters.id];
              return next;
            });
            // Re-fetch chapter count
            const { data: chaptersData } = await supabase
              .from("material_chapters")
              .select("id")
              .eq("material_id", selectedMaterialForChapters.id);
            
            setMaterialChapterCounts(prev => ({
              ...prev,
              [selectedMaterialForChapters.id]: chaptersData?.length || 0
            }));
            
            // Re-fetch if expanded
            if (expandedMaterials.has(selectedMaterialForChapters.id)) {
              fetchChaptersForMaterial(selectedMaterialForChapters.id);
            }
          }}
        />
      )}

      {/* Attach to Section Dialog */}
      <Dialog open={attachToClassDialogOpen} onOpenChange={setAttachToClassDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attach to Existing Section</DialogTitle>
            <DialogDescription>
              Select a section to attach this course to
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {availableClassesForAttach.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No available sections. This course is already attached to all your sections.
              </p>
            ) : (
              <Select value={selectedClassIdForAttach} onValueChange={setSelectedClassIdForAttach}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a section" />
                </SelectTrigger>
                <SelectContent>
                  {availableClassesForAttach.map((cls) => (
                    <SelectItem key={cls.id} value={cls.id}>
                      {buildClassDisplayName(cls)}{cls.academic_period ? ` (${cls.academic_period})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setAttachToClassDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                disabled={!selectedClassIdForAttach || attachingToClass || availableClassesForAttach.length === 0}
                onClick={handleAttachToClass}
              >
                {attachingToClass ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Attaching...
                  </>
                ) : (
                  "Attach Course"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default CoursePage;