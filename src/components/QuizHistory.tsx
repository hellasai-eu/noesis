import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { processLatexContent } from "@/lib/latex-utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  History,
  Loader2, 
  CheckCircle,
  XCircle,
  User,
  ArrowUpDown,
  Clock,
  ClipboardList,
  Users,
  TrendingUp,
  Target,
  Award,
  BarChart3,
  Calendar,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Edit2,
  GraduationCap,
  Shapes,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { format, startOfDay, endOfDay, isWithinInterval, subDays, subMonths } from "date-fns";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { DateRange } from "react-day-picker";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import {
  classificationAssignmentsFromAnswerKey,
  classificationCategoriesFromPayload,
  classificationItemsFromPayload,
  fillGapsAcceptableAnswersFromAnswerKey,
  mcqCorrectIndicesFromAnswerKey,
  mcqOptionsFromPayload,
  orderingItemsFromPayload,
} from "@/lib/question-payload";
import { ALL_QUESTION_TYPES, QUESTION_TYPE_LABELS } from "@/lib/unified-question";
import type { QuestionType } from "@/types/question";
import type { Json } from "@/integrations/supabase/types";
import { useFormatters } from "@/i18n/formatters";

/**
 * Per-type display data for one answer row, discriminated the same way the
 * `quiz_answers.submission` jsonb is (`nonMcqSubmission` in
 * src/lib/quiz-non-mcq.ts): `selected_indices` for MCQ, `{ ordering }`,
 * `{ fill_gaps }`, `{ classification }` or `{ open_text }` for the rest.
 */
type AnswerDetail =
  // The question row could not be resolved (deleted, or an unrecognized
  // type) — the submission can't be decoded, so show nothing rather than
  // guessing a shape.
  | { kind: "unknown" }
  | {
      kind: "mcq";
      options: string[];
      // Multi-correct (#592). Legacy single-index rows are normalized to a
      // 1-element array when read from `quiz_answers`.
      selected_indices: number[];
      correct_indices: number[];
    }
  | { kind: "open"; text: string }
  | { kind: "ordering"; submitted: string[]; correct_order: string[] }
  | {
      kind: "fill_gaps";
      inputs: string[];
      gaps: { ordinal: number; acceptable: string[] }[];
    }
  | {
      kind: "classification";
      rows: { item: string; chosen: string | null; correct: string | null }[];
    };

interface QuizAnswer {
  id: string;
  user_id: string;
  question_id: string;
  quiz_id: string | null;
  // null when the question row is gone or its type is unrecognized — such
  // rows carry no type badge and match no type filter.
  question_type: QuestionType | null;
  detail: AnswerDetail;
  is_correct: boolean;
  answered_at: string;
  // Instructor's review score (0-100) for a written open submission, when
  // one exists. Open answers are never auto-scored, so this is the only
  // verdict such a row can carry.
  instructor_grade: number | null;
  instructor_feedback: string | null;
  // The open_question_grades row behind a written practice submission —
  // the handle the Grade action writes through. Null for quiz_answers rows,
  // whose grades (if any) belong to other surfaces.
  grade_row_id: string | null;
  user_name: string | null;
  user_email: string | null;
  question_text: string;
}

/** Sentinel value for the quiz filter's "answers outside any quiz" option. */
const NO_QUIZ = "none";

function submissionObject(sub: Json | null | undefined): Record<string, unknown> | null {
  return sub && typeof sub === "object" && !Array.isArray(sub)
    ? (sub as Record<string, unknown>)
    : null;
}

/**
 * Shape one `quiz_answers` row into its per-type display data. Defends
 * against malformed jsonb the same way the payload readers do: every branch
 * degrades to empty arrays / strings, never throws.
 */
function buildAnswerDetail(
  type: QuestionType,
  payload: Json | null,
  answerKey: Json | null,
  row: { submission?: Json | null; selected_answer?: number | null },
): AnswerDetail {
  const sub = submissionObject(row.submission);
  switch (type) {
    case "open":
      return {
        kind: "open",
        text: typeof sub?.open_text === "string" ? sub.open_text : "",
      };
    case "ordering": {
      const raw = sub?.ordering;
      return {
        kind: "ordering",
        submitted: Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === "string")
          : [],
        correct_order: orderingItemsFromPayload(payload),
      };
    }
    case "fill_gaps": {
      const raw = sub?.fill_gaps;
      return {
        kind: "fill_gaps",
        inputs: Array.isArray(raw)
          ? raw.map((v) => (typeof v === "string" ? v : ""))
          : [],
        gaps: fillGapsAcceptableAnswersFromAnswerKey(answerKey),
      };
    }
    case "classification": {
      const placements: Record<string, string> = {};
      const rawCls = sub?.classification;
      if (rawCls && typeof rawCls === "object" && !Array.isArray(rawCls)) {
        for (const [k, v] of Object.entries(rawCls as Record<string, unknown>)) {
          if (typeof v === "string" && v.length > 0) placements[k] = v;
        }
      }
      const categories = classificationCategoriesFromPayload(payload);
      const labelOf = (catId: string | undefined) =>
        catId ? categories.find((c) => c.id === catId)?.label ?? null : null;
      const assignments = classificationAssignmentsFromAnswerKey(answerKey);
      return {
        kind: "classification",
        rows: classificationItemsFromPayload(payload).map((it) => ({
          item: it.text,
          chosen: labelOf(placements[it.id]),
          correct: labelOf(assignments[it.id]),
        })),
      };
    }
    case "mcq":
    default: {
      // Multi-correct (#592): read `submission.selected_indices` when present;
      // fall back to the legacy `selected_answer` so rows authored on a
      // pre-#592 build still render with the per-option marks.
      const rawSel = sub?.selected_indices;
      const selected = Array.isArray(rawSel)
        ? rawSel.filter((v): v is number => typeof v === "number")
        : typeof row.selected_answer === "number"
          ? [row.selected_answer]
          : [];
      return {
        kind: "mcq",
        options: mcqOptionsFromPayload(payload),
        selected_indices: selected,
        correct_indices: mcqCorrectIndicesFromAnswerKey(answerKey),
      };
    }
  }
}

interface Quiz {
  id: string;
  title: string;
}

interface QuizHistoryProps {
  courseId: string;
  offeringId?: string;
}

interface UserQuizStats {
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  totalAnswers: number;
  // Answers that carry a real verdict — open answers are recorded for review,
  // never auto-scored, so they are excluded from the correct/wrong split.
  scorableAnswers: number;
  correctAnswers: number;
  score: number;
  lastAttempt: string;
}

type SortOption = "date-desc" | "date-asc" | "question" | "correct-first" | "wrong-first";

const QuizHistory = ({ courseId, offeringId }: QuizHistoryProps) => {
  const { compareText } = useFormatters();
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterUser, setFilterUser] = useState<string>("all");
  const [filterQuiz, setFilterQuiz] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterDateRange, setFilterDateRange] = useState<string>("all");
  const [customDateRange, setCustomDateRange] = useState<DateRange | undefined>(undefined);
  const [sortBy, setSortBy] = useState<SortOption>("date-desc");
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [quizQuestionCounts, setQuizQuestionCounts] = useState<Map<string, number>>(new Map());
  // Grading a written practice submission (rows with grade_row_id). The
  // instructor is the only grader — open answers are never auto-scored.
  const [gradeTarget, setGradeTarget] = useState<QuizAnswer | null>(null);
  const [gradeValue, setGradeValue] = useState(50);
  const [gradeFeedback, setGradeFeedback] = useState("");
  const [savingGrade, setSavingGrade] = useState(false);

  useEffect(() => {
    fetchQuizHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch on courseId/offeringId change
  }, [courseId, offeringId]);

  const fetchQuizHistory = async () => {
    try {
      // Fetch quizzes for filtering
      const { data: quizzesData } = await supabase
        .from("quizzes")
        .select("id, title")
        .eq("course_id", courseId)
        .order("title", { ascending: true });

      if (quizzesData) {
        setQuizzes(quizzesData);
        
        // Fetch question counts for each quiz
        const { data: quizQuestionsData } = await supabase
          .from("quiz_questions")
          .select("quiz_id")
          .in("quiz_id", quizzesData.map(q => q.id));

        if (quizQuestionsData) {
          const counts = new Map<string, number>();
          quizQuestionsData.forEach(qq => {
            counts.set(qq.quiz_id, (counts.get(qq.quiz_id) || 0) + 1);
          });
          setQuizQuestionCounts(counts);
        }
      }

      // Get valid user IDs based on class filter or course tags
      let validUserIds: string[] = [];

      if (offeringId) {
        // Get students enrolled in the class for this offering
        const { data: offeringData } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("id", offeringId)
          .single();

        if (offeringData?.class_id) {
          const { data: enrollmentData } = await supabase
            .from("class_enrollments")
            .select("user_id")
            .eq("class_id", offeringData.class_id)
            .eq("role", "student");

          validUserIds = enrollmentData?.map(e => e.user_id) || [];
        }
      } else {
        // No specific class filter — get all students enrolled in classes that offer this course
        const { data: offeringsData } = await supabase
          .from("offerings")
          .select("class_id")
          .eq("course_id", courseId);

        const classIds = [...new Set((offeringsData || []).map(o => o.class_id))];

        if (classIds.length > 0) {
          const { data: enrollmentData } = await supabase
            .from("class_enrollments")
            .select("user_id")
            .in("class_id", classIds)
            .eq("role", "student");

          validUserIds = [...new Set((enrollmentData || []).map(e => e.user_id))];
        }
      }

      // Fetch profiles for valid users
      if (validUserIds.length > 0) {
        const { data: profilesWithAccess } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", validUserIds);

        if (profilesWithAccess) {
          const usersWithAccess = profilesWithAccess.map(p => ({
            id: p.user_id,
            name: p.full_name || "Unknown",
            email: p.email || "",
          }));
          setUsers(usersWithAccess);
        }
      }

      // Fetch quiz answers with question data - filter by offering if specified
      let answersQuery = supabase
        .from("quiz_answers")
        .select("id, user_id, question_id, quiz_id, selected_answer, submission, is_correct, answered_at")
        .eq("course_id", courseId)
        .order("answered_at", { ascending: false });

      if (offeringId) {
        answersQuery = answersQuery.eq("offering_id", offeringId);
      }

      const { data: answersData, error: answersError } = await answersQuery;

      if (answersError) throw answersError;

      // Written single-mode open submissions live in `open_question_grades`
      // (recorded by `submit-open-answer`), never in `quiz_answers`. Rows
      // with a `submitted_answer` are single-mode by construction —
      // interactive sessions leave it NULL and are reviewed in Student
      // Chats. The other single-mode types also write this table, so the
      // rows are narrowed to `type === "open"` questions after the type
      // lookup below.
      let gradesQuery = supabase
        .from("open_question_grades")
        .select("id, user_id, open_question_id, grade, feedback, submitted_answer, created_at")
        .eq("course_id", courseId)
        .not("submitted_answer", "is", null)
        .order("created_at", { ascending: false });

      if (offeringId) {
        gradesQuery = gradesQuery.eq("offering_id", offeringId);
      }

      const { data: gradeRows, error: gradesError } = await gradesQuery;

      if (gradesError) throw gradesError;

      if ((!answersData || answersData.length === 0) && (!gradeRows || gradeRows.length === 0)) {
        setAnswers([]);
        setLoading(false);
        return;
      }

      // Get unique user IDs from both sources
      const userIds = [...new Set([
        ...(answersData || []).map(a => a.user_id),
        ...(gradeRows || []).map(g => g.user_id),
      ])];

      // Fetch user profiles for answer enrichment
      const { data: profilesData } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", userIds);

      const profilesMap = new Map(
        profilesData?.map(p => [p.user_id, { name: p.full_name, email: p.email }]) || []
      );

      // Get unique question IDs from both sources
      const questionIds = [...new Set([
        ...(answersData || []).map(a => a.question_id),
        ...(gradeRows || []).map(g => g.open_question_id),
      ])];

      // Fetch questions — every type's display data lives in the unified
      // `type` / `payload` / `answer_key` columns (#582). A failed lookup
      // must throw rather than let every row silently degrade to an
      // unresolvable question.
      const { data: questionsData, error: questionsError } = await supabase
        .from("questions")
        .select("id, question, type, payload, answer_key")
        .in("id", questionIds);

      if (questionsError) throw questionsError;

      const questionsMap = new Map(
        (questionsData as any[])?.map(q => [q.id, q]) || []
      );

      const enrichedAnswers: QuizAnswer[] = (answersData || []).map((a: any) => {
        const profile = profilesMap.get(a.user_id);
        const question = questionsMap.get(a.question_id);
        // A missing row (deleted question) or an unrecognized type yields
        // null — never guess a type, or the row would be mislabeled and
        // its submission decoded with the wrong shape.
        const type: QuestionType | null =
          question && ALL_QUESTION_TYPES.includes(question.type)
            ? (question.type as QuestionType)
            : null;
        return {
          id: a.id,
          user_id: a.user_id,
          question_id: a.question_id,
          quiz_id: a.quiz_id,
          question_type: type,
          detail: type
            ? buildAnswerDetail(type, question.payload ?? null, question.answer_key ?? null, a)
            : { kind: "unknown" },
          is_correct: a.is_correct,
          answered_at: a.answered_at,
          instructor_grade: null,
          instructor_feedback: null,
          grade_row_id: null,
          user_name: profile?.name || null,
          user_email: profile?.email || null,
          question_text: question?.question || "Question not found",
        };
      });

      // Practice written open answers. Only `open` questions: the other
      // single-mode types also write `submitted_answer` (as JSON), and their
      // practice history is out of scope here.
      const practiceOpenAnswers: QuizAnswer[] = (gradeRows || [])
        .filter((g: any) => questionsMap.get(g.open_question_id)?.type === "open")
        .map((g: any) => {
          const profile = profilesMap.get(g.user_id);
          const question = questionsMap.get(g.open_question_id);
          return {
            id: `oqg-${g.id}`,
            user_id: g.user_id,
            question_id: g.open_question_id,
            quiz_id: null,
            question_type: "open" as QuestionType,
            detail: { kind: "open" as const, text: g.submitted_answer ?? "" },
            // Never auto-scored — same contract as open rows in quiz_answers.
            // The instructor's review, when it exists, rides along instead.
            is_correct: false,
            answered_at: g.created_at,
            instructor_grade: typeof g.grade === "number" ? g.grade : null,
            instructor_feedback: typeof g.feedback === "string" ? g.feedback : null,
            grade_row_id: g.id,
            user_name: profile?.name || null,
            user_email: profile?.email || null,
            question_text: question?.question || "Question not found",
          };
        });

      setAnswers(
        [...enrichedAnswers, ...practiceOpenAnswers].sort(
          (a, b) => new Date(b.answered_at).getTime() - new Date(a.answered_at).getTime(),
        ),
      );

    } catch (error: any) {
      console.error("Error fetching quiz history:", error);
    } finally {
      setLoading(false);
    }
  };

  const openGradeDialog = (answer: QuizAnswer) => {
    setGradeTarget(answer);
    setGradeValue(answer.instructor_grade ?? 50);
    setGradeFeedback(answer.instructor_feedback ?? "");
  };

  const handleSaveGrade = async () => {
    if (!gradeTarget?.grade_row_id) return;
    setSavingGrade(true);
    try {
      const { data, error } = await supabase
        .from("open_question_grades")
        .update({
          grade: gradeValue,
          feedback: gradeFeedback || "Manually assessed by instructor",
          graded_at: new Date().toISOString(),
        })
        .eq("id", gradeTarget.grade_row_id)
        .select("id");

      if (error) throw error;
      // RLS declines a write by matching no rows, not by raising — zero rows
      // means the policy refused, not that the grade was saved.
      if (!data || data.length === 0) {
        throw new Error(
          "You do not have permission to grade this submission. It may belong to a section you are not assigned to.",
        );
      }

      const savedFeedback = gradeFeedback || "Manually assessed by instructor";
      setAnswers(prev =>
        prev.map(a =>
          a.id === gradeTarget.id
            ? { ...a, instructor_grade: gradeValue, instructor_feedback: savedFeedback }
            : a,
        ),
      );
      toast.success("Assessment saved");
      setGradeTarget(null);
    } catch (error: any) {
      console.error("Error saving assessment:", error);
      toast.error(error.message || "Failed to save assessment");
    } finally {
      setSavingGrade(false);
    }
  };

  // Get date range for filtering
  const getDateRange = (): { start: Date; end: Date } | null => {
    const now = new Date();
    switch (filterDateRange) {
      case "today":
        return { start: startOfDay(now), end: endOfDay(now) };
      case "7days":
        return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
      case "30days":
        return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
      case "3months":
        return { start: startOfDay(subMonths(now, 3)), end: endOfDay(now) };
      case "custom":
        if (customDateRange?.from) {
          return { 
            start: startOfDay(customDateRange.from), 
            end: endOfDay(customDateRange.to || customDateRange.from) 
          };
        }
        return null;
      default:
        return null;
    }
  };

  // Apply user, quiz, question-type, and date filters
  const filteredAnswers = answers.filter(a => {
    const userMatch = filterUser === "all" || a.user_id === filterUser;
    const quizMatch =
      filterQuiz === "all" ||
      (filterQuiz === NO_QUIZ ? a.quiz_id === null : a.quiz_id === filterQuiz);
    const typeMatch = filterType === "all" || a.question_type === filterType;

    const dateRange = getDateRange();
    const dateMatch = !dateRange || isWithinInterval(new Date(a.answered_at), {
      start: dateRange.start,
      end: dateRange.end,
    });
    
    return userMatch && quizMatch && typeMatch && dateMatch;
  });

  const sortedAnswers = [...filteredAnswers].sort((a, b) => {
    switch (sortBy) {
      case "date-asc":
        return new Date(a.answered_at).getTime() - new Date(b.answered_at).getTime();
      case "date-desc":
        return new Date(b.answered_at).getTime() - new Date(a.answered_at).getTime();
      case "question":
        return compareText(a.question_text, b.question_text);
      case "correct-first":
        return (b.is_correct ? 1 : 0) - (a.is_correct ? 1 : 0);
      case "wrong-first":
        return (a.is_correct ? 1 : 0) - (b.is_correct ? 1 : 0);
      default:
        return 0;
    }
  });

  // Open answers are recorded for review, never auto-scored (the server
  // writes is_correct = false for every one), so they get their own bucket
  // instead of inflating "Wrong".
  const stats = {
    total: filteredAnswers.length,
    correct: filteredAnswers.filter(a => a.is_correct).length,
    wrong: filteredAnswers.filter(a => !a.is_correct && a.question_type !== "open").length,
    // Open answers the instructor has not reviewed yet — a reviewed one
    // carries its instructor_grade badge instead.
    notScored: filteredAnswers.filter(
      a => a.question_type === "open" && a.instructor_grade === null,
    ).length,
  };

  const selectedQuizTitle = filterQuiz !== "all" && filterQuiz !== NO_QUIZ
    ? quizzes.find(q => q.id === filterQuiz)?.title
    : null;

  // Quiz-specific stats when a quiz is selected
  const quizStats = useMemo(() => {
    if (filterQuiz === "all" || filterQuiz === NO_QUIZ) return null;

    const quizAnswers = answers.filter(a => a.quiz_id === filterQuiz);
    const uniqueUsers = [...new Set(quizAnswers.map(a => a.user_id))];
    const totalQuestions = quizQuestionCounts.get(filterQuiz) || 0;
    
    // Calculate per-user stats
    const userStats: UserQuizStats[] = uniqueUsers.map(userId => {
      const userAnswers = quizAnswers.filter(a => a.user_id === userId);
      // Score over scorable answers only — open answers are never auto-scored
      // and would otherwise read as wrong.
      const scorable = userAnswers.filter(a => a.question_type !== "open");
      const correctCount = scorable.filter(a => a.is_correct).length;
      const lastAttempt = userAnswers.reduce((latest, a) => {
        return new Date(a.answered_at) > new Date(latest) ? a.answered_at : latest;
      }, userAnswers[0]?.answered_at || "");

      return {
        user_id: userId,
        user_name: userAnswers[0]?.user_name || null,
        user_email: userAnswers[0]?.user_email || null,
        totalAnswers: userAnswers.length,
        scorableAnswers: scorable.length,
        correctAnswers: correctCount,
        score: scorable.length > 0 ? Math.round((correctCount / scorable.length) * 100) : 0,
        lastAttempt,
      };
    }).sort((a, b) => b.score - a.score);

    const averageScore = userStats.length > 0 
      ? Math.round(userStats.reduce((sum, u) => sum + u.score, 0) / userStats.length) 
      : 0;
    
    const completedUsers = userStats.filter(u => u.totalAnswers >= totalQuestions).length;
    const completionRate = totalQuestions > 0 && uniqueUsers.length > 0
      ? Math.round((completedUsers / uniqueUsers.length) * 100)
      : 0;

    // Calculate score distribution for chart
    const scoreDistribution = [
      { range: "0-20%", count: 0, color: "hsl(0, 70%, 50%)" },
      { range: "21-40%", count: 0, color: "hsl(25, 70%, 50%)" },
      { range: "41-60%", count: 0, color: "hsl(45, 70%, 50%)" },
      { range: "61-80%", count: 0, color: "hsl(90, 50%, 45%)" },
      { range: "81-100%", count: 0, color: "hsl(142, 70%, 40%)" },
    ];

    userStats.forEach(user => {
      if (user.score <= 20) scoreDistribution[0].count++;
      else if (user.score <= 40) scoreDistribution[1].count++;
      else if (user.score <= 60) scoreDistribution[2].count++;
      else if (user.score <= 80) scoreDistribution[3].count++;
      else scoreDistribution[4].count++;
    });

    return {
      participants: uniqueUsers.length,
      totalQuestions,
      averageScore,
      completionRate,
      completedUsers,
      userStats,
      scoreDistribution,
    };
  }, [filterQuiz, answers, quizQuestionCounts]);

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
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                Student Interactions
              </CardTitle>
              <CardDescription>
                {selectedQuizTitle
                  ? `Showing answers for "${selectedQuizTitle}"`
                  : filterQuiz === NO_QUIZ
                    ? "Showing answers to questions not part of any quiz"
                    : "View all student answers across every question type"}
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {quizzes.length > 0 && (
              <Select value={filterQuiz} onValueChange={setFilterQuiz}>
                <SelectTrigger className="w-[200px]">
                  <ClipboardList className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by quiz" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Quizzes</SelectItem>
                  <SelectItem value={NO_QUIZ}>Not in a quiz</SelectItem>
                  {quizzes.map(quiz => (
                    <SelectItem key={quiz.id} value={quiz.id}>
                      {quiz.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-[180px]">
                <Shapes className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Question type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Question Types</SelectItem>
                {ALL_QUESTION_TYPES.map(t => (
                  <SelectItem key={t} value={t}>
                    {QUESTION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {users.length > 0 && (
              <Select value={filterUser} onValueChange={setFilterUser}>
                <SelectTrigger className="w-[180px]">
                  <User className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Filter by user" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Users</SelectItem>
                  {users.map(user => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name || user.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={filterDateRange} onValueChange={setFilterDateRange}>
              <SelectTrigger className="w-[160px]">
                <Calendar className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Date range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Time</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="7days">Last 7 Days</SelectItem>
                <SelectItem value="30days">Last 30 Days</SelectItem>
                <SelectItem value="3months">Last 3 Months</SelectItem>
                <SelectItem value="custom">Custom Range</SelectItem>
              </SelectContent>
            </Select>
            {filterDateRange === "custom" && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-10">
                    {customDateRange?.from ? (
                      customDateRange.to ? (
                        <>
                          {format(customDateRange.from, "MMM d")} - {format(customDateRange.to, "MMM d, yyyy")}
                        </>
                      ) : (
                        format(customDateRange.from, "MMM d, yyyy")
                      )
                    ) : (
                      "Pick dates"
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <CalendarComponent
                    mode="range"
                    selected={customDateRange}
                    onSelect={setCustomDateRange}
                    numberOfMonths={2}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            )}
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
              <SelectTrigger className="w-[180px]">
                <ArrowUpDown className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest First</SelectItem>
                <SelectItem value="date-asc">Oldest First</SelectItem>
                <SelectItem value="question">By Question</SelectItem>
                <SelectItem value="correct-first">Correct First</SelectItem>
                <SelectItem value="wrong-first">Wrong First</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Quiz-specific stats when a quiz is selected */}
        {quizStats && (
          <div className="mb-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="p-4 rounded-lg bg-primary/10 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-primary" />
                </div>
                <p className="text-2xl font-bold text-primary">{quizStats.participants}</p>
                <p className="text-xs text-muted-foreground">Participants</p>
              </div>
              <div className="p-4 rounded-lg bg-blue-500/10 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <TrendingUp className="w-4 h-4 text-blue-600" />
                </div>
                <p className="text-2xl font-bold text-blue-600">{quizStats.averageScore}%</p>
                <p className="text-xs text-muted-foreground">Average Score</p>
              </div>
              <div className="p-4 rounded-lg bg-amber-500/10 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <Target className="w-4 h-4 text-amber-600" />
                </div>
                <p className="text-2xl font-bold text-amber-600">{quizStats.completionRate}%</p>
                <p className="text-xs text-muted-foreground">Completion Rate</p>
              </div>
              <div className="p-4 rounded-lg bg-purple-500/10 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <Award className="w-4 h-4 text-purple-600" />
                </div>
                <p className="text-2xl font-bold text-purple-600">{quizStats.completedUsers}</p>
                <p className="text-xs text-muted-foreground">Completed</p>
              </div>
            </div>

            <Tabs defaultValue="distribution" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="distribution" className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" />
                  Score Distribution
                </TabsTrigger>
                <TabsTrigger value="participants" className="flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Participants ({quizStats.participants})
                </TabsTrigger>
                <TabsTrigger value="answers" className="flex items-center gap-2">
                  <History className="w-4 h-4" />
                  All Answers ({stats.total})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="distribution">
                {quizStats.userStats.length === 0 ? (
                  <div className="py-8 text-center">
                    <BarChart3 className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-sm text-muted-foreground">No data to display</p>
                  </div>
                ) : (
                  <div className="h-[300px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={quizStats.scoreDistribution} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis 
                          dataKey="range" 
                          tick={{ fontSize: 12 }}
                          className="text-muted-foreground"
                        />
                        <YAxis 
                          allowDecimals={false}
                          tick={{ fontSize: 12 }}
                          className="text-muted-foreground"
                          label={{ value: 'Students', angle: -90, position: 'insideLeft', fontSize: 12 }}
                        />
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--popover))', 
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px',
                            fontSize: '12px'
                          }}
                          formatter={(value: number) => [`${value} student${value !== 1 ? 's' : ''}`, 'Count']}
                        />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {quizStats.scoreDistribution.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="participants">
                {quizStats.userStats.length === 0 ? (
                  <div className="py-8 text-center">
                    <Users className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-sm text-muted-foreground">No participants yet</p>
                  </div>
                ) : (
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Student</TableHead>
                          <TableHead className="text-center">Answered</TableHead>
                          <TableHead className="text-center">Correct</TableHead>
                          <TableHead className="text-center">Score</TableHead>
                          <TableHead className="text-right">Last Attempt</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {quizStats.userStats.map((userStat, index) => (
                          <TableRow key={userStat.user_id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {index < 3 && (
                                  <Badge 
                                    variant="outline" 
                                    className={
                                      index === 0 ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/30" :
                                      index === 1 ? "bg-slate-400/10 text-slate-500 border-slate-400/30" :
                                      "bg-amber-600/10 text-amber-700 border-amber-600/30"
                                    }
                                  >
                                    #{index + 1}
                                  </Badge>
                                )}
                                <div>
                                  <p className="font-medium">
                                    {userStat.user_name || "Unknown"}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {userStat.user_email}
                                  </p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="text-center">
                              {userStat.totalAnswers}/{quizStats.totalQuestions}
                            </TableCell>
                            <TableCell className="text-center">
                              <span className="text-green-600">{userStat.correctAnswers}</span>
                              <span className="text-muted-foreground"> / </span>
                              <span className="text-red-600">{userStat.scorableAnswers - userStat.correctAnswers}</span>
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge 
                                variant="outline"
                                className={
                                  userStat.score >= 70 ? "bg-green-500/10 text-green-600 border-green-500/30" :
                                  userStat.score >= 40 ? "bg-amber-500/10 text-amber-600 border-amber-500/30" :
                                  "bg-red-500/10 text-red-600 border-red-500/30"
                                }
                              >
                                {userStat.score}%
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {format(new Date(userStat.lastAttempt), "MMM d, HH:mm")}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="answers">
                <AnswersList answers={sortedAnswers} onGrade={openGradeDialog} />
              </TabsContent>
            </Tabs>
          </div>
        )}

        {/* Default stats when no quiz is selected */}
        {!quizStats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-2xl font-bold">{stats.total}</p>
                <p className="text-xs text-muted-foreground">Total Attempts</p>
              </div>
              <div className="p-3 rounded-lg bg-green-500/10 text-center">
                <p className="text-2xl font-bold text-green-600">{stats.correct}</p>
                <p className="text-xs text-muted-foreground">Correct</p>
              </div>
              <div className="p-3 rounded-lg bg-red-500/10 text-center">
                <p className="text-2xl font-bold text-red-600">{stats.wrong}</p>
                <p className="text-xs text-muted-foreground">Wrong</p>
              </div>
              <div className="p-3 rounded-lg bg-amber-500/10 text-center">
                <p className="text-2xl font-bold text-amber-600">{stats.notScored}</p>
                <p className="text-xs text-muted-foreground">Not Scored</p>
              </div>
            </div>
            <AnswersList answers={sortedAnswers} onGrade={openGradeDialog} />
          </>
        )}
      </CardContent>

      {/* Grade a written practice submission. Mirrors the assessment dialog
          in Student Chats: the instructor is the grader, the AI never is. */}
      <Dialog open={!!gradeTarget} onOpenChange={(open) => !open && setGradeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit2 className="w-5 h-5" />
              Grade Submission
            </DialogTitle>
            <DialogDescription>
              Set the score and the feedback the student will see for this
              written answer.
            </DialogDescription>
          </DialogHeader>
          {gradeTarget && (
            <div className="space-y-6">
              {gradeTarget.detail.kind === "open" && gradeTarget.detail.text && (
                <div className="bg-muted/30 rounded-lg p-3 border max-h-40 overflow-y-auto">
                  <p className="text-xs font-medium text-muted-foreground mb-1">
                    Student's written answer
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{gradeTarget.detail.text}</p>
                </div>
              )}
              <div>
                <Label className="text-sm font-medium">Score: {gradeValue}/100</Label>
                <Slider
                  value={[gradeValue]}
                  onValueChange={(v) => setGradeValue(v[0])}
                  min={0}
                  max={100}
                  step={1}
                  className="mt-3"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>0</span>
                  <span>50</span>
                  <span>100</span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="answer-grade-feedback">Feedback (optional)</Label>
                <Textarea
                  id="answer-grade-feedback"
                  placeholder="Add feedback for the student..."
                  value={gradeFeedback}
                  onChange={(e) => setGradeFeedback(e.target.value)}
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={() => setGradeTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={handleSaveGrade} disabled={savingGrade}>
                  {savingGrade ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Assessment"
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
};

const LatexSpan = ({ text }: { text: string }) => (
  <span dangerouslySetInnerHTML={{ __html: processLatexContent(text) }} />
);

/** Renders one answer's per-type submitted/correct breakdown. */
const AnswerCell = ({ answer }: { answer: QuizAnswer }) => {
  const d = answer.detail;
  const verdictColor = answer.is_correct ? "text-green-600" : "text-red-600";

  switch (d.kind) {
    case "unknown":
      return <div className="text-xs text-muted-foreground">—</div>;

    case "mcq":
      return (
        <div className="text-xs space-y-1">
          <div className={verdictColor}>
            <span className="font-semibold">Selected:</span>{" "}
            {d.selected_indices.length === 0
              ? "—"
              : d.selected_indices.map((idx, i) => (
                  <span key={idx}>
                    {i > 0 && ", "}
                    <LatexSpan text={d.options[idx] ?? `Option ${String.fromCharCode(65 + idx)}`} />
                  </span>
                ))}
          </div>
          {!answer.is_correct && (
            <div className="text-green-600">
              <span className="font-semibold">Correct:</span>{" "}
              {d.correct_indices.length === 0
                ? "N/A"
                : d.correct_indices.map((idx, i) => (
                    <span key={idx}>
                      {i > 0 && ", "}
                      <LatexSpan text={d.options[idx] ?? `Option ${String.fromCharCode(65 + idx)}`} />
                    </span>
                  ))}
            </div>
          )}
        </div>
      );

    case "open":
      return (
        <div className="text-xs">
          <span className="font-semibold">Answer:</span>{" "}
          {d.text.trim().length === 0 ? (
            "—"
          ) : (
            <span className="line-clamp-3">
              <LatexSpan text={d.text} />
            </span>
          )}
        </div>
      );

    case "ordering": {
      const sequence = (items: string[]) =>
        items.map((item, i) => (
          <span key={i}>
            {i > 0 && " → "}
            <LatexSpan text={item} />
          </span>
        ));
      return (
        <div className="text-xs space-y-1">
          <div className={verdictColor}>
            <span className="font-semibold">Order:</span>{" "}
            {d.submitted.length === 0 ? "—" : sequence(d.submitted)}
          </div>
          {!answer.is_correct && d.correct_order.length > 0 && (
            <div className="text-green-600">
              <span className="font-semibold">Correct:</span> {sequence(d.correct_order)}
            </div>
          )}
        </div>
      );
    }

    case "fill_gaps":
      return (
        <div className="text-xs space-y-1">
          <div className={verdictColor}>
            <span className="font-semibold">Filled:</span>{" "}
            {d.inputs.length === 0
              ? "—"
              : d.inputs.map((input, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    {input.trim().length === 0 ? "—" : <LatexSpan text={input} />}
                  </span>
                ))}
          </div>
          {!answer.is_correct && d.gaps.length > 0 && (
            <div className="text-green-600">
              <span className="font-semibold">Accepted:</span>{" "}
              {d.gaps.map((gap, i) => (
                <span key={gap.ordinal}>
                  {i > 0 && ", "}
                  <LatexSpan text={gap.acceptable.join(" / ")} />
                </span>
              ))}
            </div>
          )}
        </div>
      );

    case "classification":
      if (d.rows.length === 0) {
        return <div className="text-xs">—</div>;
      }
      return (
        <div className="text-xs space-y-1">
          {d.rows.map((row, i) => {
            const placedCorrectly = row.chosen !== null && row.chosen === row.correct;
            return (
              <div key={i} className={placedCorrectly ? "text-green-600" : "text-red-600"}>
                <LatexSpan text={row.item} /> →{" "}
                {row.chosen ? <LatexSpan text={row.chosen} /> : "—"}
                {!placedCorrectly && row.correct && (
                  <span className="text-green-600">
                    {" "}(correct: <LatexSpan text={row.correct} />)
                  </span>
                )}
              </div>
            );
          })}
        </div>
      );
  }
};

// Extracted component for answers list with pagination and sortable table
type AnswerSortField = "user" | "question" | "date" | "result";
type AnswerSortDirection = "asc" | "desc";

const AnswersList = ({
  answers,
  onGrade,
}: {
  answers: QuizAnswer[];
  /** Opens the grade dialog for a written practice submission (rows with grade_row_id). */
  onGrade?: (answer: QuizAnswer) => void;
}) => {
  const { compareText } = useFormatters();
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortField, setSortField] = useState<AnswerSortField>("date");
  const [sortDirection, setSortDirection] = useState<AnswerSortDirection>("desc");

  if (answers.length === 0) {
    return (
      <div className="py-8 text-center">
        <History className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">No answers yet</p>
      </div>
    );
  }

  // Sort answers
  const sortedAnswers = [...answers].sort((a, b) => {
    let comparison = 0;
    switch (sortField) {
      case "user":
        comparison = compareText((a.user_name || a.user_email || ""), b.user_name || b.user_email || "");
        break;
      case "question":
        comparison = compareText(a.question_text, b.question_text);
        break;
      case "date":
        comparison = new Date(a.answered_at).getTime() - new Date(b.answered_at).getTime();
        break;
      case "result":
        comparison = (a.is_correct ? 1 : 0) - (b.is_correct ? 1 : 0);
        break;
    }
    return sortDirection === "asc" ? comparison : -comparison;
  });

  // Pagination
  const totalPages = Math.ceil(sortedAnswers.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedAnswers = sortedAnswers.slice(startIndex, startIndex + pageSize);

  const handleSort = (field: AnswerSortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setCurrentPage(1);
  };

  const SortableHeader = ({ field, children }: { field: AnswerSortField; children: React.ReactNode }) => (
    <TableHead 
      className="cursor-pointer hover:bg-muted/50 select-none"
      onClick={() => handleSort(field)}
    >
      <div className="flex items-center gap-1">
        {children}
        <ChevronsUpDown className={`w-4 h-4 ${sortField === field ? "text-primary" : "text-muted-foreground"}`} />
      </div>
    </TableHead>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader field="user">Student</SortableHeader>
              <SortableHeader field="question">Question</SortableHeader>
              <TableHead>Answer</TableHead>
              <SortableHeader field="result">Result</SortableHeader>
              <SortableHeader field="date">Date</SortableHeader>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedAnswers.map((answer) => (
              <TableRow key={answer.id}>
                <TableCell>
                  <div>
                    <p className="font-medium text-sm">
                      {answer.user_name || "Unknown"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {answer.user_email}
                    </p>
                  </div>
                </TableCell>
                <TableCell className="max-w-[300px]">
                  <p
                    className="text-sm line-clamp-2"
                    dangerouslySetInnerHTML={{ __html: processLatexContent(answer.question_text) }}
                  />
                  {answer.question_type && (
                    <Badge variant="outline" className="mt-1 text-xs font-normal">
                      {QUESTION_TYPE_LABELS[answer.question_type]}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <AnswerCell answer={answer} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    {answer.question_type === "open" ? (
                      answer.instructor_grade !== null ? (
                        <Badge variant="outline">
                          <GraduationCap className="w-3 h-3 mr-1" />
                          {answer.instructor_grade}/100
                        </Badge>
                      ) : (
                        <Badge variant="secondary">Not scored</Badge>
                      )
                    ) : answer.is_correct ? (
                      <Badge className="bg-green-500">
                        <CheckCircle className="w-3 h-3 mr-1" />
                        Correct
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        <XCircle className="w-3 h-3 mr-1" />
                        Wrong
                      </Badge>
                    )}
                    {answer.grade_row_id && onGrade && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => onGrade(answer)}
                      >
                        <Edit2 className="w-3 h-3 mr-1" />
                        {answer.instructor_grade !== null ? "Edit" : "Grade"}
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {format(new Date(answer.answered_at), "MMM d, HH:mm")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Showing {startIndex + 1}-{Math.min(startIndex + pageSize, sortedAnswers.length)} of {sortedAnswers.length}</span>
          <Select value={pageSize.toString()} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1); }}>
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
          <span>per page</span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(1)}
            disabled={currentPage === 1}
          >
            First
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="px-3 text-sm">
            Page {currentPage} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
            disabled={currentPage === totalPages}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage(totalPages)}
            disabled={currentPage === totalPages}
          >
            Last
          </Button>
        </div>
      </div>
    </div>
  );
};

export default QuizHistory;
