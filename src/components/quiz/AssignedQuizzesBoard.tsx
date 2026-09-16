import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Calendar,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  Loader2,
  Lock,
  LockOpen,
  Save,
  School,
  Send,
  Users,
  X,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { buildClassDisplayName } from "@/lib/greek-school";
import { toast } from "sonner";
import { StudentAnswerDrillDown } from "@/components/quiz/StudentAnswerDrillDown";
import { useFormatters } from "@/i18n/formatters";

interface AssignedQuizzesBoardProps {
  courseId: string;
  // Bumped by a parent (e.g. CoursePage) after sibling components mutate
  // offering_quizzes so this board can refetch without remounting.
  refreshKey?: number;
  /** Only show this quiz's assignments (the per-quiz manage dialog). */
  quizId?: string;
  /**
   * Render without the outer Card chrome — for embedding inside a dialog
   * that already carries the title. The class accordions and per-assignment
   * cards are unchanged.
   */
  embedded?: boolean;
  /**
   * Fired after each successful offering_quizzes mutation (publish, close,
   * reopen, due date / time limit / answers-released save, follow-up draft
   * created), so an embedding parent can refresh its own view of the same
   * rows. Fired per completed write — never on dialog close — so it cannot
   * race a mutation that is still in flight.
   */
  onAssignmentsMutated?: () => void;
}

interface ClassInfo {
  id: string;
  displayName: string;
  academicPeriod: string | null;
}

interface OfferingInfo {
  offeringId: string;
  classId: string;
}

interface AssignedQuiz {
  assignmentId: string;
  offeringId: string;
  classId: string;
  quizId: string;
  quizTitle: string;
  // null = whole-class assignment; otherwise the cluster (offering_group) id.
  groupId: string | null;
  // Display name of the cluster, resolved from offering_groups. null for whole class.
  groupName: string | null;
  questionCount: number;
  dueDate: string | null;
  publishedAt: string | null;
  timeLimitOverride: number | null;
  // Baseline time limit set on the quiz itself. Effective time limit per
  // assignment is timeLimitOverride ?? timeLimitMinutes (null means no limit).
  timeLimitMinutes: number | null;
  answersReleased: boolean;
  closedAt: string | null;
  // State of the follow-up generation job that fills a draft quiz, when there is
  // one. Items are processed per (chapter, type) and append their questions as
  // they finish, so a draft's question count is not a completeness signal on its
  // own — see generationStateForQuizzes.
  generationState: GenerationState;
}

// null: no generation job for this quiz (a hand-built quiz, or an old draft
// whose job row has been cleaned up).
// "in_flight": still producing questions; the set will keep changing.
// "incomplete": the job stopped without finishing every item, so whatever
// questions exist are all there will be.
// "unknown": the jobs read failed. Never treated as "no job" — that would fail
// open and let a still-generating draft be published.
type GenerationState = "in_flight" | "incomplete" | "unknown" | null;

const FOLLOWUP_JOB_TYPE = "followup_practice_generation";

interface StudentRoster {
  userId: string;
  fullName: string;
  email: string;
}

interface SubmissionSummary {
  userId: string;
  fullName: string;
  email: string;
  status: "completed" | "in_progress" | "not_started";
  correctCount: number;
  totalAnswered: number;
  percentage: number | null;
  completedAt: string | null;
  sessionId: string | null;
  // True when the student's completed attempt exceeded the effective time limit.
  // Only meaningful for timed quizzes; always false when no limit is configured.
  overtime: boolean;
}

// Tolerance applied when deciding if a completed attempt ran over the time
// limit. Absorbs clock drift and the few seconds between the timer hitting
// zero and the server recording completed_at during auto-submit.
const OVERTIME_TOLERANCE_MS = 5_000;

interface QuizStats {
  total: number;
  submitted: number;
  averagePercentage: number | null;
  submissions: SubmissionSummary[];
  notSubmitted: SubmissionSummary[];
}

const scoreColor = (pct: number | null) => {
  if (pct === null) return "text-muted-foreground";
  if (pct >= 80) return "text-green-600";
  if (pct >= 60) return "text-amber-600";
  return "text-red-600";
};

// Newest follow-up generation job per draft quiz. Jobs are read by course_id
// (indexed, and what the RLS policy keys on) and matched to quizzes in memory
// rather than by a params->>targetQuizId filter, which has no index on this
// table. A read failure yields "unknown", never null: null means "checked, no
// job", and conflating the two would let a still-generating draft be published.
const generationStateForQuizzes = async (
  courseId: string,
  quizIds: string[],
): Promise<Map<string, GenerationState>> => {
  const byQuiz = new Map<string, GenerationState>();
  if (quizIds.length === 0) return byQuiz;
  const wanted = new Set(quizIds);
  const { data, error } = await supabase
    .from("jobs")
    .select("status, params, created_at")
    .eq("course_id", courseId)
    .eq("type", FOLLOWUP_JOB_TYPE)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Error fetching follow-up generation jobs:", error);
    for (const id of quizIds) byQuiz.set(id, "unknown");
    return byQuiz;
  }
  for (const job of (data || []) as any[]) {
    const quizId = job.params?.targetQuizId;
    if (typeof quizId !== "string" || !wanted.has(quizId)) continue;
    // Rows arrive newest-first, so the first one seen for a quiz wins.
    if (byQuiz.has(quizId)) continue;
    if (job.status === "pending" || job.status === "processing") {
      byQuiz.set(quizId, "in_flight");
    } else if (
      job.status === "failed" ||
      job.status === "partially_completed" ||
      job.status === "cancelled"
    ) {
      byQuiz.set(quizId, "incomplete");
    } else {
      byQuiz.set(quizId, null);
    }
  }
  return byQuiz;
};

export const AssignedQuizzesBoard = ({
  courseId,
  refreshKey = 0,
  quizId,
  embedded = false,
  onAssignmentsMutated,
}: AssignedQuizzesBoardProps) => {
  const { compareText } = useFormatters();
  const [loading, setLoading] = useState(true);
  const [assignedQuizzes, setAssignedQuizzes] = useState<AssignedQuiz[]>([]);
  const [classesById, setClassesById] = useState<Map<string, ClassInfo>>(new Map());
  const [rostersByClass, setRostersByClass] = useState<Map<string, StudentRoster[]>>(
    new Map(),
  );
  // Members of each cluster (offering_group), used to scope group-assigned
  // quizzes' roster and stats to the group's students.
  const [membersByGroup, setMembersByGroup] = useState<Map<string, Set<string>>>(
    new Map(),
  );
  const [statsByAssignment, setStatsByAssignment] = useState<Map<string, QuizStats>>(
    new Map(),
  );
  const [loadingStats, setLoadingStats] = useState<Set<string>>(new Set());
  const [markingComplete, setMarkingComplete] = useState<Set<string>>(new Set());
  const [closureBusy, setClosureBusy] = useState<Set<string>>(new Set());
  const [publishBusy, setPublishBusy] = useState<Set<string>>(new Set());

  const [drillStudent, setDrillStudent] = useState<{
    userId: string;
    studentName: string;
    quizId: string;
    quizTitle: string;
    offeringId: string | null;
  } | null>(null);

  // Which class accordions are expanded. Seeded with every class on load so the
  // board opens showing the assignments rather than a stack of shut headers.
  const [openClassIds, setOpenClassIds] = useState<string[]>([]);

  const byClass = useMemo(() => {
    const map = new Map<string, AssignedQuiz[]>();
    assignedQuizzes.forEach((a) => {
      const list = map.get(a.classId) || [];
      list.push(a);
      map.set(a.classId, list);
    });
    return map;
  }, [assignedQuizzes]);

  // Three-way split, per class. A draft is assigned but never published, so no
  // student can see it (RLS hides published_at IS NULL rows from them) — it does
  // not belong under Open. Publishing or closing an assignment moves its card
  // between the groups without a refetch.
  const splitByStatus = (list: AssignedQuiz[]) => ({
    drafts: list.filter((a) => a.closedAt === null && a.publishedAt === null),
    open: list.filter((a) => a.closedAt === null && a.publishedAt !== null),
    closed: list.filter((a) => a.closedAt !== null),
  });

  const {
    drafts: allDrafts,
    open: allOpen,
    closed: allClosed,
  } = splitByStatus(assignedQuizzes);
  const draftCount = allDrafts.length;
  const openCount = allOpen.length;
  const closedCount = allClosed.length;

  useEffect(() => {
    const fetchAssignments = async () => {
      setLoading(true);
      try {
        const { data: offerings, error: offeringsError } = await supabase
          .from("offerings")
          .select(
            "id, class_id, classes!inner(id, name, grade_level_id, section_name, category, academic_period)",
          )
          .eq("course_id", courseId);
        if (offeringsError) throw offeringsError;

        const offeringInfos: OfferingInfo[] = (offerings || []).map((o: any) => ({
          offeringId: o.id,
          classId: o.class_id,
        }));

        const classMap = new Map<string, ClassInfo>();
        (offerings || []).forEach((o: any) => {
          if (!o.classes) return;
          classMap.set(o.class_id, {
            id: o.class_id,
            displayName: buildClassDisplayName(o.classes),
            academicPeriod: o.classes.academic_period ?? null,
          });
        });
        setClassesById(classMap);

        const offeringIds = offeringInfos.map((o) => o.offeringId);
        if (offeringIds.length === 0) {
          setAssignedQuizzes([]);
          setLoading(false);
          return;
        }

        let oqQuery = supabase
          .from("offering_quizzes")
          .select(
            "id, offering_id, quiz_id, group_id, due_date, published_at, time_limit_override, answers_released, closed_at, quizzes!inner(id, title, time_limit_minutes, quiz_questions(count))",
          )
          .in("offering_id", offeringIds);
        if (quizId) oqQuery = oqQuery.eq("quiz_id", quizId);
        const { data: oqRows, error: oqError } = await oqQuery.order("due_date", {
          ascending: true,
          nullsFirst: false,
        });
        if (oqError) throw oqError;

        // Resolve cluster names + membership for any group-scoped assignments so
        // the board can label targets and scope stats to the group's members.
        const groupIds = [
          ...new Set((oqRows || []).map((r: any) => r.group_id).filter(Boolean)),
        ] as string[];
        const groupNameById = new Map<string, string>();
        const memberMap = new Map<string, Set<string>>();
        if (groupIds.length > 0) {
          const [{ data: groupRows, error: groupErr }, { data: memberRows, error: memberErr }] =
            await Promise.all([
              supabase.from("offering_groups").select("id, name").in("id", groupIds),
              supabase
                .from("offering_group_members")
                .select("group_id, user_id")
                .in("group_id", groupIds),
            ]);
          if (groupErr) throw groupErr;
          if (memberErr) throw memberErr;
          (groupRows || []).forEach((g: any) => groupNameById.set(g.id, g.name));
          (memberRows || []).forEach((m: any) => {
            const set = memberMap.get(m.group_id) || new Set<string>();
            set.add(m.user_id);
            memberMap.set(m.group_id, set);
          });
        }
        setMembersByGroup(memberMap);

        const offeringToClass = new Map(offeringInfos.map((o) => [o.offeringId, o.classId]));

        // Only drafts can be published, so only their generation state matters.
        const draftQuizIds = [
          ...new Set(
            (oqRows || [])
              .filter((r: any) => r.published_at === null && r.closed_at === null)
              .map((r: any) => r.quiz_id),
          ),
        ] as string[];
        const generationByQuiz = await generationStateForQuizzes(courseId, draftQuizIds);

        const assignments: AssignedQuiz[] = (oqRows || []).map((row: any) => ({
          assignmentId: row.id,
          offeringId: row.offering_id,
          classId: offeringToClass.get(row.offering_id) || "",
          quizId: row.quiz_id,
          quizTitle: row.quizzes?.title || "Untitled quiz",
          groupId: row.group_id ?? null,
          groupName: row.group_id ? groupNameById.get(row.group_id) ?? "Cluster" : null,
          questionCount: row.quizzes?.quiz_questions?.[0]?.count || 0,
          dueDate: row.due_date,
          publishedAt: row.published_at,
          timeLimitOverride: row.time_limit_override ?? null,
          timeLimitMinutes: row.quizzes?.time_limit_minutes ?? null,
          answersReleased: row.answers_released ?? false,
          closedAt: row.closed_at ?? null,
          generationState: generationByQuiz.get(row.quiz_id) ?? null,
        }));

        setAssignedQuizzes(assignments);

        const classIds = [...new Set(assignments.map((a) => a.classId).filter(Boolean))];
        // Expand every class by default (and again after a refetch, so a class
        // that only just received its first assignment is visible right away).
        setOpenClassIds(classIds);
        if (classIds.length > 0) {
          const { data: enrollments, error: enrollError } = await supabase
            .from("class_enrollments")
            .select("class_id, user_id")
            .in("class_id", classIds)
            .eq("role", "student");
          if (enrollError) throw enrollError;

          const userIds = [...new Set((enrollments || []).map((e) => e.user_id))];
          let profilesMap = new Map<string, { full_name: string | null; email: string | null }>();
          if (userIds.length > 0) {
            const { data: profiles, error: profilesError } = await supabase
              .from("profiles")
              .select("user_id, full_name, email")
              .in("user_id", userIds);
            if (profilesError) {
              console.error("Error fetching profiles:", profilesError);
            }
            profilesMap = new Map(
              (profiles || []).map((p) => [
                p.user_id,
                { full_name: p.full_name, email: p.email },
              ]),
            );
          }

          const rosterMap = new Map<string, StudentRoster[]>();
          (enrollments || []).forEach((e) => {
            const profile = profilesMap.get(e.user_id);
            const list = rosterMap.get(e.class_id) || [];
            list.push({
              userId: e.user_id,
              fullName: profile?.full_name || "Unnamed",
              email: profile?.email || "",
            });
            rosterMap.set(e.class_id, list);
          });
          rosterMap.forEach((list) => {
            list.sort((a, b) => compareText(a.fullName, b.fullName));
          });
          setRostersByClass(rosterMap);
        }
      } catch (error: any) {
        console.error("Error fetching assigned quizzes:", error);
        toast.error("Failed to load assigned quizzes");
      } finally {
        setLoading(false);
      }
    };

    fetchAssignments();
  }, [courseId, quizId, refreshKey, compareText]);

  // Roster for an assignment: the full class roster for a whole-class quiz, or
  // the class roster intersected with the cluster's members for a group-scoped
  // quiz. Both roster and stats are scoped through this.
  const getRosterForAssignment = (assignment: AssignedQuiz): StudentRoster[] => {
    const classRoster = rostersByClass.get(assignment.classId) || [];
    if (!assignment.groupId) return classRoster;
    const members = membersByGroup.get(assignment.groupId) ?? new Set<string>();
    return classRoster.filter((r) => members.has(r.userId));
  };

  const loadStatsForAssignment = async (
    assignment: AssignedQuiz,
    options: { force?: boolean } = {},
  ) => {
    if (!options.force && statsByAssignment.has(assignment.assignmentId)) return;
    if (loadingStats.has(assignment.assignmentId)) return;

    const roster = getRosterForAssignment(assignment);
    setLoadingStats((prev) => new Set(prev).add(assignment.assignmentId));

    try {
      if (roster.length === 0) {
        setStatsByAssignment((prev) =>
          new Map(prev).set(assignment.assignmentId, {
            total: 0,
            submitted: 0,
            averagePercentage: null,
            submissions: [],
            notSubmitted: [],
          }),
        );
        return;
      }

      const rosterIds = roster.map((r) => r.userId);

      // Match rows tagged with this offering_id, plus legacy rows where
      // offering_id was never set (submissions created before that column was
      // wired through on insert).
      // TODO: a student enrolled in more than one class that shares this quiz
      // will have their null-offering_id submission counted toward every
      // offering's stats, inflating the submitted count and average score.
      // Fix: backfill offering_id on legacy rows, then drop the IS NULL branch.
      const offeringOrNull = `offering_id.eq.${assignment.offeringId},offering_id.is.null`;

      const { data: sessions, error: sessionsError } = await supabase
        .from("quiz_sessions")
        .select("id, user_id, status, started_at, completed_at")
        .eq("quiz_id", assignment.quizId)
        .or(offeringOrNull)
        .in("user_id", rosterIds);
      if (sessionsError) throw sessionsError;

      const { data: answers, error: answersError } = await supabase
        .from("quiz_answers")
        .select("user_id, is_correct, answered_at")
        .eq("quiz_id", assignment.quizId)
        .or(offeringOrNull)
        .in("user_id", rosterIds);
      if (answersError) throw answersError;

      const sessionByUser = new Map<
        string,
        { id: string; status: string; startedAt: string | null; completedAt: string | null }
      >();
      (sessions || []).forEach((s) => {
        const existing = sessionByUser.get(s.user_id);
        const statusRank = (st: string) =>
          st === "completed" ? 3 : st === "expired" ? 2 : st === "in_progress" ? 1 : 0;
        if (!existing || statusRank(s.status) > statusRank(existing.status)) {
          sessionByUser.set(s.user_id, {
            id: s.id,
            status: s.status,
            startedAt: s.started_at ?? null,
            completedAt: s.completed_at,
          });
        }
      });

      const effectiveLimitMin =
        assignment.timeLimitOverride ?? assignment.timeLimitMinutes ?? null;
      const effectiveLimitMs =
        effectiveLimitMin != null && effectiveLimitMin > 0 ? effectiveLimitMin * 60_000 : null;

      const answerAggByUser = new Map<
        string,
        { correct: number; total: number; lastAnsweredAt: string }
      >();
      (answers || []).forEach((a) => {
        const existing = answerAggByUser.get(a.user_id) || {
          correct: 0,
          total: 0,
          lastAnsweredAt: a.answered_at,
        };
        answerAggByUser.set(a.user_id, {
          correct: existing.correct + (a.is_correct ? 1 : 0),
          total: existing.total + 1,
          lastAnsweredAt:
            a.answered_at > existing.lastAnsweredAt ? a.answered_at : existing.lastAnsweredAt,
        });
      });

      const submissions: SubmissionSummary[] = [];
      const notSubmitted: SubmissionSummary[] = [];

      roster.forEach((student) => {
        const session = sessionByUser.get(student.userId);
        const agg = answerAggByUser.get(student.userId);
        const hasWork = !!session || (agg && agg.total > 0);

        if (!hasWork) {
          notSubmitted.push({
            userId: student.userId,
            fullName: student.fullName,
            email: student.email,
            status: "not_started",
            correctCount: 0,
            totalAnswered: 0,
            percentage: null,
            completedAt: null,
            sessionId: null,
            overtime: false,
          });
          return;
        }

        const status: SubmissionSummary["status"] =
          session?.status === "completed" || session?.status === "expired"
            ? "completed"
            : session?.status === "in_progress"
              ? "in_progress"
              : agg && agg.total > 0
                ? "in_progress"
                : "not_started";

        const isCompleted = status === "completed";
        const completedAt =
          isCompleted ? session?.completedAt ?? agg?.lastAnsweredAt ?? null : null;

        let overtime = false;
        if (isCompleted && effectiveLimitMs && session?.startedAt && completedAt) {
          const elapsedMs =
            new Date(completedAt).getTime() - new Date(session.startedAt).getTime();
          overtime = elapsedMs > effectiveLimitMs + OVERTIME_TOLERANCE_MS;
        }

        submissions.push({
          userId: student.userId,
          fullName: student.fullName,
          email: student.email,
          status,
          // Hide partial work from instructors until the attempt is finalised.
          correctCount: isCompleted ? agg?.correct ?? 0 : 0,
          totalAnswered: isCompleted ? agg?.total ?? 0 : 0,
          percentage:
            isCompleted && agg && agg.total > 0
              ? Math.round((agg.correct / agg.total) * 100)
              : null,
          completedAt,
          sessionId: session?.id ?? null,
          overtime,
        });
      });

      submissions.sort((a, b) => {
        if ((b.percentage ?? -1) !== (a.percentage ?? -1)) {
          return (b.percentage ?? -1) - (a.percentage ?? -1);
        }
        return compareText(a.fullName, b.fullName);
      });

      const completedWithScore = submissions.filter((s) => s.percentage !== null);
      const averagePercentage =
        completedWithScore.length > 0
          ? Math.round(
              completedWithScore.reduce((sum, s) => sum + (s.percentage ?? 0), 0) /
                completedWithScore.length,
            )
          : null;

      setStatsByAssignment((prev) =>
        new Map(prev).set(assignment.assignmentId, {
          total: roster.length,
          submitted: submissions.length,
          averagePercentage,
          submissions,
          notSubmitted,
        }),
      );
    } catch (error: any) {
      console.error("Error loading quiz stats:", error);
      toast.error("Failed to load submission stats");
    } finally {
      setLoadingStats((prev) => {
        const next = new Set(prev);
        next.delete(assignment.assignmentId);
        return next;
      });
    }
  };

  const handleMarkComplete = async (
    assignment: AssignedQuiz,
    submission: SubmissionSummary,
  ) => {
    if (!submission.sessionId) {
      toast.error("This student hasn't started the quiz yet");
      return;
    }
    const sessionId = submission.sessionId;
    setMarkingComplete((prev) => new Set(prev).add(sessionId));
    try {
      const { error } = await supabase
        .from("quiz_sessions")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", sessionId);
      if (error) throw error;

      // Force a re-fetch so previously-hidden scores get recomputed from
      // quiz_answers under the new completed status.
      await loadStatsForAssignment(assignment, { force: true });

      toast.success(`Marked ${submission.fullName}'s attempt as completed`);
    } catch (error: any) {
      console.error("Error marking session as completed:", error);
      toast.error("Failed to mark as completed");
    } finally {
      setMarkingComplete((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  // Publishing is the only way a draft leaves the Drafts group: it stamps
  // published_at, which is what makes the assignment visible to students.
  //
  // The filters repeat the draft precondition the card was rendered from, so a
  // row another session closed, deleted or already published in the meantime
  // updates zero rows instead of being forced into a published-but-closed state
  // that students can see but cannot start. `.select()` is what lets us tell the
  // two apart — PostgREST reports no error for an update that matched nothing.
  const handlePublish = async (assignment: AssignedQuiz) => {
    const id = assignment.assignmentId;
    setPublishBusy((prev) => new Set(prev).add(id));
    try {
      // The card's disabled state is a board-load snapshot; a job can start,
      // advance or finish between then and this click. Re-read it here so the
      // decision is made on current state, and so a jobs read that failed at
      // load time gets a second chance instead of silently failing open.
      const fresh = (
        await generationStateForQuizzes(courseId, [assignment.quizId])
      ).get(assignment.quizId);
      if (fresh === "in_flight") {
        toast.error(
          "Questions are still being generated for this draft. Wait for generation to finish before publishing.",
        );
        return;
      }
      if (fresh === "unknown") {
        toast.error(
          "Could not check whether this draft has finished generating. Try again in a moment.",
        );
        return;
      }

      const publishedAt = new Date().toISOString();
      const { data, error } = await supabase
        .from("offering_quizzes")
        .update({ published_at: publishedAt })
        .eq("id", id)
        .is("published_at", null)
        .is("closed_at", null)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        toast.error(
          "This assignment changed since the board loaded — reload to see its current state.",
        );
        return;
      }
      setAssignedQuizzes((prev) =>
        prev.map((a) => (a.assignmentId === id ? { ...a, publishedAt } : a)),
      );
      onAssignmentsMutated?.();
      toast.success("Quiz published. Students in this class can start it now.");
    } catch (error: any) {
      console.error("Error publishing assignment:", error);
      toast.error("Failed to publish the quiz");
    } finally {
      setPublishBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleToggleClosed = async (assignment: AssignedQuiz, nextClosed: boolean) => {
    const id = assignment.assignmentId;
    setClosureBusy((prev) => new Set(prev).add(id));
    try {
      if (nextClosed) {
        const { data, error } = await supabase.rpc("mark_offering_quiz_done", {
          p_offering_quiz_id: id,
        });
        if (error) throw error;
        const closedAt = typeof data === "string" ? data : new Date().toISOString();
        setAssignedQuizzes((prev) =>
          prev.map((a) => (a.assignmentId === id ? { ...a, closedAt } : a)),
        );
        onAssignmentsMutated?.();
        // Force-finalize may have changed any in-progress sessions; refresh stats.
        await loadStatsForAssignment(assignment, { force: true });
        toast.success("Quiz marked as done. Students can no longer start new attempts.");
      } else {
        const { error } = await supabase.rpc("reopen_offering_quiz", {
          p_offering_quiz_id: id,
        });
        if (error) throw error;
        // reopen_offering_quiz clears answers_released in the same statement:
        // students can attempt the quiz again, so they must not keep the answer
        // key. A CHECK constraint makes open-and-released unrepresentable.
        setAssignedQuizzes((prev) =>
          prev.map((a) =>
            a.assignmentId === id
              ? { ...a, closedAt: null, answersReleased: false }
              : a,
          ),
        );
        onAssignmentsMutated?.();
        toast.success(
          assignment.answersReleased
            ? "Quiz reopened. Students can start new attempts again, and answers are hidden."
            : "Quiz reopened. Students can start new attempts again.",
        );
      }
    } catch (error: any) {
      console.error("Error toggling assignment closure:", error);
      toast.error(
        nextClosed ? "Failed to close the quiz" : "Failed to reopen the quiz",
      );
    } finally {
      setClosureBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  if (loading) {
    if (embedded) {
      return (
        <div
          data-testid="assigned-quizzes-board"
          className="flex items-center justify-center py-8"
        >
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
      <Card data-testid="assigned-quizzes-board">
        <CardContent className="py-8">
          <div className="flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (assignedQuizzes.length === 0) {
    if (embedded) {
      return (
        <div
          data-testid="assigned-quizzes-board"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          {quizId
            ? "No class has this quiz assigned yet. Use the assign action on the quiz row to create an assignment."
            : "No quizzes have been assigned to classes yet."}
        </div>
      );
    }
    return (
      <Card data-testid="assigned-quizzes-board">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <School className="w-5 h-5" />
            Assigned Quizzes
          </CardTitle>
          <CardDescription>
            Quizzes assigned to classes will appear here with submission summaries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="py-8 text-center text-sm text-muted-foreground">
            No quizzes have been assigned to classes yet. Use the "Assign to class" button
            on any quiz below to create an assignment.
          </div>
        </CardContent>
      </Card>
    );
  }

  const sortedClassIds = [...byClass.keys()].sort((a, b) => {
    const an = classesById.get(a)?.displayName || "";
    const bn = classesById.get(b)?.displayName || "";
    return compareText(an, bn);
  });

  const renderAssignmentCard = (assignment: AssignedQuiz) => (
    <AssignmentCard
      key={assignment.assignmentId}
      assignment={assignment}
      roster={getRosterForAssignment(assignment)}
      stats={statsByAssignment.get(assignment.assignmentId)}
      loading={loadingStats.has(assignment.assignmentId)}
      markingComplete={markingComplete}
      closureBusy={closureBusy.has(assignment.assignmentId)}
      publishBusy={publishBusy.has(assignment.assignmentId)}
      onExpand={() => loadStatsForAssignment(assignment)}
      onUpdate={(patch) => {
        // Cards call this only after their write succeeded (due date, time
        // limit, answers released), so it doubles as the mutation signal.
        setAssignedQuizzes((prev) =>
          prev.map((a) =>
            a.assignmentId === assignment.assignmentId ? { ...a, ...patch } : a,
          ),
        );
        onAssignmentsMutated?.();
      }}
      onViewStudent={(submission) =>
        setDrillStudent({
          userId: submission.userId,
          studentName: submission.fullName,
          quizId: assignment.quizId,
          quizTitle: assignment.quizTitle,
          offeringId: assignment.offeringId,
        })
      }
      onMarkComplete={(submission) => handleMarkComplete(assignment, submission)}
      onToggleClosed={(next) => handleToggleClosed(assignment, next)}
      onPublish={() => handlePublish(assignment)}
    />
  );

  const accordion = (
        <Accordion
          type="multiple"
          className="w-full space-y-2"
          value={openClassIds}
          onValueChange={setOpenClassIds}
        >
          {sortedClassIds.map((classId) => {
            const cls = classesById.get(classId);
            const classQuizzes = byClass.get(classId) || [];
            const roster = rostersByClass.get(classId) || [];
            const {
              drafts: draftQuizzes,
              open: openQuizzes,
              closed: closedQuizzes,
            } = splitByStatus(classQuizzes);
            return (
              <AccordionItem
                key={classId}
                value={classId}
                className="rounded-lg border bg-muted/20 px-3"
              >
                <AccordionTrigger className="hover:no-underline">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className="font-medium truncate">
                      {cls?.displayName || "Unknown class"}
                    </span>
                    {cls?.academicPeriod && (
                      <Badge variant="outline" className="text-xs font-normal">
                        {cls.academicPeriod}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-xs font-normal">
                      <Users className="w-3 h-3 mr-1" />
                      {roster.length} {roster.length === 1 ? "student" : "students"}
                    </Badge>
                    {draftQuizzes.length > 0 && (
                      <Badge
                        variant="outline"
                        className="text-xs font-normal border-muted-foreground/30 bg-muted text-muted-foreground"
                      >
                        <FileText className="w-3 h-3 mr-1" />
                        {draftQuizzes.length} draft
                      </Badge>
                    )}
                    {openQuizzes.length > 0 && (
                      <Badge
                        variant="outline"
                        className="text-xs font-normal border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      >
                        <LockOpen className="w-3 h-3 mr-1" />
                        {openQuizzes.length} open
                      </Badge>
                    )}
                    {closedQuizzes.length > 0 && (
                      <Badge
                        variant="outline"
                        className="text-xs font-normal border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      >
                        <Lock className="w-3 h-3 mr-1" />
                        {closedQuizzes.length} closed
                      </Badge>
                    )}
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-5 pb-1">
                    {draftQuizzes.length > 0 && (
                      <section
                        aria-label="Drafts"
                        data-testid={`draft-assignments-${classId}`}
                      >
                        <GroupHeading
                          icon={<FileText className="w-3.5 h-3.5 text-muted-foreground" />}
                          label="Drafts"
                          count={draftQuizzes.length}
                        />
                        <p className="mb-2 text-xs text-muted-foreground italic">
                          Not published — no student in this class can see these yet.
                        </p>
                        <div className="space-y-2">
                          {draftQuizzes.map(renderAssignmentCard)}
                        </div>
                      </section>
                    )}

                    <section
                      aria-label="Open sessions"
                      data-testid={`open-assignments-${classId}`}
                    >
                      <GroupHeading
                        icon={
                          <LockOpen className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        }
                        label="Open"
                        count={openQuizzes.length}
                      />
                      {openQuizzes.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">
                          {emptyOpenMessage(draftQuizzes.length, closedQuizzes.length)}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {openQuizzes.map(renderAssignmentCard)}
                        </div>
                      )}
                    </section>

                    {closedQuizzes.length > 0 && (
                      <section
                        aria-label="Closed sessions"
                        data-testid={`closed-assignments-${classId}`}
                      >
                        <GroupHeading
                          icon={
                            <Lock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                          }
                          label="Closed"
                          count={closedQuizzes.length}
                        />
                        <div className="space-y-2">
                          {closedQuizzes.map(renderAssignmentCard)}
                        </div>
                      </section>
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
  );

  const drill = drillStudent ? (
    <StudentAnswerDrillDown
      open={!!drillStudent}
      onOpenChange={(open) => {
        if (!open) setDrillStudent(null);
      }}
      userId={drillStudent.userId}
      studentName={drillStudent.studentName}
      quizId={drillStudent.quizId}
      quizTitle={drillStudent.quizTitle}
      offeringId={drillStudent.offeringId}
    />
  ) : null;

  if (embedded) {
    return (
      <div data-testid="assigned-quizzes-board">
        {accordion}
        {drill}
      </div>
    );
  }

  return (
    <Card data-testid="assigned-quizzes-board">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <School className="w-5 h-5" />
          Assigned Quizzes
        </CardTitle>
        <CardDescription>
          Track submissions per class and drill into any student's answers.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge variant="secondary" className="text-xs font-normal">
            <ClipboardList className="w-3 h-3 mr-1" />
            {`${assignedQuizzes.length} total across ${sortedClassIds.length} ${
              sortedClassIds.length === 1 ? "class" : "classes"
            }`}
          </Badge>
          {draftCount > 0 && (
            <Badge
              variant="outline"
              className="text-xs font-normal border-muted-foreground/30 bg-muted text-muted-foreground"
            >
              <FileText className="w-3 h-3 mr-1" />
              {draftCount} draft
            </Badge>
          )}
          <Badge
            variant="outline"
            className="text-xs font-normal border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          >
            <LockOpen className="w-3 h-3 mr-1" />
            {openCount} open
          </Badge>
          <Badge
            variant="outline"
            className="text-xs font-normal border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          >
            <Lock className="w-3 h-3 mr-1" />
            {closedCount} closed
          </Badge>
        </div>
      </CardHeader>
      <CardContent>{accordion}</CardContent>
      {drill}
    </Card>
  );
};

// Why a class has nothing open: still a draft, already closed, or a mix. Stating
// the actual reason beats a fixed sentence that is wrong two-thirds of the time.
const emptyOpenMessage = (draftCount: number, closedCount: number): string => {
  if (draftCount > 0 && closedCount > 0)
    return "No open quizzes — this class's assignments are drafts or closed.";
  if (draftCount > 0)
    return "No open quizzes — every assignment for this class is still a draft.";
  if (closedCount > 0)
    return "No open quizzes — every assignment for this class is closed.";
  return "No open quizzes for this class.";
};

// Section label for the drafts/open/closed split inside a class, with a hairline
// rule running to the edge so the groups read as distinct bands.
const GroupHeading = ({
  icon,
  label,
  count,
}: {
  icon: ReactNode;
  label: string;
  count: number;
}) => (
  <div className="mb-2 flex items-center gap-2">
    {icon}
    <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
    </h5>
    <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
      {count}
    </span>
    <span className="h-px flex-1 bg-border" aria-hidden="true" />
  </div>
);

interface AssignmentCardProps {
  assignment: AssignedQuiz;
  roster: StudentRoster[];
  stats: QuizStats | undefined;
  loading: boolean;
  markingComplete: Set<string>;
  closureBusy: boolean;
  publishBusy: boolean;
  onExpand: () => void;
  onUpdate: (patch: Partial<AssignedQuiz>) => void;
  onViewStudent: (submission: SubmissionSummary) => void;
  onMarkComplete: (submission: SubmissionSummary) => void;
  onToggleClosed: (nextClosed: boolean) => void;
  onPublish: () => void;
}

// All date/time display and entry uses the browser's local timezone. The stored
// UTC value will differ for instructors in different timezones, which is expected
// behaviour — each instructor schedules in their own local time.
const toDateInputValue = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const toTimeInputValue = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mi}`;
};

const AssignmentCard = ({
  assignment,
  roster,
  stats,
  loading,
  markingComplete,
  closureBusy,
  publishBusy,
  onExpand,
  onUpdate,
  onViewStudent,
  onMarkComplete,
  onToggleClosed,
  onPublish,
}: AssignmentCardProps) => {
  const { formatDate, formatDateTime } = useFormatters();
  const [expanded, setExpanded] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const isClosed = assignment.closedAt !== null;
  const isDraft = !isClosed && assignment.publishedAt === null;
  // A follow-up draft is assigned before its generation job runs, and that job
  // appends questions per (chapter, type) as each item finishes — so neither an
  // empty draft nor a nonempty one is necessarily ready. Block publishing while
  // the set is still being written; warn, but allow it, once the job has stopped
  // short, since those questions are all the instructor is going to get.
  const generationInFlight = isDraft && assignment.generationState === "in_flight";
  const isEmptyDraft = isDraft && assignment.questionCount === 0;
  const publishBlocked = isEmptyDraft || generationInFlight;
  const generationIncomplete =
    isDraft && !publishBlocked && assignment.generationState === "incomplete";
  // Left enabled on purpose: publishing re-checks first, so a jobs read that
  // failed once does not strand the draft behind a permanently dead button.
  const generationUnknown =
    isDraft && !publishBlocked && assignment.generationState === "unknown";

  const publishHint = generationInFlight
    ? `Questions are still being generated${
        assignment.questionCount > 0 ? ` (${assignment.questionCount} so far)` : ""
      }. Publishing now would show students a partial quiz — reload the board once generation finishes.`
    : isEmptyDraft
      ? "This draft has no questions yet. An AI follow-up draft is created before its questions are generated — wait for generation to finish, or add questions, before publishing."
      : generationIncomplete
        ? `Generation stopped before finishing, so this draft's ${assignment.questionCount} question(s) are all it will have. Review it before publishing.`
        : generationUnknown
          ? "Could not check whether this draft has finished generating — publishing will check again first."
          : "This assignment is a draft. Publishing makes it visible to the students it targets and moves it to Open.";
  const [dueDateInput, setDueDateInput] = useState(() =>
    toDateInputValue(assignment.dueDate),
  );
  const [dueTimeInput, setDueTimeInput] = useState(() =>
    toTimeInputValue(assignment.dueDate),
  );
  const [timeLimitInput, setTimeLimitInput] = useState(() =>
    assignment.timeLimitOverride != null ? String(assignment.timeLimitOverride) : "",
  );
  const [savingDue, setSavingDue] = useState(false);
  const [savingLimit, setSavingLimit] = useState(false);
  const [savingRelease, setSavingRelease] = useState(false);

  useEffect(() => {
    setDueDateInput(toDateInputValue(assignment.dueDate));
    setDueTimeInput(toTimeInputValue(assignment.dueDate));
  }, [assignment.dueDate]);

  useEffect(() => {
    setTimeLimitInput(
      assignment.timeLimitOverride != null ? String(assignment.timeLimitOverride) : "",
    );
  }, [assignment.timeLimitOverride]);

  const handleToggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !stats) onExpand();
  };

  const saveDueDate = async (nextIso: string | null) => {
    setSavingDue(true);
    try {
      const { error } = await supabase
        .from("offering_quizzes")
        .update({ due_date: nextIso })
        .eq("id", assignment.assignmentId);
      if (error) throw error;
      onUpdate({ dueDate: nextIso });
      toast.success(nextIso ? "Due date updated" : "Due date cleared");
    } catch (error: any) {
      console.error("Error updating due date:", error);
      toast.error("Failed to update due date");
    } finally {
      setSavingDue(false);
    }
  };

  const handleSaveDueDate = () => {
    if (!dueDateInput) {
      toast.error("Pick a date or use Clear");
      return;
    }
    const timePart = dueTimeInput || "23:59";
    const parsed = new Date(`${dueDateInput}T${timePart}`);
    if (Number.isNaN(parsed.getTime())) {
      toast.error("Invalid date");
      return;
    }
    saveDueDate(parsed.toISOString());
  };

  const handleClearDueDate = () => {
    setDueDateInput("");
    setDueTimeInput("");
    saveDueDate(null);
  };

  const handleToggleAnswersReleased = async (next: boolean) => {
    // Answers can only be released once the assignment is marked as done —
    // otherwise students still taking the quiz would see the correct answers.
    if (next && !isClosed) {
      toast.error("Mark the quiz as done before releasing answers to this class");
      return;
    }
    setSavingRelease(true);
    try {
      const { error } = await supabase
        .from("offering_quizzes")
        .update({ answers_released: next })
        .eq("id", assignment.assignmentId);
      if (error) throw error;
      onUpdate({ answersReleased: next });
      toast.success(
        next ? "Answers released to students" : "Answers hidden from students",
      );
    } catch (error: any) {
      console.error("Error updating answers_released:", error);
      toast.error("Failed to update answer release");
    } finally {
      setSavingRelease(false);
    }
  };

  const handleSaveTimeLimit = async () => {
    const trimmed = timeLimitInput.trim();
    let nextValue: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        toast.error("Time limit must be a positive number of minutes");
        return;
      }
      nextValue = parsed;
    }
    setSavingLimit(true);
    try {
      const { error } = await supabase
        .from("offering_quizzes")
        .update({ time_limit_override: nextValue })
        .eq("id", assignment.assignmentId);
      if (error) throw error;
      onUpdate({ timeLimitOverride: nextValue });
      toast.success(
        nextValue != null ? "Time limit updated" : "Time limit cleared",
      );
    } catch (error: any) {
      console.error("Error updating time limit:", error);
      toast.error("Failed to update time limit");
    } finally {
      setSavingLimit(false);
    }
  };

  const submittedCount = stats?.submitted ?? 0;
  const totalCount = stats?.total ?? 0;

  const submittedPct =
    totalCount > 0 ? Math.round((submittedCount / totalCount) * 100) : 0;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-l-[3px] bg-card transition-colors ${
        isClosed
          ? "border-l-amber-500/60 bg-muted/30"
          : assignment.publishedAt
            ? "border-l-emerald-500/60"
            : "border-l-muted-foreground/25"
      }`}
      data-testid={`assignment-card-${assignment.assignmentId}`}
    >
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/50 transition-colors"
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ClipboardList className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="font-medium truncate">{assignment.quizTitle}</span>
            <Badge
              variant={assignment.groupId ? "default" : "secondary"}
              className="text-xs font-normal"
              data-testid={`target-badge-${assignment.assignmentId}`}
            >
              {assignment.groupId ? (
                <>
                  <Users className="w-3 h-3 mr-1" />
                  {assignment.groupName}
                </>
              ) : (
                "Whole class"
              )}
            </Badge>
            {assignment.publishedAt ? (
              <Badge
                variant="outline"
                className="text-xs font-normal border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              >
                Published
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs font-normal">
                Not published
              </Badge>
            )}
            {isClosed && (
              <Badge
                variant="outline"
                className="text-xs font-normal border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                data-testid={`closed-badge-${assignment.assignmentId}`}
              >
                <Lock className="w-3 h-3 mr-1" />
                Closed
              </Badge>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1">
              <ClipboardList className="w-3 h-3" />
              {assignment.questionCount} questions
            </span>
            {assignment.dueDate && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Due {formatDate(assignment.dueDate)}
              </span>
            )}
            {assignment.timeLimitOverride != null && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {assignment.timeLimitOverride} min limit
              </span>
            )}
            {stats && (
              <>
                <span className="flex items-center gap-1.5">
                  {/* Built from spans, not <Progress>: this row is phrasing
                      content inside the card's header <button>. */}
                  <span
                    className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-full bg-primary/70 transition-all"
                      style={{ width: `${submittedPct}%` }}
                    />
                  </span>
                  {submittedCount} of {totalCount} submitted
                </span>
                {stats.averagePercentage !== null && (
                  <span className={`font-medium ${scoreColor(stats.averagePercentage)}`}>
                    Avg {stats.averagePercentage}%
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <ChevronRight
          className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform mt-1 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="border-t p-3 space-y-4">
          <section aria-label="Assignment settings">
            <h5 className="mb-2 text-sm font-semibold">Settings</h5>
            <div className="grid gap-3 sm:grid-cols-2">
              {isDraft && (
                <div className="space-y-1 sm:col-span-2">
                  <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-xs font-medium">Publish to this class</p>
                      <p className="text-xs text-muted-foreground">{publishHint}</p>
                    </div>
                    <div className="shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        onClick={onPublish}
                        disabled={publishBusy || publishBlocked}
                        title={publishBlocked ? publishHint : undefined}
                        data-testid={`publish-${assignment.assignmentId}`}
                      >
                        {publishBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Send className="w-3 h-3" />
                        )}
                        <span className="ml-1 text-xs">Publish</span>
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`due-date-${assignment.assignmentId}`} className="text-xs">
                  Due date
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={`due-date-${assignment.assignmentId}`}
                    type="date"
                    className="h-8 w-auto text-xs"
                    value={dueDateInput}
                    onChange={(e) => setDueDateInput(e.target.value)}
                    disabled={savingDue}
                  />
                  <Input
                    aria-label="Due time"
                    type="time"
                    className="h-8 w-auto text-xs"
                    value={dueTimeInput}
                    onChange={(e) => setDueTimeInput(e.target.value)}
                    disabled={savingDue}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    onClick={handleSaveDueDate}
                    disabled={savingDue}
                  >
                    {savingDue ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Save className="w-3 h-3" />
                    )}
                    <span className="ml-1 text-xs">Save</span>
                  </Button>
                  {assignment.dueDate && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      onClick={handleClearDueDate}
                      disabled={savingDue}
                    >
                      <X className="w-3 h-3" />
                      <span className="ml-1 text-xs">Clear</span>
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor={`time-limit-${assignment.assignmentId}`}
                  className="text-xs"
                >
                  Time limit override (minutes)
                </Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={`time-limit-${assignment.assignmentId}`}
                    type="number"
                    min={1}
                    placeholder="No limit"
                    className="h-8 w-28 text-xs"
                    value={timeLimitInput}
                    onChange={(e) => setTimeLimitInput(e.target.value)}
                    disabled={savingLimit}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8"
                    onClick={handleSaveTimeLimit}
                    disabled={savingLimit}
                  >
                    {savingLimit ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Save className="w-3 h-3" />
                    )}
                    <span className="ml-1 text-xs">Save</span>
                  </Button>
                </div>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-xs font-medium">
                      {isClosed ? "Quiz closed" : "Mark quiz as done"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isClosed
                        ? `Closed on ${formatDateTime(assignment.closedAt as string)}. Students in this class can review their answers but cannot start or submit new attempts.`
                        : "Closes this assignment for the class. Students with in-progress attempts will have them auto-finalized."}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {isClosed ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onToggleClosed(false)}
                        disabled={closureBusy}
                        data-testid={`reopen-${assignment.assignmentId}`}
                      >
                        {closureBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <LockOpen className="w-3 h-3" />
                        )}
                        <span className="ml-1 text-xs">Reopen</span>
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => setCloseConfirmOpen(true)}
                        disabled={closureBusy}
                        data-testid={`mark-done-${assignment.assignmentId}`}
                      >
                        {closureBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Lock className="w-3 h-3" />
                        )}
                        <span className="ml-1 text-xs">Mark as done</span>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
                  <div className="space-y-0.5 min-w-0">
                    <Label
                      htmlFor={`release-answers-${assignment.assignmentId}`}
                      className="text-xs font-medium"
                    >
                      Release answers to this class
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {!isClosed && !assignment.answersReleased
                        ? "Available once the quiz is marked as done — students still taking it must not see the answers."
                        : assignment.answersReleased
                          ? "Students in this class can see correct answers and explanations."
                          : "Students see a locked state until you release answers."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {savingRelease && (
                      <Loader2
                        className="w-3 h-3 animate-spin text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <Switch
                      id={`release-answers-${assignment.assignmentId}`}
                      checked={assignment.answersReleased}
                      onCheckedChange={handleToggleAnswersReleased}
                      disabled={
                        savingRelease || (!isClosed && !assignment.answersReleased)
                      }
                      aria-label="Release answers to this class"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <AlertDialog open={closeConfirmOpen} onOpenChange={setCloseConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Mark this quiz as done?</AlertDialogTitle>
                <AlertDialogDescription>
                  Students in this class will no longer be able to start new
                  attempts or submit answers. Any in-progress attempts will be
                  finalized with whatever answers they have. Students can still
                  review their submitted answers and score. You can reopen the
                  assignment later if needed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setCloseConfirmOpen(false);
                    onToggleClosed(true);
                  }}
                >
                  Mark as done
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {loading && !stats ? (
            <div className="py-4 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : !stats ? null : (
            <div className="space-y-4">
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h5 className="text-sm font-semibold">
                    Submitted ({stats.submissions.length})
                  </h5>
                </div>
                {stats.submissions.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    No students have submitted yet.
                  </p>
                ) : (
                  <ul className="divide-y rounded border">
                    {stats.submissions.map((s) => {
                      const isInProgress = s.status === "in_progress";
                      const isMarking = s.sessionId
                        ? markingComplete.has(s.sessionId)
                        : false;
                      return (
                        <li key={s.userId} className="flex items-stretch">
                          <button
                            type="button"
                            onClick={() => onViewStudent(s)}
                            className="flex flex-1 items-center justify-between gap-2 p-2 text-left hover:bg-muted/50 transition-colors min-w-0"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">
                                  {s.fullName}
                                </span>
                                {isInProgress && (
                                  <Badge variant="outline" className="text-xs">
                                    In progress
                                  </Badge>
                                )}
                                {s.overtime && (
                                  <Badge
                                    variant="outline"
                                    className="text-xs border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                    data-testid={`overtime-badge-${s.userId}`}
                                  >
                                    <Clock className="w-3 h-3 mr-1" />
                                    Over time
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground truncate">
                                {s.email}
                              </p>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              {isInProgress ? (
                                <span className="text-xs text-muted-foreground italic">
                                  Results hidden until finalised
                                </span>
                              ) : (
                                <>
                                  <Badge variant="outline" className="text-xs">
                                    {s.correctCount}/{s.totalAnswered}
                                  </Badge>
                                  <span className={`text-sm font-medium ${scoreColor(s.percentage)}`}>
                                    {s.percentage !== null ? `${s.percentage}%` : "—"}
                                  </span>
                                  <span className="hidden sm:inline text-xs text-muted-foreground w-20 text-right">
                                    {s.completedAt
                                      ? formatDate(s.completedAt)
                                      : ""}
                                  </span>
                                </>
                              )}
                            </div>
                          </button>
                          {isInProgress && s.sessionId && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-auto px-2 self-stretch rounded-none border-l text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                onMarkComplete(s);
                              }}
                              disabled={isMarking}
                              aria-label={`Mark ${s.fullName}'s attempt as completed`}
                            >
                              {isMarking ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-3 h-3" />
                              )}
                              <span className="ml-1 hidden sm:inline">
                                Mark complete
                              </span>
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section>
                <h5 className="mb-2 text-sm font-semibold">
                  Not submitted ({stats.notSubmitted.length})
                </h5>
                {stats.notSubmitted.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    Everyone in the class has started this quiz.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {stats.notSubmitted.map((s) => (
                      <li
                        key={s.userId}
                        className="rounded border bg-muted/40 px-2 py-1 text-xs"
                      >
                        {s.fullName}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AssignedQuizzesBoard;
