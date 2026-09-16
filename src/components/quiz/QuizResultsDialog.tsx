/**
 * Instructor results view for an assigned quiz, mirroring
 * `StudyGuideResultsDialog`: one dialog, scoped to ONE offering (with an
 * optional sub-group filter), holding both surfaces that used to be scattered
 * across three places —
 *
 *   - Students — live per-student status and score, deterministic arithmetic
 *     over `quiz_sessions` / `quiz_answers`, refetched on realtime events.
 *   - Assessment — the cached AI analysis (`QuizAnalysisPanel`) with its
 *     Report and Follow up sub-tabs, generated on demand.
 *
 * Visibility rests on RLS rather than a client-side role check: every table
 * read here is policed by `can_manage_offering`, so a section-limited
 * instructor sees only their own sections in the picker and in the data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { BarChart2, Loader2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollableDialogBody } from "@/components/ui/scrollable-dialog-body";
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
import { buildClassDisplayName } from "@/lib/greek-school";
import { QuizAnalysisPanel, type AnalysisRosterEntry } from "@/components/quiz/QuizAnalysisPanel";
import { StudentAnswerDrillDown } from "@/components/quiz/StudentAnswerDrillDown";
import { useFormatters } from "@/i18n/formatters";

/** Panels of the results view, addressable so a caller can open straight into one. */
export type QuizResultsTab = "students" | "assessment";

/** The two halves of the cached analysis, shown as sub-tabs of Assessment. */
type AnalysisView = "assessment" | "groups";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quizId: string | null;
  /** The quiz's course — the analysis panel's follow-up generator needs it. */
  courseId: string;
  quizTitle: string;
  /**
   * Panel to land on. The AI assessment has its own row action, so the
   * manager opens this dialog on "assessment" from that button and on
   * "students" from the results button — the tab is still switchable.
   */
  initialTab?: QuizResultsTab;
  /** Preselect this class in the scope picker (the tracking board's entry). */
  initialOfferingId?: string | null;
  /** Forwarded to the analysis panel's follow-up dialog. */
  onAssignmentsChanged?: () => void;
}

/** One (offering, group) target this quiz is published to. */
interface AssignmentTarget {
  offeringId: string;
  classLabel: string;
  groupId: string | null;
  groupName: string | null;
}

interface StudentRow {
  userId: string;
  fullName: string;
  status: "not_started" | "in_progress" | "completed";
  answered: number;
  correct: number;
  score: number | null;
}

const ALL_GROUPS = "__all__";

const statusLabel: Record<StudentRow["status"], string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

const statusVariant: Record<StudentRow["status"], "outline" | "secondary" | "default"> = {
  not_started: "outline",
  in_progress: "secondary",
  completed: "default",
};

function scoreClass(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 80) return "text-green-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

export function QuizResultsDialog({
  open,
  onOpenChange,
  quizId,
  courseId,
  quizTitle,
  initialTab = "students",
  initialOfferingId = null,
  onAssignmentsChanged,
}: Props) {
  const { compareText } = useFormatters();
  const [targets, setTargets] = useState<AssignmentTarget[]>([]);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string>(ALL_GROUPS);
  const [loadingTargets, setLoadingTargets] = useState(true);

  const [loading, setLoading] = useState(true);
  const [roster, setRoster] = useState<AnalysisRosterEntry[]>([]);
  const [questionCount, setQuestionCount] = useState(0);
  const [rows, setRows] = useState<StudentRow[]>([]);

  const [drillStudent, setDrillStudent] = useState<{ userId: string; name: string } | null>(null);

  // Re-seeded on every open so the tab follows the button that was pressed
  // rather than whatever the instructor last looked at.
  const [tab, setTab] = useState<QuizResultsTab>(initialTab);
  // Which half of the analysis the Assessment tab is showing. Follow up is a
  // sub-tab of Assessment, not a sibling: both halves live on one cached
  // analysis row, so they belong under one heading. Re-seeded with the tab.
  const [analysisView, setAnalysisView] = useState<AnalysisView>("assessment");
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setAnalysisView("assessment");
      if (initialOfferingId) setOfferingId(initialOfferingId);
    }
  }, [open, initialTab, initialOfferingId]);

  // ── Which classes/groups is this quiz published to? ────────────────────
  useEffect(() => {
    if (!open || !quizId) return;
    let cancelled = false;

    const fetchTargets = async () => {
      setLoadingTargets(true);
      try {
        // RLS on offering_quizzes restricts this to offerings the caller can
        // see; the manage check happens on the data reads below.
        const { data, error } = await supabase
          .from("offering_quizzes")
          .select(
            "offering_id, group_id, published_at, offerings!inner(id, classes!inner(id, name, grade_level_id, section_name, category, academic_period))",
          )
          .eq("quiz_id", quizId)
          .not("published_at", "is", null);
        if (error) throw error;

        const rows = (data ?? []) as unknown as Array<{
          offering_id: string;
          group_id: string | null;
          offerings: { classes: Record<string, unknown> };
        }>;

        const groupIds = rows.map((r) => r.group_id).filter((g): g is string => !!g);
        const groupNames = new Map<string, string>();
        if (groupIds.length > 0) {
          const { data: groups } = await supabase
            .from("offering_groups")
            .select("id, name")
            .in("id", groupIds);
          for (const g of groups ?? []) groupNames.set(g.id, g.name);
        }

        const list: AssignmentTarget[] = rows.map((r) => ({
          offeringId: r.offering_id,
          classLabel: buildClassDisplayName(r.offerings?.classes ?? {}),
          groupId: r.group_id,
          groupName: r.group_id ? groupNames.get(r.group_id) ?? "Group" : null,
        }));

        if (cancelled) return;
        setTargets(list);
        setOfferingId((prev) =>
          prev && list.some((t) => t.offeringId === prev) ? prev : list[0]?.offeringId ?? null,
        );
      } catch (err) {
        console.error("Failed to load quiz assignments", err);
        if (!cancelled) toast.error("Could not load this quiz's classes");
      } finally {
        if (!cancelled) setLoadingTargets(false);
      }
    };

    void fetchTargets();
    return () => {
      cancelled = true;
    };
  }, [open, quizId]);

  // Distinct offerings for the picker; a quiz assigned to several groups of
  // one class still shows that class once.
  const offeringOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of targets) if (!seen.has(t.offeringId)) seen.set(t.offeringId, t.classLabel);
    return [...seen].map(([id, label]) => ({ offeringId: id, classLabel: label }));
  }, [targets]);

  const groupOptions = useMemo(
    () =>
      targets
        .filter((t) => t.offeringId === offeringId && t.groupId)
        .map((t) => ({ groupId: t.groupId!, name: t.groupName ?? "Group" })),
    [targets, offeringId],
  );

  // Reset the group filter whenever the class changes — a group id from the
  // previous class would silently produce an empty roster.
  useEffect(() => {
    setGroupId(ALL_GROUPS);
  }, [offeringId]);

  // ── The data itself ─────────────────────────────────────────────────────
  // Incremented per fetch so a slow response from a previous scope (quiz,
  // class or group all switch while the dialog is open, and realtime events
  // pile on refetches) can never land its rows under the new scope's labels.
  const fetchGenRef = useRef(0);
  const fetchData = useCallback(async () => {
    if (!quizId || !offeringId) return;
    const gen = ++fetchGenRef.current;
    try {
      const { data: offering, error: offeringError } = await supabase
        .from("offerings")
        .select("class_id")
        .eq("id", offeringId)
        .single();
      if (offeringError) throw offeringError;

      const { count, error: countError } = await supabase
        .from("quiz_questions")
        .select("id", { count: "exact", head: true })
        .eq("quiz_id", quizId);
      if (countError) throw countError;

      // Roster, narrowed to who the quiz was PUBLISHED to. A quiz assigned
      // only to a group would otherwise list the rest of the class as "Not
      // started" — reporting students who were never given it as though they
      // were ignoring it.
      const { data: enrollments, error: enrollError } = await supabase
        .from("class_enrollments")
        .select("user_id")
        .eq("class_id", offering.class_id)
        .eq("role", "student");
      if (enrollError) throw enrollError;
      let userIds = [...new Set((enrollments ?? []).map((e) => e.user_id))];

      const offeringTargets = targets.filter((t) => t.offeringId === offeringId);
      const publishedToWholeClass = offeringTargets.some((t) => t.groupId === null);
      if (!publishedToWholeClass && userIds.length > 0) {
        const assignedGroupIds = offeringTargets
          .map((t) => t.groupId)
          .filter((g): g is string => !!g);
        const { data: assignedMembers, error: assignedError } = await supabase
          .from("offering_group_members")
          .select("user_id")
          .in("group_id", assignedGroupIds);
        if (assignedError) throw assignedError;
        const assignedIds = new Set((assignedMembers ?? []).map((m) => m.user_id));
        userIds = userIds.filter((id) => assignedIds.has(id));
      }

      if (groupId !== ALL_GROUPS) {
        const { data: members, error: memberError } = await supabase
          .from("offering_group_members")
          .select("user_id")
          .eq("group_id", groupId);
        if (memberError) throw memberError;
        const memberIds = new Set((members ?? []).map((m) => m.user_id));
        userIds = userIds.filter((id) => memberIds.has(id));
      }

      let loadedRoster: AnalysisRosterEntry[] = [];
      if (userIds.length > 0) {
        const { data: profiles, error: profileError } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", userIds);
        if (profileError) throw profileError;
        const byId = new Map(
          (profiles ?? []).map((p) => [p.user_id, p.full_name || p.email || "Unnamed student"]),
        );
        loadedRoster = userIds
          .map((id) => ({ userId: id, fullName: byId.get(id) ?? "Unnamed student" }))
          .sort((a, b) => compareText(a.fullName, b.fullName));
      }

      // Sessions and answers. `.or` keeps legacy rows where offering_id was
      // never set — the same idiom AssignedQuizzesBoard and analyze-quiz use.
      const offeringOrNull = `offering_id.eq.${offeringId},offering_id.is.null`;
      let sessions: Array<{
        id: string;
        user_id: string;
        status: string;
        started_at: string | null;
      }> = [];
      let answers: Array<{
        user_id: string;
        question_id: string;
        session_id: string | null;
        is_correct: boolean | null;
        offering_id: string | null;
        answered_at: string | null;
      }> = [];
      if (userIds.length > 0) {
        const [
          { data: sessionRows, error: sessionError },
          { data: answerRows, error: answerError },
        ] = await Promise.all([
          supabase
            .from("quiz_sessions")
            .select("id, user_id, status, started_at")
            .eq("quiz_id", quizId)
            .or(offeringOrNull)
            .in("user_id", userIds),
          supabase
            .from("quiz_answers")
            .select("user_id, question_id, session_id, is_correct, offering_id, answered_at")
            .eq("quiz_id", quizId)
            .or(offeringOrNull)
            .in("user_id", userIds),
        ]);
        if (sessionError) throw sessionError;
        if (answerError) throw answerError;
        sessions = (sessionRows ?? []) as typeof sessions;
        answers = (answerRows ?? []) as typeof answers;
      }

      // A row describes ONE attempt, never a blend: each student is scored
      // from their LATEST session's answers, so a retake after a reopen shows
      // the retake — not a mix of old and new answers under a "Completed"
      // badge inherited from the earlier attempt. Answers that predate
      // session tracking (session_id null) fall back to a latest-per-question
      // dedupe, the same idiom analyze-quiz uses for legacy rows.
      const latestSessionByUser = new Map<
        string,
        { id: string; status: string; startedAt: string }
      >();
      for (const s of sessions) {
        const prev = latestSessionByUser.get(s.user_id);
        const startedAt = s.started_at ?? "";
        if (!prev || startedAt > prev.startedAt) {
          latestSessionByUser.set(s.user_id, { id: s.id, status: s.status, startedAt });
        }
      }

      const answersByUser = new Map<string, typeof answers>();
      for (const a of answers) {
        const list = answersByUser.get(a.user_id);
        if (list) list.push(a);
        else answersByUser.set(a.user_id, [a]);
      }

      const statsFor = (userId: string): { answered: number; correct: number } => {
        const userAnswers = answersByUser.get(userId) ?? [];
        const latest = latestSessionByUser.get(userId);
        const attemptAnswers = latest
          ? userAnswers.filter((a) => a.session_id === latest.id)
          : [];
        if (attemptAnswers.length > 0) {
          return {
            answered: attemptAnswers.length,
            correct: attemptAnswers.filter((a) => !!a.is_correct).length,
          };
        }
        // A fresh retake whose latest session has no answers yet is a genuine
        // 0/0, not a reason to fall back — showing the previous attempt's
        // numbers next to an "In progress" badge would describe no actual
        // attempt. The fallback below is only for answers that predate
        // session tracking entirely (no session-tagged rows to score from).
        if (latest && userAnswers.some((a) => a.session_id !== null)) {
          return { answered: 0, correct: 0 };
        }
        // Legacy path: no session-tagged answers — dedupe per question,
        // preferring this offering's row, then the latest answered_at.
        const byQuestion = new Map<
          string,
          { is_correct: boolean; offeringMatch: boolean; answeredAt: string }
        >();
        for (const a of userAnswers) {
          const offeringMatch = a.offering_id === offeringId;
          const answeredAt = a.answered_at ?? "";
          const existing = byQuestion.get(a.question_id);
          const isBetter =
            !existing ||
            (offeringMatch && !existing.offeringMatch) ||
            (offeringMatch === existing.offeringMatch && answeredAt > existing.answeredAt);
          if (isBetter) {
            byQuestion.set(a.question_id, { is_correct: !!a.is_correct, offeringMatch, answeredAt });
          }
        }
        const values = [...byQuestion.values()];
        return { answered: values.length, correct: values.filter((v) => v.is_correct).length };
      };

      const loadedRows: StudentRow[] = loadedRoster.map((student) => {
        const stats = statsFor(student.userId);
        const latest = latestSessionByUser.get(student.userId);
        // Status follows the LATEST attempt: a student retaking after a
        // reopen is "In progress" even though an older session completed.
        // "expired" is a finalized attempt — the time ran out and whatever
        // was answered stands — so it reports as a completion.
        const status: StudentRow["status"] = latest
          ? latest.status === "completed" || latest.status === "expired"
            ? "completed"
            : "in_progress"
          : stats.answered > 0
            ? "in_progress"
            : "not_started";
        return {
          userId: student.userId,
          fullName: student.fullName,
          status,
          answered: stats.answered,
          correct: stats.correct,
          score: stats.answered > 0 ? Math.round((stats.correct / stats.answered) * 100) : null,
        };
      });

      if (gen !== fetchGenRef.current) return;
      setQuestionCount(count ?? 0);
      setRoster(loadedRoster);
      setRows(loadedRows);
    } catch (err) {
      if (gen !== fetchGenRef.current) return;
      console.error("Failed to load quiz results", err);
      toast.error("Could not load the results for this quiz");
    } finally {
      if (gen === fetchGenRef.current) setLoading(false);
    }
    // `targets` is a dependency: the roster depends on WHO the quiz was
    // published to, so a target list that arrives late must trigger a refetch.
  }, [quizId, offeringId, groupId, targets, compareText]);

  useEffect(() => {
    if (!open || !quizId || !offeringId) return;
    setLoading(true);
    void fetchData();
  }, [open, quizId, offeringId, fetchData]);

  // ── Realtime: refetch as students submit ────────────────────────────────
  useEffect(() => {
    if (!open || !quizId || !offeringId) return;
    const channel = supabase
      .channel(`quiz-results-${quizId}-${offeringId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "quiz_answers",
          filter: `offering_id=eq.${offeringId}`,
        },
        () => void fetchData(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "quiz_sessions",
          filter: `offering_id=eq.${offeringId}`,
        },
        () => void fetchData(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [open, quizId, offeringId, fetchData]);

  // Names the cohort every number on this surface describes — see the
  // study-guide dialog for why the unfiltered view is not always "Whole class".
  const publishedToWholeClass = useMemo(
    () => targets.some((t) => t.offeringId === offeringId && t.groupId === null),
    [targets, offeringId],
  );
  const allStudentsLabel = publishedToWholeClass ? "Whole class" : "All assigned students";

  const scopeLabel = useMemo(() => {
    if (groupId === ALL_GROUPS) return allStudentsLabel;
    return groupOptions.find((g) => g.groupId === groupId)?.name ?? "Group";
  }, [groupId, groupOptions, allStudentsLabel]);

  const startedCount = rows.filter((s) => s.status !== "not_started").length;
  const completedCount = rows.filter((s) => s.status === "completed").length;
  // Distinct submitters — what the AI floor is measured against.
  const submissionCount = rows.filter((s) => s.answered > 0).length;

  const busy = loadingTargets || loading;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[90vh] max-w-5xl flex-col"
          data-testid="quiz-results-dialog"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4" />
              Quiz results
            </DialogTitle>
            <DialogDescription className="truncate">{quizTitle}</DialogDescription>
          </DialogHeader>

          {!loadingTargets && targets.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              This quiz is not assigned to any of your classes yet.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Class:</span>
                  <Select
                    value={offeringId ?? ""}
                    onValueChange={setOfferingId}
                    disabled={offeringOptions.length === 0}
                  >
                    <SelectTrigger className="h-8 w-[230px]" data-testid="quiz-results-class">
                      <SelectValue placeholder="Select class" />
                    </SelectTrigger>
                    <SelectContent>
                      {offeringOptions.map((o) => (
                        <SelectItem key={o.offeringId} value={o.offeringId}>
                          {o.classLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {groupOptions.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Group:</span>
                    <Select value={groupId} onValueChange={setGroupId}>
                      <SelectTrigger className="h-8 w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL_GROUPS}>{allStudentsLabel}</SelectItem>
                        {groupOptions.map((g) => (
                          <SelectItem key={g.groupId} value={g.groupId}>
                            {g.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="ml-auto flex items-center gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <Users className="h-3 w-3" />
                    {startedCount}/{rows.length} started
                  </Badge>
                  <Badge variant="outline">{completedCount} completed</Badge>
                </div>
              </div>

              {busy ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ScrollableDialogBody className="-mx-6 px-6">
                  <Tabs
                    value={tab}
                    onValueChange={(next) => setTab(next as QuizResultsTab)}
                    className="w-full py-2"
                  >
                    {/* The long second label can outgrow a narrow dialog, so
                        let the row wrap instead of clipping. */}
                    <TabsList className="mb-3 h-auto flex-wrap justify-start">
                      <TabsTrigger value="students">Students</TabsTrigger>
                      <TabsTrigger value="assessment">AI Analysis &amp; Follow up</TabsTrigger>
                    </TabsList>

                    <TabsContent value="students">
                      <StudentTable
                        rows={rows}
                        questionCount={questionCount}
                        onDrill={(row) =>
                          setDrillStudent({ userId: row.userId, name: row.fullName })
                        }
                      />
                    </TabsContent>

                    <TabsContent value="assessment">
                      {quizId && offeringId && (
                        /* Report and Follow up are sub-tabs sharing ONE panel
                           instance (a nested Tabs whose triggers flip `view`,
                           not two TabsContent) — see StudyGuideResultsDialog
                           for the full rationale: both halves live on the same
                           cached analysis row, and the shared instance keeps
                           the in-flight save guard and unsaved group edits
                           alive across a flip. The aria wiring is explicit
                           because the panel is not a Radix TabsContent. */
                        <Tabs
                          value={analysisView}
                          onValueChange={(next) => setAnalysisView(next as AnalysisView)}
                          className="w-full"
                        >
                          <TabsList className="mb-3">
                            <TabsTrigger
                              value="assessment"
                              id="quiz-results-tab-assessment"
                              aria-controls="quiz-results-analysis-tabpanel"
                            >
                              Report
                            </TabsTrigger>
                            <TabsTrigger
                              value="groups"
                              id="quiz-results-tab-groups"
                              aria-controls="quiz-results-analysis-tabpanel"
                            >
                              Follow up
                            </TabsTrigger>
                          </TabsList>
                          <div
                            id="quiz-results-analysis-tabpanel"
                            role="tabpanel"
                            tabIndex={0}
                            aria-labelledby={
                              analysisView === "groups"
                                ? "quiz-results-tab-groups"
                                : "quiz-results-tab-assessment"
                            }
                          >
                            <QuizAnalysisPanel
                              quizId={quizId}
                              courseId={courseId}
                              offeringId={offeringId}
                              groupId={groupId === ALL_GROUPS ? null : groupId}
                              view={analysisView}
                              scopeLabel={scopeLabel}
                              submissionCount={submissionCount}
                              quizTitle={quizTitle}
                              roster={roster}
                              onAssignmentsChanged={onAssignmentsChanged}
                            />
                          </div>
                        </Tabs>
                      )}
                    </TabsContent>
                  </Tabs>
                </ScrollableDialogBody>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {quizId && offeringId && drillStudent && (
        <StudentAnswerDrillDown
          open={!!drillStudent}
          onOpenChange={(next) => !next && setDrillStudent(null)}
          quizId={quizId}
          offeringId={offeringId}
          userId={drillStudent.userId}
          studentName={drillStudent.name}
          quizTitle={quizTitle}
        />
      )}
    </>
  );
}

function StudentTable({
  rows,
  questionCount,
  onDrill,
}: {
  rows: StudentRow[];
  questionCount: number;
  onDrill: (row: StudentRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No students are enrolled in this selection.
      </p>
    );
  }
  return (
    <Table data-testid="quiz-results-students">
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-[120px] text-right">Answered</TableHead>
          <TableHead className="w-[110px] text-right">Correct</TableHead>
          <TableHead className="w-[100px] text-right">Score</TableHead>
          <TableHead className="w-[80px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.userId} data-testid={`quiz-results-student-${row.userId}`}>
            <TableCell className="font-medium">{row.fullName}</TableCell>
            <TableCell>
              <Badge variant={statusVariant[row.status]}>{statusLabel[row.status]}</Badge>
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {row.answered}/{questionCount}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.answered === 0 ? "—" : `${row.correct}/${row.answered}`}
            </TableCell>
            <TableCell className={`text-right tabular-nums ${scoreClass(row.score)}`}>
              {row.score === null ? "—" : `${row.score}%`}
            </TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDrill(row)}
                disabled={row.answered === 0}
                title={
                  row.answered === 0
                    ? "This student has not submitted anything yet"
                    : "See every answer"
                }
              >
                View
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default QuizResultsDialog;
