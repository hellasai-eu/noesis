import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Users, Search, Sparkles, TrendingUp, TrendingDown, AlertCircle, Activity, BarChart2, RefreshCw, ChevronDown, ChevronRight, Download, MessageSquare, Check, X, Pencil, Plus, Bot, User, Trash2, Clock, GitCompareArrows, Calendar } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import EvaluationTimeline from "./EvaluationTimeline";
import { CompetencyScoreEditor } from "./student-evaluations/CompetencyScoreEditor";
import { GenerateMcqDialog, type GenerateMcqSeed } from "./GenerateMcqDialog";
import type { CourseClass, OfferingGroup } from "@/types/content-assignments";
import { useFormatters } from "@/i18n/formatters";

interface StudentEvaluationsProps {
  courseId: string;
  offeringId?: string;
  canEdit?: boolean;
}

/** An evaluation older than this no longer seeds Generate Questions. */
const RECENT_EVAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One quiz assignment for a student: score once completed, otherwise still open. */
interface QuizScore {
  offeringId: string;
  quizId: string;
  title: string;
  completed: boolean;
  correct: number;
  total: number;
  percentage: number | null;
}

/** One study guide assignment for a student: average grade plus completion state. */
interface StudyGuideScore {
  offeringId: string;
  studyGuideId: string;
  title: string;
  completed: boolean;
  answered: number;
  avgGrade: number | null;
}

interface StudentData {
  userId: string;
  fullName: string | null;
  email: string | null;
  quizAnswers: {
    total: number;
    correct: number;
  };
  /** Answers with quiz_id IS NULL — practice work, not formal quiz submissions. */
  practiceQuestions: number;
  openQuestionChats: number;
  openQuestionGrades: {
    count: number;
    avgGrade: number | null;
  };
  studySessionMessages: number;
  flashcardReviews: number;
  studyGuideAnswers: {
    total: number;
    avgGrade: number | null;
  };
  quizScores: QuizScore[];
  studyGuideScores: StudyGuideScore[];
}

/**
 * The engagement axis of an evaluation, persisted in the stats jsonb.
 * A type alias, not an interface — only object types with an implicit index
 * signature are assignable to the generated `Json` column type on insert.
 */
type EvaluationEngagement = {
  level: string;
  summary: string;
  counts?: Record<string, number>;
};

interface CompetencyScore {
  competencyId: string;
  competencyTitle: string;
  score: number | null;
  rationale: string;
  isManual: boolean;
}

interface CourseCompetency {
  id: string;
  title: string;
  order_num: number | null;
}

interface CompetencyGridEntry {
  competencyId: string;
  title: string;
  score: number | null;
  rationale: string | null;
  status: "scored" | "insufficient" | "missing";
  isManual: boolean;
}

interface SavedEvaluation {
  id: string;
  user_id: string;
  overall_assessment: string | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  recommendations: string[] | null;
  generated_at: string;
  instructor_feedback: string | null;
  is_manual: boolean;
  stats?: unknown;
}

interface Evaluation {
  id: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  overallAssessment: string;
  hasEnoughData: boolean;
  generatedAt: string;
  instructorFeedback: string | null;
  isManual: boolean;
  showFeedbackPrompt?: boolean;
  competencyScores?: CompetencyScore[];
  engagement?: EvaluationEngagement | null;
}

/** Pull the engagement axis out of a saved evaluation's stats jsonb, if present. */
const engagementFromStats = (stats: unknown): EvaluationEngagement | null => {
  if (!stats || typeof stats !== "object") return null;
  const raw = (stats as { engagement?: unknown }).engagement;
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { level?: unknown; summary?: unknown; counts?: unknown };
  if (typeof e.summary !== "string" || !e.summary.trim()) return null;
  return {
    level: typeof e.level === "string" ? e.level : "",
    summary: e.summary,
    counts: e.counts && typeof e.counts === "object" ? (e.counts as Record<string, number>) : undefined,
  };
};

interface StudentWithEvaluations extends StudentData {
  evaluations: Evaluation[];
  isGenerating: boolean;
}

/**
 * Build the special-instructions prepop string for the per-student Generate
 * Questions MCQ modal (issues #537 + #541). Pure so it can be unit-tested
 * without a Supabase client.
 *
 * Order: assessment line, then (if any notes survive after trimming) a
 * `Student notes:` header and the bodies in the order they were passed in
 * (callers should pass oldest-first so context reads chronologically).
 */
export const buildStudentSpecialInstructions = (input: {
  overallAssessment: string | null | undefined;
  weaknesses: (string | null | undefined)[] | null | undefined;
  noteBodies: (string | null | undefined)[] | null | undefined;
}): string => {
  const assessment = input.overallAssessment?.trim() || "";
  let header = "";
  if (assessment) {
    header = `Creating questions for a student with overall assessment: ${assessment}`;
  } else {
    const ws = (input.weaknesses || []).map((w) => w?.trim()).filter((w): w is string => !!w);
    if (ws.length > 0) {
      header = `Creating questions for a student focusing on these weaknesses: ${ws.join("; ")}`;
    }
  }

  const bodies = (input.noteBodies || [])
    .map((b) => b?.trim())
    .filter((b): b is string => !!b);

  if (bodies.length === 0) return header;
  const notesBlock = `Student notes:\n\n${bodies.join("\n\n")}`;
  return header ? `${header}\n\n${notesBlock}` : notesBlock;
};

const mapScoresToCompetencies = (
  competencies: CourseCompetency[],
  scores: CompetencyScore[] | null | undefined,
): CompetencyGridEntry[] => {
  const byId = new Map((scores || []).map((s) => [s.competencyId, s]));
  return competencies.map((c) => {
    const match = byId.get(c.id);

    if (!match) {
      return {
        competencyId: c.id,
        title: c.title,
        score: null,
        rationale: null,
        status: "missing",
        isManual: false,
      };
    }

    if (match.score === null || match.score === undefined) {
      return {
        competencyId: c.id,
        title: c.title,
        score: null,
        rationale: match.rationale || null,
        status: "insufficient",
        isManual: match.isManual,
      };
    }

    const numeric = Number(match.score);
    if (Number.isNaN(numeric)) {
      return {
        competencyId: c.id,
        title: c.title,
        score: null,
        rationale: match.rationale || null,
        status: "insufficient",
        isManual: match.isManual,
      };
    }

    return {
      competencyId: c.id,
      title: c.title,
      score: numeric,
      rationale: match.rationale || null,
      status: "scored",
      isManual: match.isManual,
    };
  });
};

const StudentEvaluations = ({ courseId, offeringId, canEdit = false }: StudentEvaluationsProps) => {
  const { compareText } = useFormatters();
  const [students, setStudents] = useState<StudentWithEvaluations[]>([]);
  const [courseCompetencies, setCourseCompetencies] = useState<CourseCompetency[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedStudents, setExpandedStudents] = useState<Set<string>>(new Set());
  const [bulkGenerating, setBulkGenerating] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });
  const [feedbackInputs, setFeedbackInputs] = useState<Record<string, string>>({});
  const [savingFeedback, setSavingFeedback] = useState<string | null>(null);
  const [editingEvaluation, setEditingEvaluation] = useState<string | null>(null);
  const [expandedEvaluations, setExpandedEvaluations] = useState<Set<string>>(new Set());
  
  // Manual evaluation dialog state
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [manualTargetStudent, setManualTargetStudent] = useState<StudentWithEvaluations | null>(null);
  const [manualForm, setManualForm] = useState({
    overallAssessment: "",
    strengths: "",
    weaknesses: "",
    recommendations: "",
  });
  const [savingManual, setSavingManual] = useState(false);

  // Edit evaluation dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editTargetEvaluation, setEditTargetEvaluation] = useState<{ student: StudentWithEvaluations; evaluation: Evaluation } | null>(null);
  const [editForm, setEditForm] = useState({
    overallAssessment: "",
    strengths: "",
    weaknesses: "",
    recommendations: "",
    instructorFeedback: "",
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirmation
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ studentId: string; evaluationId: string } | null>(null);

  // Timeline dialog state
  const [timelineDialogOpen, setTimelineDialogOpen] = useState(false);
  const [timelineStudent, setTimelineStudent] = useState<StudentWithEvaluations | null>(null);

  // Per-student Generate MCQ Questions dialog state
  const [courseClasses, setCourseClasses] = useState<CourseClass[]>([]);
  const [studentOfferingByUserId, setStudentOfferingByUserId] = useState<Record<string, string>>({});
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [generateSeed, setGenerateSeed] = useState<GenerateMcqSeed | undefined>(undefined);
  const [groupsByOffering, setGroupsByOffering] = useState<Record<string, OfferingGroup[]>>({});
  const [openingGenerateFor, setOpeningGenerateFor] = useState<string | null>(null);
  // Student whose Generate Questions click was intercepted because they have
  // no evaluation, or none recent enough (see RECENT_EVAL_MAX_AGE_MS).
  const [recentEvalPromptStudent, setRecentEvalPromptStudent] = useState<StudentWithEvaluations | null>(null);
  // Captured from the courses row so the per-student Generate Questions
  // handler can scope its student_admin_notes lookup (issue #541).
  const [courseInstitutionId, setCourseInstitutionId] = useState<string | null>(null);

  const openTimelineDialog = (student: StudentWithEvaluations) => {
    setTimelineStudent(student);
    setTimelineDialogOpen(true);
  };

  useEffect(() => {
    fetchStudents();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/offeringId change
  }, [courseId, offeringId]);

  const fetchStudents = async () => {
    setLoading(true);
    try {
      // Get course to find institution
      const { data: courseData } = await supabase
        .from("courses")
        .select("institution_id")
        .eq("id", courseId)
        .single();

      if (!courseData) throw new Error("Course not found");
      setCourseInstitutionId(courseData.institution_id ?? null);

      // Fetch course competencies to display inline per student
      const { data: competencyData } = await supabase
        .from("course_competencies")
        .select("id, title, order_num")
        .eq("course_id", courseId)
        .order("order_num");
      setCourseCompetencies(competencyData || []);

      let studentUserIds: string[] = [];
      // Track which offering a student belongs to so the per-student "Generate
      // Questions" trigger can seed the AudienceSelection. When offeringId is
      // provided, every student is in that offering; otherwise we pick the
      // first offering each student is enrolled in.
      const offeringByStudent: Record<string, string> = {};
      // Every offering a student is enrolled in — the per-assignment score
      // breakdown needs the full set, not just the first one.
      const offeringIdsByStudent = new Map<string, Set<string>>();
      // Track classes for this course so the Generate MCQ dialog can offer
      // its TargetAudienceSelector with a roster.
      let relevantClassIds: string[] = [];
      // Every offering of this course in scope — study guide activity hangs
      // off the offering, not the course.
      let courseOfferingIds: string[] = [];
      // Hoisted so both the enrollment phase (else branch) and the
      // nextCourseClasses construction phase can share the same map without
      // a second round-trip to the offerings table.
      const courseOfferingByClassId = new Map<string, string>();

      // If filtering by class (offering), get students enrolled in that class
      if (offeringId) {
        const { data: offeringData } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("id", offeringId)
          .single();

        courseOfferingIds = [offeringId];
        if (offeringData?.class_id) {
          relevantClassIds = [offeringData.class_id];
          const { data: enrollmentData } = await supabase
            .from("class_enrollments")
            .select("user_id")
            .eq("class_id", offeringData.class_id)
            .eq("role", "student");

          studentUserIds = enrollmentData?.map(e => e.user_id) || [];
          for (const uid of studentUserIds) {
            offeringByStudent[uid] = offeringId;
            offeringIdsByStudent.set(uid, new Set([offeringId]));
          }
        }
      } else {
        // No specific class filter — get all students enrolled in classes that offer this course
        const { data: offeringsData } = await supabase
          .from("offerings")
          .select("id, class_id")
          .eq("course_id", courseId);

        courseOfferingIds = (offeringsData || []).map((o) => o.id);
        for (const o of offeringsData || []) {
          if (o.class_id && !courseOfferingByClassId.has(o.class_id)) {
            courseOfferingByClassId.set(o.class_id, o.id);
          }
        }
        const classIds = [...courseOfferingByClassId.keys()];
        relevantClassIds = classIds;

        if (classIds.length > 0) {
          const { data: enrollmentData } = await supabase
            .from("class_enrollments")
            .select("user_id, class_id")
            .in("class_id", classIds)
            .eq("role", "student");

          const seen = new Set<string>();
          for (const row of enrollmentData || []) {
            if (!seen.has(row.user_id)) {
              seen.add(row.user_id);
              studentUserIds.push(row.user_id);
            }
            // First offering wins per student (stable ordering relies on the
            // initial offeringsData/enrollmentData ordering — good enough for
            // the seed; users can still change audience in the dialog).
            const off = courseOfferingByClassId.get(row.class_id);
            if (off) {
              if (!offeringByStudent[row.user_id]) {
                offeringByStudent[row.user_id] = off;
              }
              const set = offeringIdsByStudent.get(row.user_id) ?? new Set<string>();
              set.add(off);
              offeringIdsByStudent.set(row.user_id, set);
            }
          }
        }
      }

      // Load full CourseClass[] entries for the relevant classes so the
      // Generate MCQ dialog's TargetAudienceSelector can render a roster.
      let nextCourseClasses: CourseClass[] = [];
      if (relevantClassIds.length > 0) {
        const { data: classesData } = await supabase
          .from("classes")
          .select("id, name, grade_level_id, section_name, category, academic_period")
          .in("id", relevantClassIds);

        if (offeringId) {
          // Single class case: courseOfferingByClassId is empty at this point
          // (the else branch above wasn't taken), so seed it from offeringId.
          if (classesData && classesData[0]) courseOfferingByClassId.set(classesData[0].id, offeringId);
        }
        // No-offeringId case: courseOfferingByClassId was already populated
        // in the enrollment phase above — no second query needed.

        nextCourseClasses = (classesData || [])
          .filter((c) => courseOfferingByClassId.has(c.id))
          .map((c) => ({
            id: c.id,
            name: c.name,
            grade_level_id: c.grade_level_id,
            section_name: c.section_name,
            category: c.category,
            academic_period: c.academic_period,
            offering_id: courseOfferingByClassId.get(c.id)!,
          }));
      }
      setCourseClasses(nextCourseClasses);
      setStudentOfferingByUserId(offeringByStudent);

      // Fetch offering groups so the per-student Generate MCQ dialog can
      // offer group targeting alongside individual student targeting.
      const offeringIds = nextCourseClasses.map(c => c.offering_id);
      if (offeringIds.length > 0) {
        const { data: groupsData } = await supabase
          .from("offering_groups" as any)
          .select("id, offering_id, name, description, is_individual")
          .in("offering_id", offeringIds);
        const groupsMap: Record<string, OfferingGroup[]> = {};
        for (const g of (groupsData || []) as any[]) {
          if (g.is_individual) continue;
          if (!groupsMap[g.offering_id]) groupsMap[g.offering_id] = [];
          groupsMap[g.offering_id].push({ id: g.id, offering_id: g.offering_id, name: g.name, description: g.description ?? null });
        }
        setGroupsByOffering(groupsMap);
      } else {
        setGroupsByOffering({});
      }

      if (studentUserIds.length === 0) {
        setStudents([]);
        setLoading(false);
        return;
      }

      // Get profiles
      const { data: profilesData } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", studentUserIds);

      // Get quiz answers for each student (quiz_id separates practice from
      // formal quiz submissions).
      const { data: quizAnswersData } = await supabase
        .from("quiz_answers")
        .select("user_id, is_correct, answered_at, quiz_id, offering_id")
        .eq("course_id", courseId)
        .in("user_id", studentUserIds);

      // Both surfaces share one table now, so the student's turns are one
      // query joined through the session that owns them.
      const { data: chatSessionRows } = await supabase
        .from("chat_sessions")
        .select("id, user_id, open_question_id, study_session_id")
        .eq("course_id", courseId)
        .in("user_id", studentUserIds);

      const sessionOwners = new Map<string, { userId: string; isQuestion: boolean }>();
      (chatSessionRows || []).forEach((row) => {
        sessionOwners.set(row.id, {
          userId: row.user_id,
          isQuestion: !!row.open_question_id,
        });
      });

      const { data: chatMessageRows } = sessionOwners.size
        ? await supabase
            .from("chat_messages")
            .select("session_id, created_at")
            .in("session_id", [...sessionOwners.keys()])
            .eq("role", "user")
        : { data: [] };

      const openQuestionChatsData = (chatMessageRows || [])
        .filter((m) => sessionOwners.get(m.session_id)?.isQuestion)
        .map((m) => ({
          user_id: sessionOwners.get(m.session_id)!.userId,
          created_at: m.created_at,
        }));

      // Get open question grades. Ungraded rows are submissions still
      // awaiting instructor review — excluded here to mirror the evaluation
      // edge function's own filter, so the evidence gate counts the same rows.
      const { data: openQuestionGradesData } = await supabase
        .from("open_question_grades")
        .select("user_id, grade")
        .eq("course_id", courseId)
        .not("grade", "is", null)
        .in("user_id", studentUserIds);

      // Engagement: flashcard reviews (one row per card the student has
      // actually reviewed — mere deck opens are not tracked anywhere).
      const { data: flashcardReviewsData } = await supabase
        .from("flashcard_reviews")
        .select("user_id, last_reviewed")
        .eq("course_id", courseId)
        .in("user_id", studentUserIds);

      // Study guide answers carry the AI grader's verdict — they feed both
      // the engagement counts and the performance snapshot.
      const { data: studyGuideAnswersData } = courseOfferingIds.length
        ? await supabase
            .from("study_guide_answers")
            .select("user_id, grade, submitted_at, study_guide_id, offering_id")
            .in("offering_id", courseOfferingIds)
            .in("user_id", studentUserIds)
        : { data: [] };

      // Per-assignment score breakdown: which quizzes / study guides are
      // assigned to each student's offerings, and how they scored on the
      // completed ones.
      const { data: quizAssignmentRows } = courseOfferingIds.length
        ? await supabase
            .from("offering_quizzes")
            .select("offering_id, quiz_id, group_id")
            .in("offering_id", courseOfferingIds)
            .not("published_at", "is", null)
        : { data: [] };

      const { data: guideAssignmentRows } = courseOfferingIds.length
        ? await supabase
            .from("offering_study_guides")
            .select("offering_id, study_guide_id, group_id")
            .in("offering_id", courseOfferingIds)
            .not("published_at", "is", null)
        : { data: [] };

      // Group-scoped assignments only apply to that group's members.
      const assignmentGroupIds = [
        ...new Set(
          [...(quizAssignmentRows || []), ...(guideAssignmentRows || [])]
            .map((r) => r.group_id)
            .filter((g): g is string => !!g),
        ),
      ];
      const groupMembership = new Map<string, Set<string>>();
      if (assignmentGroupIds.length > 0) {
        const { data: memberRows } = await supabase
          .from("offering_group_members")
          .select("group_id, user_id")
          .in("group_id", assignmentGroupIds)
          .in("user_id", studentUserIds);
        (memberRows || []).forEach((m) => {
          const set = groupMembership.get(m.group_id) ?? new Set<string>();
          set.add(m.user_id);
          groupMembership.set(m.group_id, set);
        });
      }

      const assignedQuizIds = [...new Set((quizAssignmentRows || []).map((r) => r.quiz_id))];
      const assignedGuideIds = [...new Set((guideAssignmentRows || []).map((r) => r.study_guide_id))];

      const { data: quizTitleRows } = assignedQuizIds.length
        ? await supabase.from("quizzes").select("id, title").in("id", assignedQuizIds)
        : { data: [] };
      const quizTitleById = new Map((quizTitleRows || []).map((q) => [q.id, q.title]));

      const { data: guideTitleRows } = assignedGuideIds.length
        ? await supabase.from("study_guides").select("id, title").in("id", assignedGuideIds)
        : { data: [] };
      const guideTitleById = new Map((guideTitleRows || []).map((g) => [g.id, g.title]));

      // A quiz counts as completed once a session reached completed/expired —
      // the same rule AssignedQuizzesBoard applies before revealing scores.
      const { data: quizSessionRows } = assignedQuizIds.length
        ? await supabase
            .from("quiz_sessions")
            .select("user_id, quiz_id, status, offering_id")
            .in("quiz_id", assignedQuizIds)
            .in("user_id", studentUserIds)
        : { data: [] };

      const { data: guideProgressRows } = courseOfferingIds.length
        ? await supabase
            .from("study_guide_progress")
            .select("user_id, study_guide_id, completed_at, offering_id")
            .in("offering_id", courseOfferingIds)
            .in("user_id", studentUserIds)
        : { data: [] };

      // The study-session half of the same two queries.
      const studyProgressData = (chatSessionRows || [])
        .filter((row) => !!row.study_session_id)
        .map((row) => ({ id: row.id, user_id: row.user_id }));

      const studyMessagesData = (chatMessageRows || [])
        .filter((m) => sessionOwners.get(m.session_id)?.isQuestion === false)
        .map((m) => ({ progress_id: m.session_id, created_at: m.created_at }));

      // Get ALL saved evaluations (ordered by date desc)
      const { data: savedEvaluationsData } = await supabase
        .from("student_evaluations")
        .select("id, user_id, overall_assessment, strengths, weaknesses, recommendations, generated_at, instructor_feedback, is_manual, stats")
        .eq("course_id", courseId)
        .in("user_id", studentUserIds)
        .order("generated_at", { ascending: false });

      // Fetch competency scores for all evaluations in one round-trip
      const evaluationIds = savedEvaluationsData?.map(e => e.id) || [];
      const scoresByEvaluation = new Map<string, CompetencyScore[]>();
      if (evaluationIds.length > 0) {
        const { data: scoresData } = await supabase
          .from("evaluation_competency_scores")
          .select("evaluation_id, competency_id, score, rationale, is_manual, course_competencies(title)")
          .in("evaluation_id", evaluationIds);

        scoresData?.forEach((s: any) => {
          const list = scoresByEvaluation.get(s.evaluation_id) || [];
          list.push({
            competencyId: s.competency_id,
            competencyTitle: s.course_competencies?.title || "",
            score: s.score,
            rationale: s.rationale || "",
            isManual: !!s.is_manual,
          });
          scoresByEvaluation.set(s.evaluation_id, list);
        });
      }

      // Group evaluations by user
      const evaluationsByUser = new Map<string, SavedEvaluation[]>();
      savedEvaluationsData?.forEach(e => {
        if (!evaluationsByUser.has(e.user_id)) {
          evaluationsByUser.set(e.user_id, []);
        }
        evaluationsByUser.get(e.user_id)!.push(e);
      });

      // Build student data
      const studentsData: StudentWithEvaluations[] = studentUserIds.map(userId => {
        const profile = profilesData?.find(p => p.user_id === userId);
        const userQuizAnswers = quizAnswersData?.filter(qa => qa.user_id === userId) || [];
        const userOpenChats = openQuestionChatsData?.filter(oq => oq.user_id === userId) || [];
        const userGrades = openQuestionGradesData?.filter(g => g.user_id === userId) || [];
        const userProgressIds = studyProgressData?.filter(p => p.user_id === userId).map(p => p.id) || [];
        const userStudyMessages = studyMessagesData.filter(m => userProgressIds.includes(m.progress_id)) || [];
        const userFlashcardReviews = flashcardReviewsData?.filter(f => f.user_id === userId) || [];
        const userStudyGuideAnswers = (studyGuideAnswersData || []).filter(a => a.user_id === userId);

        // Calculate average grade
        const gradesWithValues = userGrades.filter(g => g.grade !== null);
        const avgGrade = gradesWithValues.length > 0
          ? gradesWithValues.reduce((sum, g) => sum + (g.grade || 0), 0) / gradesWithValues.length
          : null;

        const sgGraded = userStudyGuideAnswers.filter(a => a.grade !== null);
        const sgAvgGrade = sgGraded.length > 0
          ? sgGraded.reduce((sum, a) => sum + (a.grade || 0), 0) / sgGraded.length
          : null;

        // Per-assignment breakdown, restricted to assignments that actually
        // target this student (their offerings, and their groups when scoped).
        const memberOk = (groupId: string | null) =>
          !groupId || (groupMembership.get(groupId)?.has(userId) ?? false);
        const studentOfferings = offeringIdsByStudent.get(userId) ?? new Set<string>();

        // One entry per assignment (offering + quiz), not per quiz: the same
        // quiz assigned through two offerings is two rows, and work done in
        // one offering must not bleed into the other's row.
        const quizAssignmentsForStudent = new Map<string, { offeringId: string; quizId: string }>();
        (quizAssignmentRows || [])
          .filter((r) => studentOfferings.has(r.offering_id) && memberOk(r.group_id))
          .forEach((r) =>
            quizAssignmentsForStudent.set(`${r.offering_id}:${r.quiz_id}`, {
              offeringId: r.offering_id,
              quizId: r.quiz_id,
            }),
          );
        const quizScores: QuizScore[] = [...quizAssignmentsForStudent.values()].map(
          ({ offeringId: assignmentOfferingId, quizId }) => {
            // Legacy quiz_sessions / quiz_answers rows predate offering_id and
            // carry null — match them too, like AssignedQuizzesBoard does.
            const inOffering = (rowOfferingId: string | null) =>
              rowOfferingId === null || rowOfferingId === assignmentOfferingId;
            const answers = userQuizAnswers.filter(
              (qa) => qa.quiz_id === quizId && inOffering(qa.offering_id),
            );
            const completed = (quizSessionRows || []).some(
              (s) =>
                s.user_id === userId &&
                s.quiz_id === quizId &&
                inOffering(s.offering_id) &&
                (s.status === "completed" || s.status === "expired"),
            );
            const correct = answers.filter((qa) => qa.is_correct).length;
            const total = answers.length;
            return {
              offeringId: assignmentOfferingId,
              quizId,
              title: quizTitleById.get(quizId) || "Untitled quiz",
              completed,
              // Partial work stays hidden until the attempt is finalised,
              // matching the assigned-quizzes board.
              correct: completed ? correct : 0,
              total: completed ? total : 0,
              percentage: completed && total > 0 ? Math.round((correct / total) * 100) : null,
            };
          },
        );
        quizScores.sort((a, b) => compareText(a.title, b.title));

        const guideAssignmentsForStudent = new Map<string, { offeringId: string; guideId: string }>();
        (guideAssignmentRows || [])
          .filter((r) => studentOfferings.has(r.offering_id) && memberOk(r.group_id))
          .forEach((r) =>
            guideAssignmentsForStudent.set(`${r.offering_id}:${r.study_guide_id}`, {
              offeringId: r.offering_id,
              guideId: r.study_guide_id,
            }),
          );
        const studyGuideScores: StudyGuideScore[] = [...guideAssignmentsForStudent.values()].map(
          ({ offeringId: assignmentOfferingId, guideId }) => {
            const answers = userStudyGuideAnswers.filter(
              (a) => a.study_guide_id === guideId && a.offering_id === assignmentOfferingId,
            );
            const graded = answers.filter((a) => a.grade !== null);
            return {
              offeringId: assignmentOfferingId,
              studyGuideId: guideId,
              title: guideTitleById.get(guideId) || "Untitled study guide",
              completed: (guideProgressRows || []).some(
                (p) =>
                  p.user_id === userId &&
                  p.study_guide_id === guideId &&
                  p.offering_id === assignmentOfferingId &&
                  p.completed_at !== null,
              ),
              answered: answers.length,
              avgGrade: graded.length > 0
                ? graded.reduce((sum, a) => sum + (a.grade || 0), 0) / graded.length
                : null,
            };
          },
        );
        studyGuideScores.sort((a, b) => compareText(a.title, b.title));

        // Load all evaluations for this user
        const userEvaluations = evaluationsByUser.get(userId) || [];
        const evaluations: Evaluation[] = userEvaluations
          .filter(saved => saved.overall_assessment)
          .map(saved => ({
            id: saved.id,
            overallAssessment: saved.overall_assessment!,
            strengths: saved.strengths || [],
            weaknesses: saved.weaknesses || [],
            recommendations: saved.recommendations || [],
            hasEnoughData: true,
            generatedAt: saved.generated_at,
            instructorFeedback: saved.instructor_feedback,
            isManual: saved.is_manual,
            showFeedbackPrompt: false,
            competencyScores: scoresByEvaluation.get(saved.id),
            engagement: engagementFromStats(saved.stats),
          }));

        return {
          userId,
          fullName: profile?.full_name || null,
          email: profile?.email || null,
          quizAnswers: {
            total: userQuizAnswers.length,
            correct: userQuizAnswers.filter(qa => qa.is_correct).length,
          },
          practiceQuestions: userQuizAnswers.filter(qa => qa.quiz_id === null).length,
          openQuestionChats: userOpenChats.length,
          openQuestionGrades: {
            count: userGrades.length,
            avgGrade,
          },
          studySessionMessages: userStudyMessages.length,
          flashcardReviews: userFlashcardReviews.length,
          studyGuideAnswers: {
            total: userStudyGuideAnswers.length,
            avgGrade: sgAvgGrade,
          },
          quizScores,
          studyGuideScores,
          evaluations,
          isGenerating: false,
        };
      });

      // Sort by name
      studentsData.sort((a, b) => compareText((a.fullName || a.email || ""), b.fullName || b.email || ""));

      setStudents(studentsData);
    } catch (error: any) {
      console.error("Error fetching students:", error);
      toast.error("Failed to load students");
    } finally {
      setLoading(false);
    }
  };

  const generateEvaluation = async (student: StudentWithEvaluations) => {
    // Update state to show generating
    setStudents(prev => prev.map(s => 
      s.userId === student.userId ? { ...s, isGenerating: true } : s
    ));

    try {
      console.log("[eval] Invoking generate-student-evaluation for", student.userId);
      const { data, error } = await supabase.functions.invoke("generate-student-evaluation", {
        body: {
          courseId,
          userId: student.userId,
          // Section view: scope the study-guide evidence server-side to the
          // offering being looked at, matching the counts shown here.
          offeringId: offeringId ?? null,
          stats: {
            quizTotal: student.quizAnswers.total,
            quizCorrect: student.quizAnswers.correct,
            quizAccuracy: student.quizAnswers.total > 0
              ? Math.round((student.quizAnswers.correct / student.quizAnswers.total) * 100)
              : null,
            openQuestionChats: student.openQuestionChats,
            openQuestionGradesCount: student.openQuestionGrades.count,
            openQuestionAvgGrade: student.openQuestionGrades.avgGrade,
            studySessionMessages: student.studySessionMessages,
            flashcardReviews: student.flashcardReviews,
            studyGuideAnswers: student.studyGuideAnswers.total,
          },
        },
      });

      console.log("[eval] Edge function response:", { data, error });
      if (error) throw error;

      const generatedAt = new Date().toISOString();

      const evalData = data.evaluation;
      console.log("[eval] evalData:", { hasEnoughData: evalData?.hasEnoughData, keys: evalData ? Object.keys(evalData) : null });
      const overallAssessment = evalData.overallAssessment ?? evalData.progressSummary ?? "";
      const strengths = evalData.strengths ?? [
        ...(evalData.keyImprovements || []),
        ...(evalData.newStrengths || []),
        ...(evalData.resolvedIssues || []),
      ];
      const weaknesses = evalData.weaknesses ?? evalData.persistentChallenges ?? [];
      const recommendations = evalData.recommendations ?? [];
      const competencyScores: CompetencyScore[] = (evalData.competencyScores ?? [])
        .filter((cs: any) => !!cs?.competencyId)
        .map((cs: any): CompetencyScore => ({
          competencyId: cs.competencyId,
          competencyTitle: cs.competencyTitle || "",
          score: cs.score ?? null,
          rationale: cs.rationale || "",
          isManual: false,
        }));
      const engagement: EvaluationEngagement | null = evalData.engagement ?? null;

      // Save evaluation to database (INSERT, not upsert)
      if (evalData.hasEnoughData) {
        console.log("[eval] Inserting evaluation into DB:", { courseId, userId: student.userId, competencyScoresCount: competencyScores.length });
        const { data: insertedData, error: insertError } = await supabase
          .from("student_evaluations")
          .insert({
            course_id: courseId,
            user_id: student.userId,
            // The row has to say which section it belongs to: the write policy
            // refuses an unattributed evaluation from a section-restricted
            // instructor, because nothing in such a row places it in a section
            // they are allowed to write to (#1097/#1103).
            offering_id: offeringId ?? studentOfferingByUserId[student.userId] ?? null,
            student_name: student.fullName || student.email,
            overall_assessment: overallAssessment,
            strengths,
            weaknesses,
            recommendations,
            stats: {
              quizTotal: student.quizAnswers.total,
              quizCorrect: student.quizAnswers.correct,
              openQuestionChats: student.openQuestionChats,
              studySessionMessages: student.studySessionMessages,
              flashcardReviews: student.flashcardReviews,
              studyGuideAnswers: student.studyGuideAnswers.total,
              // The engagement axis travels with the evaluation so history
              // renders it without re-deriving counts that have since moved.
              engagement,
            },
            generated_at: generatedAt,
            is_manual: false,
          })
          .select("id")
          .single();

        if (insertError) {
          console.error("[eval] DB insert failed:", { code: insertError.code, message: insertError.message, details: insertError.details, hint: insertError.hint });
          throw insertError;
        }
        console.log("[eval] Evaluation saved successfully:", insertedData?.id);

        // Deduplicate by competency_id (AI may return the same competency twice)
        // Prefer entries with a non-null score.
        const deduped = new Map<string, CompetencyScore>();
        for (const cs of competencyScores) {
          const existing = deduped.get(cs.competencyId);
          if (!existing || (existing.score === null && cs.score !== null)) {
            deduped.set(cs.competencyId, cs);
          }
        }
        const uniqueScores = Array.from(deduped.values());

        if (uniqueScores.length > 0) {
          const { error: scoresError } = await supabase
            .from("evaluation_competency_scores")
            .insert(
              uniqueScores.map((cs) => ({
                evaluation_id: insertedData.id,
                competency_id: cs.competencyId,
                score: cs.score,
                rationale: cs.rationale || null,
              })),
            );
          if (scoresError) {
            console.error("[eval] Failed to insert competency scores:", scoresError);
            toast.warning("Evaluation saved but competency scores could not be recorded");
          }
        }

        const newEvaluation: Evaluation = {
          id: insertedData.id,
          overallAssessment,
          hasEnoughData: true,
          strengths,
          weaknesses,
          recommendations,
          competencyScores: uniqueScores,
          generatedAt,
          instructorFeedback: null,
          isManual: false,
          showFeedbackPrompt: true,
          engagement,
        };

        setStudents(prev => prev.map(s => 
          s.userId === student.userId 
            ? { ...s, evaluations: [newEvaluation, ...s.evaluations], isGenerating: false } 
            : s
        ));

        // Expand to show evaluation
        setExpandedStudents(prev => new Set([...prev, student.userId]));
      } else {
        setStudents(prev => prev.map(s => 
          s.userId === student.userId ? { ...s, isGenerating: false } : s
        ));
        toast.info("Not enough data to generate evaluation");
      }

    } catch (error: any) {
      console.error("[eval] Error generating evaluation:", error);
      const detail = error?.message || error?.code || String(error);
      toast.error(`Failed to generate evaluation: ${detail}`);
      setStudents(prev => prev.map(s =>
        s.userId === student.userId ? { ...s, isGenerating: false } : s
      ));
    }
  };

  const applyCompetencyScoreUpdate = (
    studentId: string,
    evaluationId: string | null,
    updated: CompetencyGridEntry,
  ) => {
    if (!evaluationId) return;
    setStudents((prev) =>
      prev.map((s) => {
        if (s.userId !== studentId) return s;
        return {
          ...s,
          evaluations: s.evaluations.map((ev) => {
            if (ev.id !== evaluationId) return ev;
            const existing = ev.competencyScores || [];
            const idx = existing.findIndex(
              (cs) => cs.competencyId === updated.competencyId,
            );
            const nextScore: CompetencyScore = {
              competencyId: updated.competencyId,
              competencyTitle: updated.title,
              score: updated.score,
              rationale: updated.rationale || "",
              isManual: updated.isManual,
            };
            const nextScores =
              idx >= 0
                ? existing.map((cs, i) => (i === idx ? nextScore : cs))
                : [...existing, nextScore];
            return { ...ev, competencyScores: nextScores };
          }),
        };
      }),
    );
  };

  const saveInstructorFeedback = async (evaluationId: string, studentId: string, feedback: string) => {
    setSavingFeedback(evaluationId);
    try {
      const { error } = await supabase
        .from("student_evaluations")
        .update({ instructor_feedback: feedback || null })
        .eq("id", evaluationId);

      if (error) throw error;

      setStudents(prev => prev.map(s => 
        s.userId === studentId
          ? { 
              ...s, 
              evaluations: s.evaluations.map(e => 
                e.id === evaluationId 
                  ? { ...e, instructorFeedback: feedback || null, showFeedbackPrompt: false }
                  : e
              )
            }
          : s
      ));
      setFeedbackInputs(prev => {
        const next = { ...prev };
        delete next[evaluationId];
        return next;
      });
      toast.success("Feedback saved");
    } catch (error) {
      console.error("Error saving feedback:", error);
      toast.error("Failed to save feedback");
    } finally {
      setSavingFeedback(null);
    }
  };

  const dismissFeedbackPrompt = (studentId: string, evaluationId: string) => {
    setStudents(prev => prev.map(s => 
      s.userId === studentId
        ? { 
            ...s, 
            evaluations: s.evaluations.map(e => 
              e.id === evaluationId ? { ...e, showFeedbackPrompt: false } : e
            )
          }
        : s
    ));
  };

  const toggleExpand = (userId: string) => {
    setExpandedStudents(prev => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  // Engagement volume for display: everything the student does on the
  // platform, graded or not.
  const getTotalInteractions = (student: StudentWithEvaluations) => {
    return student.quizAnswers.total +
           student.openQuestionChats +
           student.studySessionMessages +
           student.flashcardReviews +
           student.studyGuideAnswers.total;
  };

  // Graded evidence the edge function evaluates from — mirrors its own
  // MIN_EVIDENCE gate so "AI Evaluation For All Students" skips exactly the students the
  // function would refuse with hasEnoughData: false.
  const getEvaluationEvidence = (student: StudentWithEvaluations) => {
    return student.quizAnswers.total +
           student.studyGuideAnswers.total +
           student.openQuestionGrades.count;
  };

  const openManualDialog = (student: StudentWithEvaluations) => {
    setManualTargetStudent(student);
    setManualForm({
      overallAssessment: "",
      strengths: "",
      weaknesses: "",
      recommendations: "",
    });
    setManualDialogOpen(true);
  };

  // True when the student has enough evaluation context to seed the Generate
  // MCQ Questions dialog (3 weakest competencies + a special-instructions
  // string).
  const canGenerateForStudent = (student: StudentWithEvaluations): boolean => {
    const latest = student.evaluations[0];
    if (!latest) return false;
    const hasScored = (latest.competencyScores || []).some(
      (cs) => cs.score !== null && cs.score !== undefined && !Number.isNaN(Number(cs.score)),
    );
    const hasAssessment = !!(latest.overallAssessment && latest.overallAssessment.trim());
    const hasWeaknesses = (latest.weaknesses || []).some((w) => w && w.trim());
    return hasScored || hasAssessment || hasWeaknesses;
  };

  // Generate Questions seeds from the latest evaluation, so it should reflect
  // where the student stands now — an evaluation older than a week is stale.
  const hasRecentEvaluation = (student: StudentWithEvaluations): boolean => {
    const latest = student.evaluations[0];
    if (!latest) return false;
    const ageMs = Date.now() - new Date(latest.generatedAt).getTime();
    return Number.isFinite(ageMs) && ageMs <= RECENT_EVAL_MAX_AGE_MS;
  };

  const handleGenerateQuestionsClick = (student: StudentWithEvaluations) => {
    if (canGenerateForStudent(student) && hasRecentEvaluation(student)) {
      void openGenerateForStudent(student);
    } else {
      setRecentEvalPromptStudent(student);
    }
  };

  const openGenerateForStudent = async (student: StudentWithEvaluations) => {
    const latest = student.evaluations[0];
    if (!latest) return;
    if (openingGenerateFor) return;

    setOpeningGenerateFor(student.userId);

    const lowestThreeCompetencyIds = (latest.competencyScores || [])
      .filter((cs) => cs.score !== null && cs.score !== undefined && !Number.isNaN(Number(cs.score)))
      .slice()
      .sort((a, b) => Number(a.score) - Number(b.score))
      .slice(0, 3)
      .map((cs) => cs.competencyId);

    // Fetch student_admin_notes for this institution, oldest first so the
    // prepop reads chronologically. RLS silently filters disallowed rows
    // (issue #541 AC). On query error we degrade to no notes — the prepop
    // is best-effort and must never block the modal from opening.
    let noteBodies: string[] = [];
    if (courseInstitutionId) {
      try {
        const { data, error } = await supabase
          .from("student_admin_notes")
          .select("body")
          .eq("student_user_id", student.userId)
          .eq("institution_id", courseInstitutionId)
          .order("created_at", { ascending: true });
        if (error) throw error;
        noteBodies = ((data as { body: string }[]) || [])
          .map((r) => r.body);
      } catch (err) {
        console.warn("[student-eval] Failed to load student_admin_notes for prepop:", err);
      }
    }

    const instructions = buildStudentSpecialInstructions({
      overallAssessment: latest.overallAssessment,
      weaknesses: latest.weaknesses,
      noteBodies,
    });

    const studentOfferingId = offeringId ?? studentOfferingByUserId[student.userId];
    const studentLabel = student.fullName || student.email || "Student";

    setGenerateSeed({
      selectionMode: "competencies",
      selectedCompetencyIds: lowestThreeCompetencyIds,
      specialInstructions: instructions,
      audience: studentOfferingId
        ? {
            kind: "student",
            studentUserId: student.userId,
            label: studentLabel,
            offeringId: studentOfferingId,
            hasAdminNotes: false,
          }
        : { kind: "none" },
    });
    setGenerateDialogOpen(true);
    setOpeningGenerateFor(null);
  };

  const saveManualEvaluation = async () => {
    if (!manualTargetStudent || !manualForm.overallAssessment.trim()) {
      toast.error("Overall assessment is required");
      return;
    }

    setSavingManual(true);
    try {
      const generatedAt = new Date().toISOString();
      const { data: insertedData, error } = await supabase
        .from("student_evaluations")
        .insert({
          course_id: courseId,
          user_id: manualTargetStudent.userId,
          // Same attribution the generated evaluation needs — see above.
          offering_id: offeringId ?? studentOfferingByUserId[manualTargetStudent.userId] ?? null,
          student_name: manualTargetStudent.fullName || manualTargetStudent.email,
          overall_assessment: manualForm.overallAssessment.trim(),
          strengths: manualForm.strengths.trim() ? manualForm.strengths.split("\n").filter(Boolean) : [],
          weaknesses: manualForm.weaknesses.trim() ? manualForm.weaknesses.split("\n").filter(Boolean) : [],
          recommendations: manualForm.recommendations.trim() ? manualForm.recommendations.split("\n").filter(Boolean) : [],
          generated_at: generatedAt,
          is_manual: true,
        })
        .select("id")
        .single();

      if (error) throw error;

      const newEvaluation: Evaluation = {
        id: insertedData.id,
        overallAssessment: manualForm.overallAssessment.trim(),
        strengths: manualForm.strengths.trim() ? manualForm.strengths.split("\n").filter(Boolean) : [],
        weaknesses: manualForm.weaknesses.trim() ? manualForm.weaknesses.split("\n").filter(Boolean) : [],
        recommendations: manualForm.recommendations.trim() ? manualForm.recommendations.split("\n").filter(Boolean) : [],
        hasEnoughData: true,
        generatedAt,
        instructorFeedback: null,
        isManual: true,
      };

      setStudents(prev => prev.map(s => 
        s.userId === manualTargetStudent.userId 
          ? { ...s, evaluations: [newEvaluation, ...s.evaluations] } 
          : s
      ));

      setManualDialogOpen(false);
      setExpandedStudents(prev => new Set([...prev, manualTargetStudent.userId]));
      toast.success("Manual evaluation saved");
    } catch (error) {
      console.error("Error saving manual evaluation:", error);
      toast.error("Failed to save evaluation");
    } finally {
      setSavingManual(false);
    }
  };

  const openEditDialog = (student: StudentWithEvaluations, evaluation: Evaluation) => {
    setEditTargetEvaluation({ student, evaluation });
    setEditForm({
      overallAssessment: evaluation.overallAssessment,
      strengths: (evaluation.strengths || []).join("\n"),
      weaknesses: (evaluation.weaknesses || []).join("\n"),
      recommendations: (evaluation.recommendations || []).join("\n"),
      instructorFeedback: evaluation.instructorFeedback || "",
    });
    setEditDialogOpen(true);
  };

  const saveEditedEvaluation = async () => {
    if (!editTargetEvaluation || !editForm.overallAssessment.trim()) {
      toast.error("Overall assessment is required");
      return;
    }

    setSavingEdit(true);
    try {
      const { error } = await supabase
        .from("student_evaluations")
        .update({
          overall_assessment: editForm.overallAssessment.trim(),
          strengths: editForm.strengths.trim() ? editForm.strengths.split("\n").filter(Boolean) : [],
          weaknesses: editForm.weaknesses.trim() ? editForm.weaknesses.split("\n").filter(Boolean) : [],
          recommendations: editForm.recommendations.trim() ? editForm.recommendations.split("\n").filter(Boolean) : [],
          instructor_feedback: editForm.instructorFeedback.trim() || null,
        })
        .eq("id", editTargetEvaluation.evaluation.id);

      if (error) throw error;

      setStudents(prev => prev.map(s => 
        s.userId === editTargetEvaluation.student.userId 
          ? { 
              ...s, 
              evaluations: s.evaluations.map(e => 
                e.id === editTargetEvaluation.evaluation.id
                  ? {
                      ...e,
                      overallAssessment: editForm.overallAssessment.trim(),
                      strengths: editForm.strengths.trim() ? editForm.strengths.split("\n").filter(Boolean) : [],
                      weaknesses: editForm.weaknesses.trim() ? editForm.weaknesses.split("\n").filter(Boolean) : [],
                      recommendations: editForm.recommendations.trim() ? editForm.recommendations.split("\n").filter(Boolean) : [],
                      instructorFeedback: editForm.instructorFeedback.trim() || null,
                    }
                  : e
              )
            } 
          : s
      ));

      setEditDialogOpen(false);
      toast.success("Evaluation updated");
    } catch (error) {
      console.error("Error updating evaluation:", error);
      toast.error("Failed to update evaluation");
    } finally {
      setSavingEdit(false);
    }
  };

  const confirmDelete = (studentId: string, evaluationId: string) => {
    setDeleteTarget({ studentId, evaluationId });
    setDeleteConfirmOpen(true);
  };

  const deleteEvaluation = async () => {
    if (!deleteTarget) return;

    try {
      const { error } = await supabase
        .from("student_evaluations")
        .delete()
        .eq("id", deleteTarget.evaluationId);

      if (error) throw error;

      setStudents(prev => prev.map(s => 
        s.userId === deleteTarget.studentId 
          ? { ...s, evaluations: s.evaluations.filter(e => e.id !== deleteTarget.evaluationId) } 
          : s
      ));

      toast.success("Evaluation deleted");
    } catch (error) {
      console.error("Error deleting evaluation:", error);
      toast.error("Failed to delete evaluation");
    } finally {
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    }
  };

  const generateAllEvaluations = async () => {
    const studentsToEvaluate = students.filter(s => getEvaluationEvidence(s) >= 3);
    
    if (studentsToEvaluate.length === 0) {
      toast.info("No students have sufficient data for evaluation");
      return;
    }

    setBulkGenerating(true);
    setBulkProgress({ current: 0, total: studentsToEvaluate.length });

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < studentsToEvaluate.length; i++) {
      const student = studentsToEvaluate[i];
      setBulkProgress({ current: i + 1, total: studentsToEvaluate.length });

      try {
        const { data, error } = await supabase.functions.invoke("generate-student-evaluation", {
          body: {
            courseId,
            userId: student.userId,
            offeringId: offeringId ?? null,
            stats: {
              quizTotal: student.quizAnswers.total,
              quizCorrect: student.quizAnswers.correct,
              quizAccuracy: student.quizAnswers.total > 0
                ? Math.round((student.quizAnswers.correct / student.quizAnswers.total) * 100)
                : null,
              openQuestionChats: student.openQuestionChats,
              openQuestionGradesCount: student.openQuestionGrades.count,
              openQuestionAvgGrade: student.openQuestionGrades.avgGrade,
              studySessionMessages: student.studySessionMessages,
              flashcardReviews: student.flashcardReviews,
              studyGuideAnswers: student.studyGuideAnswers.total,
            },
          },
        });

        if (error) throw error;

        const generatedAt = new Date().toISOString();

        const evalData = data.evaluation;
        const overallAssessment = evalData.overallAssessment ?? evalData.progressSummary ?? "";
        const strengths = evalData.strengths ?? [
          ...(evalData.keyImprovements || []),
          ...(evalData.newStrengths || []),
          ...(evalData.resolvedIssues || []),
        ];
        const weaknesses = evalData.weaknesses ?? evalData.persistentChallenges ?? [];
        const recommendations = evalData.recommendations ?? [];
        const competencyScores: CompetencyScore[] = (evalData.competencyScores ?? [])
          .filter((cs: any) => !!cs?.competencyId)
          .map((cs: any): CompetencyScore => ({
            competencyId: cs.competencyId,
            competencyTitle: cs.competencyTitle || "",
            score: cs.score ?? null,
            rationale: cs.rationale || "",
            isManual: false,
          }));
        const engagement: EvaluationEngagement | null = evalData.engagement ?? null;

        // Save to database
        if (evalData.hasEnoughData) {
          const { data: insertedData, error: insertError } = await supabase
            .from("student_evaluations")
            .insert({
              course_id: courseId,
              user_id: student.userId,
              // Section attribution, same as the single-student path — a
              // section-restricted instructor's write policy refuses an
              // unattributed row (#1097/#1103).
              offering_id: offeringId ?? studentOfferingByUserId[student.userId] ?? null,
              student_name: student.fullName || student.email,
              overall_assessment: overallAssessment,
              strengths,
              weaknesses,
              recommendations,
              stats: {
                quizTotal: student.quizAnswers.total,
                quizCorrect: student.quizAnswers.correct,
                openQuestionChats: student.openQuestionChats,
                studySessionMessages: student.studySessionMessages,
                flashcardReviews: student.flashcardReviews,
                studyGuideAnswers: student.studyGuideAnswers.total,
                engagement,
              },
              generated_at: generatedAt,
              is_manual: false,
            })
            .select("id")
            .single();

          if (insertError) throw insertError;

          if (insertedData) {
            // Deduplicate by competency_id (AI may return the same competency twice)
            const dedupedBulk = new Map<string, CompetencyScore>();
            for (const cs of competencyScores) {
              const existing = dedupedBulk.get(cs.competencyId);
              if (!existing || (existing.score === null && cs.score !== null)) {
                dedupedBulk.set(cs.competencyId, cs);
              }
            }
            const uniqueScoresBulk = Array.from(dedupedBulk.values());

            if (uniqueScoresBulk.length > 0) {
              const { error: scoresError } = await supabase
                .from("evaluation_competency_scores")
                .insert(
                  uniqueScoresBulk.map((cs) => ({
                    evaluation_id: insertedData.id,
                    competency_id: cs.competencyId,
                    score: cs.score,
                    rationale: cs.rationale || null,
                  })),
                );
              if (scoresError) {
                console.error("Failed to insert competency scores:", scoresError);
                toast.warning(`Competency scores could not be saved for ${student.fullName || student.email}`);
              }
            }

            const newEvaluation: Evaluation = {
              id: insertedData.id,
              overallAssessment,
              hasEnoughData: true,
              strengths,
              weaknesses,
              recommendations,
              competencyScores,
              generatedAt,
              instructorFeedback: null,
              isManual: false,
              engagement,
            };

            setStudents(prev => prev.map(s =>
              s.userId === student.userId
                ? { ...s, evaluations: [newEvaluation, ...s.evaluations] }
                : s
            ));
          }
        }

        successCount++;
      } catch (error) {
        console.error(`Error generating evaluation for ${student.fullName}:`, error);
        errorCount++;
      }
    }

    setBulkGenerating(false);
    
    if (errorCount === 0) {
      toast.success(`Generated ${successCount} evaluations`);
    } else {
      toast.warning(`Generated ${successCount} evaluations, ${errorCount} failed`);
    }
  };

  const exportToPDF = async () => {
    const studentsWithEvaluations = students.filter(s => s.evaluations.length > 0);
    
    if (studentsWithEvaluations.length === 0) {
      toast.error("No evaluations to export");
      return;
    }

    try {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      
      const pageWidth = 595;
      const pageHeight = 842;
      const margin = 50;
      const lineHeight = 14;
      const maxWidth = pageWidth - margin * 2;

      // Helper to wrap text
      const wrapText = (text: string, maxWidthPx: number, fontSize: number): string[] => {
        const words = text.split(' ');
        const lines: string[] = [];
        let currentLine = '';
        
        for (const word of words) {
          const testLine = currentLine ? `${currentLine} ${word}` : word;
          const width = font.widthOfTextAtSize(testLine, fontSize);
          if (width > maxWidthPx && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
      };

      let page = pdfDoc.addPage([pageWidth, pageHeight]);
      let yPos = pageHeight - margin;

      // Title
      page.drawText("Student Evaluations Report", {
        x: margin,
        y: yPos,
        size: 18,
        font: boldFont,
        color: rgb(0.1, 0.1, 0.1),
      });
      yPos -= 25;

      page.drawText(`Generated: ${format(new Date(), "MMMM d, yyyy")}`, {
        x: margin,
        y: yPos,
        size: 10,
        font: font,
        color: rgb(0.4, 0.4, 0.4),
      });
      yPos -= 30;

      for (const student of studentsWithEvaluations) {
        // Use the latest evaluation for PDF export
        const evaluation = student.evaluations[0];
        if (!evaluation) continue;
        
        // Check if we need a new page
        if (yPos < 200) {
          page = pdfDoc.addPage([pageWidth, pageHeight]);
          yPos = pageHeight - margin;
        }

        // Student name
        page.drawText(student.fullName || student.email || "Unknown", {
          x: margin,
          y: yPos,
          size: 14,
          font: boldFont,
          color: rgb(0.1, 0.1, 0.4),
        });
        yPos -= 20;

        // Overall Assessment
        page.drawText("Overall Assessment:", {
          x: margin,
          y: yPos,
          size: 10,
          font: boldFont,
          color: rgb(0.2, 0.2, 0.2),
        });
        yPos -= lineHeight;

        const assessmentLines = wrapText(evaluation.overallAssessment, maxWidth, 9);
        for (const line of assessmentLines) {
          if (yPos < margin) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            yPos = pageHeight - margin;
          }
          page.drawText(line, {
            x: margin,
            y: yPos,
            size: 9,
            font: font,
            color: rgb(0.3, 0.3, 0.3),
          });
          yPos -= lineHeight;
        }
        yPos -= 5;

        // Strengths
        if (evaluation.strengths.length > 0) {
          page.drawText("Strengths:", {
            x: margin,
            y: yPos,
            size: 10,
            font: boldFont,
            color: rgb(0.1, 0.5, 0.2),
          });
          yPos -= lineHeight;

          for (const strength of evaluation.strengths) {
            const lines = wrapText(`• ${strength}`, maxWidth - 10, 9);
            for (const line of lines) {
              if (yPos < margin) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                yPos = pageHeight - margin;
              }
              page.drawText(line, {
                x: margin + 5,
                y: yPos,
                size: 9,
                font: font,
                color: rgb(0.3, 0.3, 0.3),
              });
              yPos -= lineHeight;
            }
          }
          yPos -= 5;
        }

        // Weaknesses
        if (evaluation.weaknesses.length > 0) {
          if (yPos < margin + 50) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            yPos = pageHeight - margin;
          }
          page.drawText("Areas for Improvement:", {
            x: margin,
            y: yPos,
            size: 10,
            font: boldFont,
            color: rgb(0.7, 0.2, 0.2),
          });
          yPos -= lineHeight;

          for (const weakness of evaluation.weaknesses) {
            const lines = wrapText(`• ${weakness}`, maxWidth - 10, 9);
            for (const line of lines) {
              if (yPos < margin) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                yPos = pageHeight - margin;
              }
              page.drawText(line, {
                x: margin + 5,
                y: yPos,
                size: 9,
                font: font,
                color: rgb(0.3, 0.3, 0.3),
              });
              yPos -= lineHeight;
            }
          }
          yPos -= 5;
        }

        // Recommendations
        if (evaluation.recommendations.length > 0) {
          if (yPos < margin + 50) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            yPos = pageHeight - margin;
          }
          page.drawText("Recommendations:", {
            x: margin,
            y: yPos,
            size: 10,
            font: boldFont,
            color: rgb(0.2, 0.3, 0.6),
          });
          yPos -= lineHeight;

          for (const rec of evaluation.recommendations) {
            const lines = wrapText(`• ${rec}`, maxWidth - 10, 9);
            for (const line of lines) {
              if (yPos < margin) {
                page = pdfDoc.addPage([pageWidth, pageHeight]);
                yPos = pageHeight - margin;
              }
              page.drawText(line, {
                x: margin + 5,
                y: yPos,
                size: 9,
                font: font,
                color: rgb(0.3, 0.3, 0.3),
              });
              yPos -= lineHeight;
            }
          }
        }

        // Instructor Feedback
        if (evaluation.instructorFeedback) {
          if (yPos < margin + 50) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
            yPos = pageHeight - margin;
          }
          page.drawText("Instructor Feedback:", {
            x: margin,
            y: yPos,
            size: 10,
            font: boldFont,
            color: rgb(0.5, 0.3, 0.6),
          });
          yPos -= lineHeight;

          const feedbackLines = wrapText(evaluation.instructorFeedback, maxWidth, 9);
          for (const line of feedbackLines) {
            if (yPos < margin) {
              page = pdfDoc.addPage([pageWidth, pageHeight]);
              yPos = pageHeight - margin;
            }
            page.drawText(line, {
              x: margin,
              y: yPos,
              size: 9,
              font: font,
              color: rgb(0.3, 0.3, 0.3),
            });
            yPos -= lineHeight;
          }
        }

        // Separator
        yPos -= 15;
        if (yPos > margin) {
          page.drawLine({
            start: { x: margin, y: yPos },
            end: { x: pageWidth - margin, y: yPos },
            thickness: 0.5,
            color: rgb(0.8, 0.8, 0.8),
          });
        }
        yPos -= 20;
      }

      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = url;
      link.download = `student-evaluations-${format(new Date(), "yyyy-MM-dd")}.pdf`;
      link.click();
      
      URL.revokeObjectURL(url);
      toast.success("PDF exported successfully");
    } catch (error) {
      console.error("Error exporting PDF:", error);
      toast.error("Failed to export PDF");
    }
  };

  const filteredStudents = students.filter(s => {
    const query = searchQuery.toLowerCase();
    return (s.fullName?.toLowerCase().includes(query) || 
            s.email?.toLowerCase().includes(query));
  });

  const studentsWithEvaluation = students.filter(s => s.evaluations.length > 0).length;
  const totalEvaluations = students.reduce((sum, s) => sum + s.evaluations.length, 0);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                Student Evaluations
              </CardTitle>
              <CardDescription>
                Two axes per student: platform engagement, and AI evaluations of graded work (quizzes, AI interactions, study guides), plus manual evaluations, with history
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <Badge variant="secondary" className="whitespace-nowrap">{students.length} students</Badge>
              <Badge variant="outline" className="whitespace-nowrap">{totalEvaluations} evaluations</Badge>
              <Button
                onClick={generateAllEvaluations}
                disabled={bulkGenerating}
                size="sm"
              >
                {bulkGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    {bulkProgress.current}/{bulkProgress.total}
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 mr-2" />
                    AI Evaluation For All Students
                  </>
                )}
              </Button>
              {studentsWithEvaluation > 0 && (
                <Button
                  onClick={exportToPDF}
                  variant="outline"
                  size="sm"
                  disabled
                  title="Export PDF temporarily disabled"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export PDF
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search students..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Students List */}
          {filteredStudents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {students.length === 0 ? "No students enrolled in this course" : "No students match your search"}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredStudents.map((student) => {
                const isExpanded = expandedStudents.has(student.userId);
                const totalInteractions = getTotalInteractions(student);
                const latestEvaluation = student.evaluations[0];

                return (
                  <div 
                    key={student.userId}
                    className="border rounded-lg overflow-hidden"
                  >
                    {/* Student Row */}
                    <div 
                      className="flex items-center gap-3 p-4 bg-card hover:bg-secondary/30 cursor-pointer transition-colors"
                      onClick={() => toggleExpand(student.userId)}
                    >
                      <button className="text-muted-foreground">
                        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>
                      
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate flex items-center gap-2">
                          <Link
                            to={`/student/${student.userId}/profile`}
                            onClick={(e) => e.stopPropagation()}
                            className="hover:underline"
                          >
                            {student.fullName || "Unknown"}
                          </Link>
                          {student.evaluations.length > 0 && (
                            <Badge variant="secondary" className="text-xs">
                              {student.evaluations.length} eval{student.evaluations.length !== 1 ? "s" : ""}
                            </Badge>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {student.email}
                        </div>
                      </div>

                      {/* Quick Stats */}
                      <div className="hidden sm:flex items-center gap-4 text-sm text-muted-foreground">
                        <div title="Engagement: practice questions + flashcards + AI chats + study guide answers">
                          {totalInteractions} interactions
                        </div>
                        {latestEvaluation && (
                          <div title="Last evaluation">
                            {format(new Date(latestEvaluation.generatedAt), "MMM d")}
                          </div>
                        )}
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-2">
                        {/* Evaluation split button: AI Evaluation is the main
                            action, manual entry lives in the dropdown. */}
                        <div className="flex items-center">
                          <Button
                            size="sm"
                            className="rounded-r-none"
                            onClick={(e) => {
                              e.stopPropagation();
                              generateEvaluation(student);
                            }}
                            disabled={student.isGenerating}
                          >
                            {student.isGenerating ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin mr-1" />
                                Generating...
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-4 h-4 mr-1" />
                                AI Evaluation
                              </>
                            )}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
                                onClick={(e) => e.stopPropagation()}
                                disabled={student.isGenerating}
                                aria-label="More evaluation actions"
                              >
                                <ChevronDown className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <DropdownMenuItem
                                onSelect={() => openManualDialog(student)}
                              >
                                <Plus className="w-4 h-4 mr-2" />
                                Add Manual Evaluation
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleGenerateQuestionsClick(student);
                          }}
                          disabled={!!openingGenerateFor}
                          title="Generate targeted MCQ practice for this student"
                        >
                          {openingGenerateFor === student.userId ? (
                            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                          ) : (
                            <Sparkles className="w-4 h-4 mr-1" />
                          )}
                          Generate Questions
                        </Button>
                      </div>
                    </div>

                    {/* Expanded Content */}
                    {isExpanded && (
                      <div className="border-t bg-secondary/10 p-4 space-y-4">
                        {/* Axis 1 — Engagement: activity volume on the platform */}
                        <div className="rounded-lg border bg-background p-4">
                          <h4 className="font-medium text-sm flex items-center gap-2 mb-3 text-sky-600 dark:text-sky-400">
                            <Activity className="w-4 h-4" />
                            Engagement
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold">{student.practiceQuestions}</div>
                              <div className="text-xs text-muted-foreground">Practice Questions</div>
                            </div>
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold">{student.flashcardReviews}</div>
                              <div className="text-xs text-muted-foreground">Flashcards Reviewed</div>
                            </div>
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold">{student.openQuestionChats + student.studySessionMessages}</div>
                              <div className="text-xs text-muted-foreground">AI Chat Messages</div>
                            </div>
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold">{student.studyGuideAnswers.total}</div>
                              <div className="text-xs text-muted-foreground">Study Guide Answers</div>
                            </div>
                          </div>
                        </div>

                        {/* Axis 2 — Performance: graded work only */}
                        <div className="rounded-lg border bg-background p-4">
                          <h4 className="font-medium text-sm flex items-center gap-2 mb-3 text-primary">
                            <BarChart2 className="w-4 h-4" />
                            Performance
                          </h4>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold text-primary">
                                {student.quizAnswers.total > 0
                                  ? `${Math.round((student.quizAnswers.correct / student.quizAnswers.total) * 100)}%`
                                  : "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">Quiz Accuracy</div>
                            </div>
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold">
                                {student.openQuestionGrades.avgGrade !== null
                                  ? student.openQuestionGrades.avgGrade.toFixed(1)
                                  : "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">Avg Open-Answer Grade</div>
                            </div>
                            <div className="bg-secondary/30 rounded-lg p-3 text-center">
                              <div className="text-2xl font-bold">
                                {student.studyGuideAnswers.avgGrade !== null
                                  ? student.studyGuideAnswers.avgGrade.toFixed(1)
                                  : "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">Study Guide Avg</div>
                            </div>
                          </div>

                          {/* Per-assignment breakdown: score on each quiz and study guide */}
                          {(student.quizScores.length > 0 || student.studyGuideScores.length > 0) && (
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1.5">Quizzes</div>
                                {student.quizScores.length === 0 ? (
                                  <div className="text-xs text-muted-foreground italic">No quizzes assigned</div>
                                ) : (
                                  <div className="space-y-1">
                                    {student.quizScores.map((q) => (
                                      <div
                                        key={`${q.offeringId}:${q.quizId}`}
                                        className="flex items-center justify-between gap-2 rounded-md bg-secondary/30 px-2.5 py-1.5 text-sm"
                                      >
                                        <span className="truncate" title={q.title}>{q.title}</span>
                                        {q.completed ? (
                                          <span className="shrink-0 font-medium tabular-nums">
                                            {q.percentage !== null ? `${q.percentage}%` : "—"}
                                            {q.total > 0 && (
                                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                                ({q.correct}/{q.total})
                                              </span>
                                            )}
                                          </span>
                                        ) : (
                                          <Badge variant="outline" className="shrink-0">Open</Badge>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-1.5">Study Guides</div>
                                {student.studyGuideScores.length === 0 ? (
                                  <div className="text-xs text-muted-foreground italic">No study guides assigned</div>
                                ) : (
                                  <div className="space-y-1">
                                    {student.studyGuideScores.map((sg) => (
                                      <div
                                        key={`${sg.offeringId}:${sg.studyGuideId}`}
                                        className="flex items-center justify-between gap-2 rounded-md bg-secondary/30 px-2.5 py-1.5 text-sm"
                                      >
                                        <span className="truncate" title={sg.title}>{sg.title}</span>
                                        <span className="flex shrink-0 items-center gap-1.5">
                                          {sg.avgGrade !== null && (
                                            <span className="font-medium tabular-nums">
                                              {sg.avgGrade.toFixed(1)}
                                              <span className="ml-1 text-xs font-normal text-muted-foreground">avg</span>
                                            </span>
                                          )}
                                          {sg.completed ? (
                                            sg.avgGrade === null && (
                                              <span className="text-xs text-muted-foreground">
                                                {sg.answered > 0 ? "Awaiting grading" : "Completed"}
                                              </span>
                                            )
                                          ) : (
                                            <Badge variant="outline">Open</Badge>
                                          )}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Course Competency Snapshot (from latest evaluation) */}
                        {courseCompetencies.length > 0 && (
                          <div className="rounded-lg border bg-background p-4">
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="font-medium text-sm flex items-center gap-2 text-purple-600 dark:text-purple-400">
                                <BarChart2 className="w-4 h-4" />
                                Course Competencies
                              </h4>
                              {latestEvaluation ? (
                                <span className="text-xs text-muted-foreground">
                                  From latest evaluation ({format(new Date(latestEvaluation.generatedAt), "MMM d, yyyy")})
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  Generate an evaluation to populate scores
                                </span>
                              )}
                            </div>
                            <TooltipProvider delayDuration={200}>
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {mapScoresToCompetencies(
                                  courseCompetencies,
                                  latestEvaluation?.competencyScores,
                                ).map((entry) => (
                                  <CompetencyScoreEditor
                                    key={entry.competencyId}
                                    entry={entry}
                                    evaluationId={latestEvaluation?.id ?? null}
                                    canEdit={canEdit}
                                    hasEvaluation={!!latestEvaluation}
                                    onSaved={(updated) =>
                                      applyCompetencyScoreUpdate(
                                        student.userId,
                                        latestEvaluation?.id ?? null,
                                        updated,
                                      )
                                    }
                                  />
                                ))}
                              </div>
                            </TooltipProvider>
                          </div>
                        )}

                        {/* Evaluations */}
                        {student.evaluations.length === 0 ? (
                          <div className="text-center py-6 text-muted-foreground">
                            <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                            <p>No evaluations yet</p>
                            <p className="text-sm">Generate an AI evaluation or add a manual one</p>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            {/* Timeline button */}
                            {student.evaluations.length > 1 && (
                              <div className="flex items-center gap-2 justify-center mb-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => openTimelineDialog(student)}
                                >
                                  <GitCompareArrows className="w-4 h-4 mr-2" />
                                  Compare Progress
                                </Button>
                              </div>
                            )}

                            {/* Render evaluations as collapsible containers per date */}
                            <div className="space-y-2">
                              {student.evaluations.map((evaluation, evalIndex) => {
                                const isFirstEval = evalIndex === 0;
                                const evalKey = `${student.userId}-${evaluation.id}`;
                                const isEvalExpanded = expandedEvaluations.has(evalKey) || isFirstEval;
                                
                                const toggleEvalExpand = () => {
                                  setExpandedEvaluations(prev => {
                                    const next = new Set(prev);
                                    if (next.has(evalKey)) {
                                      next.delete(evalKey);
                                    } else {
                                      next.add(evalKey);
                                    }
                                    return next;
                                  });
                                };
                                
                                return (
                                  <Collapsible
                                    key={evaluation.id}
                                    open={isEvalExpanded}
                                    onOpenChange={toggleEvalExpand}
                                    className="border rounded-lg overflow-hidden"
                                  >
                                    <CollapsibleTrigger className="w-full">
                                      <div className="flex items-center justify-between p-3 bg-secondary/30 hover:bg-secondary/50 transition-colors">
                                        <div className="flex items-center gap-2">
                                          {isEvalExpanded ? (
                                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                          ) : (
                                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                          )}
                                          <Calendar className="w-4 h-4 text-muted-foreground" />
                                          <span className="font-medium text-sm">
                                            {format(new Date(evaluation.generatedAt), "MMMM d, yyyy")}
                                          </span>
                                          <span className="text-xs text-muted-foreground">
                                            {format(new Date(evaluation.generatedAt), "h:mm a")}
                                          </span>
                                          {evaluation.isManual ? (
                                            <Badge variant="outline" className="gap-1 text-xs">
                                              <User className="w-3 h-3" />
                                              Manual
                                            </Badge>
                                          ) : (
                                            <Badge variant="secondary" className="gap-1 text-xs">
                                              <Bot className="w-3 h-3" />
                                              AI
                                            </Badge>
                                          )}
                                          {isFirstEval && (
                                            <Badge className="text-xs">Latest</Badge>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => openEditDialog(student, evaluation)}
                                          >
                                            <Pencil className="w-4 h-4" />
                                          </Button>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="text-destructive hover:text-destructive"
                                            onClick={() => confirmDelete(student.userId, evaluation.id)}
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </Button>
                                        </div>
                                      </div>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent>
                                      <div className="p-4 space-y-4 bg-background">
                                        {/* Axis 1 — Engagement */}
                                        {evaluation.engagement && (
                                          <div className="p-4 bg-sky-500/5 border border-sky-500/20 rounded-lg">
                                            <div className="flex items-center gap-2 mb-2">
                                              <h4 className="font-medium text-sm flex items-center gap-2 text-sky-600 dark:text-sky-400">
                                                <Activity className="w-4 h-4" />
                                                Engagement
                                              </h4>
                                              {evaluation.engagement.level && (
                                                <Badge
                                                  variant={
                                                    evaluation.engagement.level === "high"
                                                      ? "default"
                                                      : evaluation.engagement.level === "moderate"
                                                        ? "secondary"
                                                        : "destructive"
                                                  }
                                                  className="text-xs capitalize"
                                                >
                                                  {evaluation.engagement.level}
                                                </Badge>
                                              )}
                                            </div>
                                            <p className="text-sm">{evaluation.engagement.summary}</p>
                                          </div>
                                        )}

                                        {/* Axis 2 — Evaluation of graded work */}
                                        <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
                                          <h4 className="font-medium text-sm text-primary mb-2">Overall Assessment</h4>
                                          <p className="text-sm">{evaluation.overallAssessment}</p>
                                        </div>

                                        {/* Strengths */}
                                        {evaluation.strengths?.length > 0 && (
                                          <div>
                                            <h4 className="font-medium text-sm flex items-center gap-2 mb-2 text-green-600 dark:text-green-400">
                                              <TrendingUp className="w-4 h-4" />
                                              Strengths
                                            </h4>
                                            <ul className="space-y-1.5">
                                              {evaluation.strengths.map((strength, i) => (
                                                <li key={i} className="text-sm flex items-start gap-2">
                                                  <span className="text-green-500 mt-1">•</span>
                                                  {strength}
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}

                                        {/* Weaknesses */}
                                        {evaluation.weaknesses?.length > 0 && (
                                          <div>
                                            <h4 className="font-medium text-sm flex items-center gap-2 mb-2 text-red-600 dark:text-red-400">
                                              <TrendingDown className="w-4 h-4" />
                                              Areas for Improvement
                                            </h4>
                                            <ul className="space-y-1.5">
                                              {evaluation.weaknesses.map((weakness, i) => (
                                                <li key={i} className="text-sm flex items-start gap-2">
                                                  <span className="text-red-500 mt-1">•</span>
                                                  {weakness}
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}

                                        {/* Recommendations */}
                                        {evaluation.recommendations?.length > 0 && (
                                          <div>
                                            <h4 className="font-medium text-sm flex items-center gap-2 mb-2 text-blue-600 dark:text-blue-400">
                                              <Sparkles className="w-4 h-4" />
                                              Recommendations
                                            </h4>
                                            <ul className="space-y-1.5">
                                              {evaluation.recommendations.map((rec, i) => (
                                                <li key={i} className="text-sm flex items-start gap-2">
                                                  <span className="text-blue-500 mt-1">•</span>
                                                  {rec}
                                                </li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}

                                        {/* Competency Scores */}
                                        {evaluation.competencyScores && evaluation.competencyScores.length > 0 && (
                                          <div>
                                            <h4 className="font-medium text-sm flex items-center gap-2 mb-3 text-purple-600 dark:text-purple-400">
                                              <BarChart2 className="w-4 h-4" />
                                              Competency Scores
                                            </h4>
                                            <div className="space-y-2">
                                              {evaluation.competencyScores.map((cs, i) => (
                                                <div key={i} className="flex items-start gap-3 p-2 rounded-lg bg-secondary/30">
                                                  <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 mb-1">
                                                      <span className="text-sm font-medium truncate">{cs.competencyTitle}</span>
                                                      {cs.score !== null ? (
                                                        <Badge
                                                          variant={cs.score >= 70 ? "default" : cs.score >= 40 ? "secondary" : "destructive"}
                                                          className="shrink-0"
                                                        >
                                                          {cs.score}/100
                                                        </Badge>
                                                      ) : (
                                                        <Badge variant="outline" className="shrink-0 text-muted-foreground">
                                                          Not enough data
                                                        </Badge>
                                                      )}
                                                    </div>
                                                    <p className="text-xs text-muted-foreground">{cs.rationale}</p>
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}

                                        {/* Instructor Feedback Prompt (only for latest AI eval) */}
                                        {evalIndex === 0 && !evaluation.isManual && evaluation.showFeedbackPrompt && !evaluation.instructorFeedback && (
                                          <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg space-y-3">
                                            <div className="flex items-start gap-2">
                                              <MessageSquare className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                                              <div>
                                                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                                                  Does this align with your perspective?
                                                </p>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                  Add any additional feedback or areas for development
                                                </p>
                                              </div>
                                            </div>
                                            <Textarea
                                              placeholder="Add your feedback here (optional)..."
                                              value={feedbackInputs[evaluation.id] || ""}
                                              onChange={(e) => setFeedbackInputs(prev => ({ ...prev, [evaluation.id]: e.target.value }))}
                                              className="text-sm min-h-[80px]"
                                            />
                                            <div className="flex items-center gap-2 justify-end">
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => dismissFeedbackPrompt(student.userId, evaluation.id)}
                                              >
                                                <X className="w-4 h-4 mr-1" />
                                                Skip
                                              </Button>
                                              <Button
                                                size="sm"
                                                onClick={() => saveInstructorFeedback(evaluation.id, student.userId, feedbackInputs[evaluation.id] || "")}
                                                disabled={savingFeedback === evaluation.id}
                                              >
                                                {savingFeedback === evaluation.id ? (
                                                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                                                ) : (
                                                  <Check className="w-4 h-4 mr-1" />
                                                )}
                                                Save Feedback
                                              </Button>
                                            </div>
                                          </div>
                                        )}

                                        {/* Saved Instructor Feedback */}
                                        {evaluation.instructorFeedback && (
                                          <div className="p-4 bg-violet-500/10 border border-violet-500/20 rounded-lg">
                                            <h4 className="font-medium text-sm flex items-center gap-2 mb-2 text-violet-600 dark:text-violet-400">
                                              <MessageSquare className="w-4 h-4" />
                                              Instructor Feedback
                                            </h4>
                                            <p className="text-sm">{evaluation.instructorFeedback}</p>
                                          </div>
                                        )}
                                      </div>
                                    </CollapsibleContent>
                                  </Collapsible>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual Evaluation Dialog */}
      <Dialog open={manualDialogOpen} onOpenChange={setManualDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Manual Evaluation</DialogTitle>
            <DialogDescription>
              Create a manual evaluation for {manualTargetStudent?.fullName || manualTargetStudent?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Overall Assessment *</label>
              <Textarea
                placeholder="Write your overall assessment of the student's performance..."
                value={manualForm.overallAssessment}
                onChange={(e) => setManualForm(prev => ({ ...prev, overallAssessment: e.target.value }))}
                className="min-h-[100px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Strengths (one per line)</label>
              <Textarea
                placeholder="Enter strengths, one per line..."
                value={manualForm.strengths}
                onChange={(e) => setManualForm(prev => ({ ...prev, strengths: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Areas for Improvement (one per line)</label>
              <Textarea
                placeholder="Enter areas for improvement, one per line..."
                value={manualForm.weaknesses}
                onChange={(e) => setManualForm(prev => ({ ...prev, weaknesses: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Recommendations (one per line)</label>
              <Textarea
                placeholder="Enter recommendations, one per line..."
                value={manualForm.recommendations}
                onChange={(e) => setManualForm(prev => ({ ...prev, recommendations: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveManualEvaluation} disabled={savingManual}>
              {savingManual ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4 mr-2" />
                  Save Evaluation
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Evaluation Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Evaluation</DialogTitle>
            <DialogDescription>
              Edit evaluation for {editTargetEvaluation?.student.fullName || editTargetEvaluation?.student.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Overall Assessment *</label>
              <Textarea
                placeholder="Write your overall assessment..."
                value={editForm.overallAssessment}
                onChange={(e) => setEditForm(prev => ({ ...prev, overallAssessment: e.target.value }))}
                className="min-h-[100px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Strengths (one per line)</label>
              <Textarea
                placeholder="Enter strengths, one per line..."
                value={editForm.strengths}
                onChange={(e) => setEditForm(prev => ({ ...prev, strengths: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Areas for Improvement (one per line)</label>
              <Textarea
                placeholder="Enter areas for improvement, one per line..."
                value={editForm.weaknesses}
                onChange={(e) => setEditForm(prev => ({ ...prev, weaknesses: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Recommendations (one per line)</label>
              <Textarea
                placeholder="Enter recommendations, one per line..."
                value={editForm.recommendations}
                onChange={(e) => setEditForm(prev => ({ ...prev, recommendations: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">Instructor Feedback</label>
              <Textarea
                placeholder="Add instructor feedback..."
                value={editForm.instructorFeedback}
                onChange={(e) => setEditForm(prev => ({ ...prev, instructorFeedback: e.target.value }))}
                className="min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveEditedEvaluation} disabled={savingEdit}>
              {savingEdit ? (
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
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Evaluation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this evaluation? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteEvaluation} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Generate Questions needs a recent evaluation to seed from */}
      <AlertDialog
        open={!!recentEvalPromptStudent}
        onOpenChange={(open) => {
          if (!open) setRecentEvalPromptStudent(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run an AI evaluation first?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const student = recentEvalPromptStudent;
                if (!student) return null;
                const name = student.fullName || student.email || "This student";
                const latest = student.evaluations[0];
                if (!latest) {
                  return `${name} has no evaluation yet. Generated questions are targeted at the weaknesses found in a recent evaluation, so run an AI evaluation first.`;
                }
                if (!hasRecentEvaluation(student)) {
                  return `The latest evaluation for ${name} is from ${format(new Date(latest.generatedAt), "MMM d, yyyy")} — more than a week old. Run a fresh AI evaluation so the generated questions target where the student stands today.`;
                }
                return `The latest evaluation for ${name} has no scores or weaknesses to target. Run an AI evaluation first to seed question generation.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {recentEvalPromptStudent &&
              canGenerateForStudent(recentEvalPromptStudent) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const student = recentEvalPromptStudent;
                    setRecentEvalPromptStudent(null);
                    if (student) void openGenerateForStudent(student);
                  }}
                >
                  Generate Anyway
                </Button>
              )}
            <AlertDialogAction
              onClick={() => {
                const student = recentEvalPromptStudent;
                setRecentEvalPromptStudent(null);
                if (student) generateEvaluation(student);
              }}
            >
              <Sparkles className="w-4 h-4 mr-1" />
              Run AI Evaluation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Per-student Generate MCQ Questions Dialog (shared with Course Questions tab) */}
      <GenerateMcqDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
        courseId={courseId}
        classes={courseClasses}
        groupsByOffering={groupsByOffering}
        seed={generateSeed}
      />

      {/* Timeline Dialog */}
      <Dialog open={timelineDialogOpen} onOpenChange={setTimelineDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCompareArrows className="w-5 h-5" />
              Evaluation Timeline: {timelineStudent?.fullName || timelineStudent?.email}
            </DialogTitle>
            <DialogDescription>
              Track student progress across evaluations over time
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {timelineStudent && (
              <EvaluationTimeline 
                evaluations={timelineStudent.evaluations}
                studentName={timelineStudent.fullName || timelineStudent.email || "Student"}
                courseId={courseId}
                userId={timelineStudent.userId}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default StudentEvaluations;
