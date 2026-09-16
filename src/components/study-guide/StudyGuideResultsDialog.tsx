/**
 * Instructor results view for an assigned study guide (#981, epic #976).
 *
 * Scoped to ONE offering (with an optional sub-group filter) and split in two:
 *
 *   - Live raw statistics — per-student position, per-piece and per-question
 *     aggregates, and a competency roll-up. All deterministic arithmetic (see
 *     `@/lib/study-guide-analytics`), refetched on realtime events as students
 *     submit. These are always shown, whatever the data volume.
 *   - The cached AI class assessment (`StudyGuideAnalysisPanel`), which is
 *     generated on demand and gated behind a submission floor.
 *
 * Visibility rests on RLS rather than a client-side role check: every table
 * read here is policed by `can_manage_offering`, which already folds in the
 * `course_instructor_sections` restriction, so a section-limited instructor
 * sees only their own sections both in the offering picker and in the data.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AlertTriangle, BarChart2, Loader2, Users } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildClassDisplayName } from "@/lib/greek-school";
import { mcqOptionsFromPayload } from "@/lib/question-payload";
import { processLatexContent } from "@/lib/latex-utils";
import type { QuestionType } from "@/types/question";
import { mcqSelectedIndices } from "@/lib/study-guide-player";
import {
  buildCompetencyAggregates,
  buildPieceAggregates,
  buildQuestionAggregates,
  buildStudentRows,
  type AnalyticsAnswer,
  type AnalyticsPiece,
  type AnalyticsProgress,
  type AnalyticsQuestion,
  type AnalyticsStudent,
  type CompetencyAggregate,
  type PieceAggregate,
  type QuestionAggregate,
  type StudentRow,
} from "@/lib/study-guide-analytics";
import { StudyGuideAnalysisPanel } from "@/components/study-guide/StudyGuideAnalysisPanel";
import { StudyGuideAnswerDrillDown } from "@/components/study-guide/StudyGuideAnswerDrillDown";
import { useFormatters, useIntlLocale } from "@/i18n/formatters";

/** Panels of the results view, addressable so a caller can open straight into one. */
type ResultsTab = "students" | "pieces" | "competencies" | "assessment";

/** The two halves of the cached analysis, shown as sub-tabs of Assessment. */
type AnalysisView = "assessment" | "groups";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  studyGuideId: string | null;
  /** The guide's course — the analysis panel's follow-up generator needs it. */
  courseId: string;
  studyGuideTitle: string;
  /**
   * Panel to land on. The AI class assessment has its own row action,
   * so the manager opens this dialog on "assessment" from that button and on
   * "students" from the results button — the tab is still switchable either way.
   */
  initialTab?: ResultsTab;
}

/** One (offering, group) target this guide is published to. */
interface AssignmentTarget {
  offeringId: string;
  classLabel: string;
  groupId: string | null;
  groupName: string | null;
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

/** Strip tags/markup so a question stem fits on one table row. */
function plainStem(html: string, max = 90): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function StudyGuideResultsDialog({
  open,
  onOpenChange,
  studyGuideId,
  courseId,
  studyGuideTitle,
  initialTab = "students",
}: Props) {
  const { compareText } = useFormatters();
  const locale = useIntlLocale();
  const [targets, setTargets] = useState<AssignmentTarget[]>([]);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string>(ALL_GROUPS);
  const [loadingTargets, setLoadingTargets] = useState(true);

  const [loading, setLoading] = useState(true);
  const [pieces, setPieces] = useState<AnalyticsPiece[]>([]);
  const [questions, setQuestions] = useState<AnalyticsQuestion[]>([]);
  const [roster, setRoster] = useState<AnalyticsStudent[]>([]);
  const [progress, setProgress] = useState<AnalyticsProgress[]>([]);
  const [answers, setAnswers] = useState<AnalyticsAnswer[]>([]);
  const [competencyTitles, setCompetencyTitles] = useState<Map<string, string>>(new Map());

  const [drillStudent, setDrillStudent] = useState<{ userId: string; name: string } | null>(null);

  // Re-seeded on every open so the tab follows the button that was pressed
  // rather than whatever the instructor last looked at.
  const [tab, setTab] = useState<ResultsTab>(initialTab);
  // Which half of the analysis the Assessment tab is showing. Groups is a
  // sub-tab of Assessment, not a sibling: both halves live on one cached
  // analysis row, so they belong under one heading. Re-seeded with the tab.
  const [analysisView, setAnalysisView] = useState<AnalysisView>("assessment");
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setAnalysisView("assessment");
    }
  }, [open, initialTab]);

  // ── Which classes/groups is this guide published to? ──────────────────
  useEffect(() => {
    if (!open || !studyGuideId) return;
    let cancelled = false;

    const fetchTargets = async () => {
      setLoadingTargets(true);
      try {
        // RLS on offering_study_guides restricts this to offerings the caller
        // manages, so the picker can never name a section they don't teach.
        const { data, error } = await supabase
          .from("offering_study_guides")
          .select(
            "offering_id, group_id, published_at, offerings!inner(id, classes!inner(id, name, grade_level_id, section_name, category, academic_period))",
          )
          .eq("study_guide_id", studyGuideId)
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
        console.error("Failed to load study guide assignments", err);
        if (!cancelled) toast.error("Could not load this guide's classes");
      } finally {
        if (!cancelled) setLoadingTargets(false);
      }
    };

    void fetchTargets();
    return () => {
      cancelled = true;
    };
  }, [open, studyGuideId]);

  // Distinct offerings for the picker; a guide assigned to several groups of
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

  // ── The data itself ───────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!studyGuideId || !offeringId) return;
    try {
      const { data: offering, error: offeringError } = await supabase
        .from("offerings")
        .select("class_id")
        .eq("id", offeringId)
        .single();
      if (offeringError) throw offeringError;

      const { data: pieceRows, error: pieceError } = await supabase
        .from("study_guide_pieces")
        .select("id, position, title")
        .eq("study_guide_id", studyGuideId)
        .order("position", { ascending: true });
      if (pieceError) throw pieceError;
      const loadedPieces: AnalyticsPiece[] = (pieceRows ?? []).map((p) => ({
        id: p.id,
        position: p.position,
        title: p.title,
      }));

      let loadedQuestions: AnalyticsQuestion[] = [];
      if (loadedPieces.length > 0) {
        const { data: linkRows, error: linkError } = await supabase
          .from("study_guide_piece_questions")
          .select(
            "piece_id, position, question_id, questions(id, type, question, payload, competency_id)",
          )
          .in("piece_id", loadedPieces.map((p) => p.id))
          .order("position", { ascending: true });
        if (linkError) throw linkError;
        loadedQuestions = (linkRows ?? []).map((row) => {
          const link = row as unknown as {
            piece_id: string;
            position: number;
            question_id: string;
            questions: {
              type: string;
              question: string | null;
              payload: unknown;
              competency_id: string | null;
            };
          };
          return {
            id: link.question_id,
            pieceId: link.piece_id,
            position: link.position ?? 0,
            type: (link.questions?.type ?? "mcq") as QuestionType,
            text: link.questions?.question ?? "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            options: mcqOptionsFromPayload((link.questions?.payload ?? null) as any),
            competencyId: link.questions?.competency_id ?? null,
          };
        });
      }

      // Roster, narrowed to the selected group when one is chosen.
      const { data: enrollments, error: enrollError } = await supabase
        .from("class_enrollments")
        .select("user_id")
        .eq("class_id", offering.class_id)
        .eq("role", "student");
      if (enrollError) throw enrollError;
      let userIds = [...new Set((enrollments ?? []).map((e) => e.user_id))];

      // "Whole class" means every student the guide was PUBLISHED to, not every
      // student enrolled. A guide assigned only to a group would otherwise list
      // the rest of the class as "Not started" — reporting students who were
      // never given it as though they were ignoring it.
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

      let loadedRoster: AnalyticsStudent[] = [];
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

      let loadedProgress: AnalyticsProgress[] = [];
      let loadedAnswers: AnalyticsAnswer[] = [];
      if (userIds.length > 0) {
        const [{ data: progressRows, error: progressError }, { data: answerRows, error: answerError }] =
          await Promise.all([
            supabase
              .from("study_guide_progress")
              .select("user_id, current_piece_position, completed_at")
              .eq("study_guide_id", studyGuideId)
              .eq("offering_id", offeringId)
              .in("user_id", userIds),
            supabase
              .from("study_guide_answers")
              .select("user_id, question_id, piece_id, submission, is_correct, grade")
              .eq("study_guide_id", studyGuideId)
              .eq("offering_id", offeringId)
              .in("user_id", userIds),
          ]);
        if (progressError) throw progressError;
        if (answerError) throw answerError;

        loadedProgress = (progressRows ?? []).map((p) => ({
          userId: p.user_id,
          currentPiecePosition: p.current_piece_position ?? 0,
          completedAt: p.completed_at,
        }));
        loadedAnswers = (answerRows ?? []).map((a) => ({
          userId: a.user_id,
          questionId: a.question_id,
          pieceId: a.piece_id,
          selectedIndices: mcqSelectedIndices(a.submission),
          isCorrect: a.is_correct,
          grade: typeof a.grade === "number" ? a.grade : null,
        }));
      }

      // Titles for the competencies this guide's questions reference.
      const competencyIds = [
        ...new Set(loadedQuestions.map((q) => q.competencyId).filter((c): c is string => !!c)),
      ];
      const titles = new Map<string, string>();
      if (competencyIds.length > 0) {
        const { data: comps } = await supabase
          .from("course_competencies")
          .select("id, title")
          .in("id", competencyIds);
        for (const c of comps ?? []) titles.set(c.id, c.title);
      }

      setPieces(loadedPieces);
      setQuestions(loadedQuestions);
      setRoster(loadedRoster);
      setProgress(loadedProgress);
      setAnswers(loadedAnswers);
      setCompetencyTitles(titles);
    } catch (err) {
      console.error("Failed to load study guide results", err);
      toast.error("Could not load the results for this study guide");
    } finally {
      setLoading(false);
    }
    // `targets` is a dependency: the roster depends on WHO the guide was
    // published to, so a target list that arrives late must trigger a refetch.
  }, [studyGuideId, offeringId, groupId, targets, compareText]);

  useEffect(() => {
    if (!open || !studyGuideId || !offeringId) return;
    setLoading(true);
    void fetchData();
  }, [open, studyGuideId, offeringId, fetchData]);

  // ── Realtime: refetch as students submit ──────────────────────────────
  // Refetching wholesale rather than patching state from the payload: the
  // aggregates are cheap, and a partial patch would have to replicate every
  // derivation here to stay consistent with a full load.
  useEffect(() => {
    if (!open || !studyGuideId || !offeringId) return;
    const channel = supabase
      .channel(`sg-results-${studyGuideId}-${offeringId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "study_guide_answers",
          filter: `offering_id=eq.${offeringId}`,
        },
        () => void fetchData(),
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "study_guide_progress",
          filter: `offering_id=eq.${offeringId}`,
        },
        () => void fetchData(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [open, studyGuideId, offeringId, fetchData]);

  // ── Derived views ─────────────────────────────────────────────────────
  const studentRows = useMemo(
    () => buildStudentRows(roster, progress, answers, pieces.length),
    [roster, progress, answers, pieces.length],
  );
  const pieceAggregates = useMemo(
    () => buildPieceAggregates(pieces, questions, answers, progress),
    [pieces, questions, answers, progress],
  );
  const questionAggregates = useMemo(
    () => buildQuestionAggregates(questions, answers),
    [questions, answers],
  );
  const competencyAggregates = useMemo(
    () => buildCompetencyAggregates(questions, answers, competencyTitles, undefined, locale),
    [questions, answers, competencyTitles, locale],
  );

  const pieceTitleByPosition = useMemo(
    () => new Map(pieces.map((p) => [p.position, p.title])),
    [pieces],
  );
  const questionsByPiece = useMemo(() => {
    const map = new Map<string, QuestionAggregate[]>();
    for (const qa of questionAggregates) {
      const list = map.get(qa.pieceId);
      if (list) list.push(qa);
      else map.set(qa.pieceId, [qa]);
    }
    return map;
  }, [questionAggregates]);

  // Names the cohort every number on this surface describes. Passed down to
  // the AI panel too, whose cached report is keyed by exactly this scope.
  // A guide assigned only to groups has no whole-class cohort, so calling the
  // unfiltered view "Whole class" would name a population that was never given
  // it. Say what the rows actually are instead.
  const publishedToWholeClass = useMemo(
    () => targets.some((t) => t.offeringId === offeringId && t.groupId === null),
    [targets, offeringId],
  );
  const allStudentsLabel = publishedToWholeClass ? "Whole class" : "All assigned students";

  const scopeLabel = useMemo(() => {
    if (groupId === ALL_GROUPS) return allStudentsLabel;
    return groupOptions.find((g) => g.groupId === groupId)?.name ?? "Group";
  }, [groupId, groupOptions, allStudentsLabel]);

  const startedCount = studentRows.filter((s) => s.status !== "not_started").length;
  const completedCount = studentRows.filter((s) => s.status === "completed").length;
  // Distinct submitters — what the AI floor is measured against.
  const submissionCount = useMemo(
    () => new Set(answers.map((a) => a.userId)).size,
    [answers],
  );

  const busy = loadingTargets || loading;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[90vh] max-w-5xl flex-col"
          data-testid="sg-results-dialog"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart2 className="h-4 w-4" />
              Study guide results
            </DialogTitle>
            <DialogDescription className="truncate">{studyGuideTitle}</DialogDescription>
          </DialogHeader>

          {!loadingTargets && targets.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              This study guide is not assigned to any of your classes yet.
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
                    <SelectTrigger className="h-8 w-[230px]" data-testid="sg-results-class">
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
                    {startedCount}/{studentRows.length} started
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
                    onValueChange={(next) => setTab(next as ResultsTab)}
                    className="w-full py-2"
                  >
                    {/* The long fourth label can outgrow a narrow dialog, so
                        let the row wrap instead of clipping. */}
                    <TabsList className="mb-3 h-auto flex-wrap justify-start">
                      <TabsTrigger value="students">Students</TabsTrigger>
                      <TabsTrigger value="pieces">Pieces</TabsTrigger>
                      <TabsTrigger value="competencies">Competencies</TabsTrigger>
                      <TabsTrigger value="assessment">AI Analysis &amp; Follow up</TabsTrigger>
                    </TabsList>

                    <TabsContent value="students">
                      <StudentTable
                        rows={studentRows}
                        pieceCount={pieces.length}
                        onDrill={(row) =>
                          setDrillStudent({ userId: row.userId, name: row.fullName })
                        }
                      />
                    </TabsContent>

                    <TabsContent value="pieces">
                      <PieceList
                        aggregates={pieceAggregates}
                        questionsByPiece={questionsByPiece}
                      />
                    </TabsContent>

                    <TabsContent value="competencies">
                      <CompetencyTable aggregates={competencyAggregates} />
                    </TabsContent>

                    <TabsContent value="assessment">
                      {studyGuideId && offeringId && (
                        /* Report and Groups are sub-tabs sharing ONE panel
                           instance (a nested Tabs whose triggers flip `view`,
                           not two TabsContent). Both halves live on the same
                           cached analysis row, and the shared instance is what
                           keeps a Groups save's in-flight guard blocking
                           Refresh after a flip to the report — two instances
                           would each hold their own state and let the two
                           writes race. It also preserves unsaved group edits
                           across a Report↔Groups flip. Since the panel is not
                           a Radix TabsContent, the aria wiring is explicit:
                           both triggers point at its id. */
                        <Tabs
                          value={analysisView}
                          onValueChange={(next) => setAnalysisView(next as AnalysisView)}
                          className="w-full"
                        >
                          <TabsList className="mb-3">
                            <TabsTrigger
                              value="assessment"
                              id="sg-results-tab-assessment"
                              aria-controls="sg-results-analysis-tabpanel"
                            >
                              Report
                            </TabsTrigger>
                            <TabsTrigger
                              value="groups"
                              id="sg-results-tab-groups"
                              aria-controls="sg-results-analysis-tabpanel"
                            >
                              Follow up
                            </TabsTrigger>
                          </TabsList>
                          <div
                            id="sg-results-analysis-tabpanel"
                            role="tabpanel"
                            tabIndex={0}
                            aria-labelledby={
                              analysisView === "groups"
                                ? "sg-results-tab-groups"
                                : "sg-results-tab-assessment"
                            }
                          >
                            <StudyGuideAnalysisPanel
                              studyGuideId={studyGuideId}
                              courseId={courseId}
                              offeringId={offeringId}
                              groupId={groupId === ALL_GROUPS ? null : groupId}
                              view={analysisView}
                              scopeLabel={scopeLabel}
                              pieceTitleByPosition={pieceTitleByPosition}
                              competencyTitleById={competencyTitles}
                              submissionCount={submissionCount}
                              guideTitle={studyGuideTitle}
                              roster={roster}
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

      {studyGuideId && offeringId && drillStudent && (
        <StudyGuideAnswerDrillDown
          open={!!drillStudent}
          onOpenChange={(next) => !next && setDrillStudent(null)}
          studyGuideId={studyGuideId}
          offeringId={offeringId}
          userId={drillStudent.userId}
          studentName={drillStudent.name}
          guideTitle={studyGuideTitle}
        />
      )}
    </>
  );
}

function StudentTable({
  rows,
  pieceCount,
  onDrill,
}: {
  rows: StudentRow[];
  pieceCount: number;
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
    <Table data-testid="sg-results-students">
      <TableHeader>
        <TableRow>
          <TableHead>Student</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="w-[120px]">Progress</TableHead>
          <TableHead className="w-[110px] text-right">Correct</TableHead>
          <TableHead className="w-[100px] text-right">Mean</TableHead>
          <TableHead className="w-[80px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.userId} data-testid={`sg-results-student-${row.userId}`}>
            <TableCell className="font-medium">{row.fullName}</TableCell>
            <TableCell>
              <Badge variant={statusVariant[row.status]}>{statusLabel[row.status]}</Badge>
            </TableCell>
            <TableCell className="tabular-nums text-muted-foreground">
              {row.piecesCompleted}/{pieceCount} pieces
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.answered - row.pendingReview === 0 ? "—" : `${row.correct}/${row.answered - row.pendingReview}`}
            </TableCell>
            <TableCell className={`text-right tabular-nums ${scoreClass(row.meanScore)}`}>
              {row.meanScore === null ? "—" : `${row.meanScore}%`}
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

function PieceList({
  aggregates,
  questionsByPiece,
}: {
  aggregates: PieceAggregate[];
  questionsByPiece: Map<string, QuestionAggregate[]>;
}) {
  if (aggregates.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        This study guide has no pieces.
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="sg-results-pieces">
      {aggregates.map((piece) => (
        <div key={piece.pieceId} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{piece.position + 1}</Badge>
            <span className="text-sm font-medium">{piece.title}</span>
            <span className="text-xs text-muted-foreground">
              {piece.completed} completed · {piece.respondents} answered
            </span>
            <span className={`ml-auto text-sm font-semibold ${scoreClass(piece.meanScore)}`}>
              {piece.meanScore === null ? "—" : `${piece.meanScore}%`}
            </span>
          </div>

          {piece.lowConfidence && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              Too few students have reached this piece to read anything into it yet.
            </p>
          )}

          {piece.hardestQuestions.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Hardest questions</p>
              {piece.hardestQuestions.map((q) => (
                <QuestionRow key={q.questionId} question={q} />
              ))}
            </div>
          )}

          {(questionsByPiece.get(piece.pieceId)?.length ?? 0) >
            piece.hardestQuestions.length && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                All {questionsByPiece.get(piece.pieceId)!.length} questions
              </summary>
              <div className="mt-1 space-y-1">
                {questionsByPiece
                  .get(piece.pieceId)!
                  .map((q) => <QuestionRow key={q.questionId} question={q} />)}
              </div>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function QuestionRow({ question }: { question: QuestionAggregate }) {
  // Over gradable answers only — pending open answers are awaiting review.
  const gradable = question.answered - question.pendingReview;
  const rate = gradable > 0 ? Math.round((question.correct / gradable) * 100) : null;
  return (
    <div className="rounded border bg-muted/30 px-2 py-1.5">
      <div className="flex items-start gap-2">
        <span
          className="flex-1 text-xs"
          dangerouslySetInnerHTML={{ __html: processLatexContent(plainStem(question.text)) }}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {question.answered === 0 ? "no answers" : gradable === 0 ? "pending review" : `${question.correct}/${gradable}`}
        </span>
        {rate !== null && (
          <span className={`shrink-0 text-xs font-medium tabular-nums ${scoreClass(rate)}`}>
            {rate}%
          </span>
        )}
      </div>
      {question.optionDistribution && question.answered > 0 && (
        <ul className="mt-1 space-y-0.5">
          {question.optionDistribution.map((opt, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className="flex-1 truncate"
                dangerouslySetInnerHTML={{ __html: processLatexContent(opt.option) }}
              />
              <span className="tabular-nums">{opt.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CompetencyTable({ aggregates }: { aggregates: CompetencyAggregate[] }) {
  if (aggregates.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        None of this guide's questions carry a competency, so there is nothing to roll up.
      </p>
    );
  }
  return (
    <TooltipProvider delayDuration={200}>
      <Table data-testid="sg-results-competencies">
        <TableHeader>
          <TableRow>
            <TableHead>Competency</TableHead>
            <TableHead className="w-[110px]">Mean</TableHead>
            <TableHead className="w-[120px] text-right">Correct</TableHead>
            <TableHead className="w-[120px] text-right">Students</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {aggregates.map((row) => (
            <TableRow key={row.competencyId}>
              <TableCell className="font-medium">
                <span className={row.unattributed ? "text-muted-foreground italic" : ""}>
                  {row.title}
                </span>
                {row.lowConfidence && row.answered > 0 && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertTriangle className="ml-1.5 inline h-3 w-3 cursor-help text-amber-600" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <span className="text-xs">
                        Only {row.respondents}{" "}
                        {row.respondents === 1 ? "student has" : "students have"} answered anything
                        here — a signal, not a conclusion.
                      </span>
                    </TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell className={`tabular-nums ${scoreClass(row.meanScore)}`}>
                {row.meanScore === null ? "—" : `${row.meanScore}%`}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.answered - row.pendingReview === 0 ? "—" : `${row.correct}/${row.answered - row.pendingReview}`}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {row.respondents}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
}

export default StudyGuideResultsDialog;
