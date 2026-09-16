/**
 * The cached AI assessment for an assigned quiz, rendered inline inside the
 * quiz results dialog (mirroring `StudyGuideAnalysisPanel`).
 *
 * Deliberately NOT auto-generating. The old dialog version generated on first
 * open because it was only reachable for a closed quiz; this panel is part of
 * the always-available results view — an open quiz is live, and auto-generating
 * would bill a model call on every glance at partial data. The cached report is
 * rendered if one exists, and generating is always an explicit act.
 *
 * The report and the student groups live on the same `quiz_analyses` row
 * (scoped by offering AND group) and are regenerated together, but they sit on
 * different sub-tabs of the results dialog's Assessment tab — which renders ONE
 * instance of this panel across both sub-tabs and flips the `view` prop. The
 * hidden half stays mounted so unsaved group edits and the in-flight save
 * guard survive the flip.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Info, Loader2, RefreshCw, Sparkles, Target, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  FollowupPracticeDialog,
  type FollowupTarget,
  type FollowupWeakAreas,
} from "@/components/quiz/FollowupPracticeDialog";
import { AnalysisClustersSection } from "@/components/analysis/AnalysisClustersSection";
import type { AnalysisCluster } from "@/lib/analysis-clusters";

// Minimal roster shape needed to resolve student names client-side. Kept local
// so the panel doesn't couple to the results dialog's internal interface.
export interface AnalysisRosterEntry {
  userId: string;
  fullName: string;
}

interface Misconception {
  title: string;
  description: string;
  related_question_orders: number[];
}

interface KnowledgeGap {
  topic: string;
  description: string;
}

interface QuestionSignal {
  question_order: number;
  difficulty_signal: "easy" | "moderate" | "hard";
  note: string;
}

interface QuizReport {
  overall_understanding: string;
  common_misconceptions: Misconception[];
  knowledge_gaps: KnowledgeGap[];
  question_signals: QuestionSignal[];
  summary: string;
}

interface QuizAnalysis {
  report: QuizReport;
  clusters: AnalysisCluster[];
  submission_count: number;
  low_confidence: boolean;
  generated_at: string | null;
  model: string | null;
}

// Shape returned by the analyze-quiz edge function when it declines to analyze.
interface InsufficientResponse {
  analysis: null;
  insufficientData: true;
  submission_count: number;
  message: string;
}

interface QuizAnalysisPanelProps {
  quizId: string;
  /** The quiz's course — the follow-up question generator is scoped to it. */
  courseId: string;
  offeringId: string;
  groupId: string | null;
  /** Which half of the cached analysis is showing (see the header comment). */
  view?: "assessment" | "groups";
  /**
   * Human name for the cohort this report covers ("Whole class", or the
   * group). The cache is keyed by scope, so the panel must also SAY which
   * scope it is showing.
   */
  scopeLabel: string;
  /** Live submitter count from the raw data, for the staleness blurb. */
  submissionCount: number;
  quizTitle: string;
  roster: AnalysisRosterEntry[];
  /** Forwarded to the whole-class follow-up dialog; see its own prop doc. */
  onAssignmentsChanged?: () => void;
}

const difficultyStyles: Record<QuestionSignal["difficulty_signal"], string> = {
  easy: "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400",
  moderate: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  hard: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
};

/** Normalize whatever comes back (persisted row or function payload) into QuizAnalysis. */
function normalizeAnalysis(row: any): QuizAnalysis {
  const report = row?.report ?? {};
  return {
    report: {
      overall_understanding: report.overall_understanding ?? "",
      common_misconceptions: Array.isArray(report.common_misconceptions)
        ? report.common_misconceptions
        : [],
      knowledge_gaps: Array.isArray(report.knowledge_gaps) ? report.knowledge_gaps : [],
      question_signals: Array.isArray(report.question_signals) ? report.question_signals : [],
      summary: report.summary ?? "",
    },
    clusters: Array.isArray(row?.clusters)
      ? row.clusters.map((c: any) => ({
          label: c?.label ?? "Group",
          rationale: c?.rationale ?? "",
          summary: c?.summary ?? "",
          member_user_ids: Array.isArray(c?.member_user_ids)
            ? c.member_user_ids.filter((id: unknown): id is string => typeof id === "string")
            : [],
          // The created-group markers must survive normalization: dropping
          // them would let a reopened panel create the same group twice.
          ...(typeof c?.created_group_id === "string"
            ? {
                created_group_id: c.created_group_id,
                created_group_name:
                  typeof c?.created_group_name === "string" ? c.created_group_name : undefined,
              }
            : {}),
        }))
      : [],
    submission_count: typeof row?.submission_count === "number" ? row.submission_count : 0,
    low_confidence: !!row?.low_confidence,
    generated_at: row?.generated_at ?? null,
    model: row?.model ?? null,
  };
}

/** Pull the real error message out of a FunctionsHttpError's stashed Response. */
async function extractFunctionError(error: unknown, fallback: string): Promise<string> {
  let message = (error as { message?: string })?.message || fallback;
  const ctx = (error as { context?: { json?: () => Promise<unknown> } })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = (await ctx.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      /* body wasn't JSON — keep the default message */
    }
  }
  return message;
}

export function QuizAnalysisPanel({
  quizId,
  courseId,
  offeringId,
  groupId,
  view = "assessment",
  scopeLabel,
  submissionCount,
  quizTitle,
  roster,
  onAssignmentsChanged,
}: QuizAnalysisPanelProps) {
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [analysis, setAnalysis] = useState<QuizAnalysis | null>(null);
  // Set when there's no analysis to show (too few submissions, empty roster).
  const [insufficientMessage, setInsufficientMessage] = useState<string | null>(null);
  // Refresh confirmation — regenerating overwrites the stored clusters, so an
  // existing analysis (whose groups the instructor may have curated) is never
  // replaced without an explicit yes. A first Generate has nothing to lose
  // and runs directly.
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);
  // Follow-up practice: the chosen target (currently only the whole class).
  const [followupTarget, setFollowupTarget] = useState<FollowupTarget | null>(null);
  // True while the clusters section is saving or creating groups. Refresh
  // upserts the same row that section writes, so it must not race it.
  const [clustersWriting, setClustersWriting] = useState(false);

  // Incremented on each load/generate so a response from a superseded request
  // can't overwrite newer state.
  const requestGenRef = useRef(0);

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of roster) map.set(r.userId, r.fullName);
    return map;
  }, [roster]);

  const load = useCallback(async () => {
    const gen = ++requestGenRef.current;
    setLoading(true);
    try {
      // Scoped by group as well as offering: a cached report describes one
      // cohort, and showing a group's findings while the filter says "Whole
      // class" would misattribute them to the whole class.
      let query = supabase
        .from("quiz_analyses")
        .select("report, clusters, submission_count, low_confidence, generated_at, model")
        .eq("quiz_id", quizId)
        .eq("offering_id", offeringId);
      query = groupId ? query.eq("group_id", groupId) : query.is("group_id", null);

      const { data, error } = await query.maybeSingle();
      if (gen !== requestGenRef.current) return;
      if (error) throw error;
      setAnalysis(data ? normalizeAnalysis(data) : null);
      setInsufficientMessage(null);
    } catch (err) {
      if (gen !== requestGenRef.current) return;
      console.error("Failed to load quiz analysis:", err);
      toast.error((err as Error).message || "Failed to load quiz analysis");
    } finally {
      if (gen === requestGenRef.current) setLoading(false);
    }
    // `groupId` is a dependency, not just a query parameter: switching the
    // scope must re-read, or the panel keeps rendering the previous cohort's
    // report under the new filter.
  }, [quizId, offeringId, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    const gen = ++requestGenRef.current;
    setGenerating(true);
    setInsufficientMessage(null);
    try {
      const { data, error } = await supabase.functions.invoke<{
        analysis: any;
      } | InsufficientResponse>("analyze-quiz", {
        body: { quiz_id: quizId, offering_id: offeringId, group_id: groupId },
      });
      if (gen !== requestGenRef.current) return;
      if (error) throw error;
      const resp = data as any;
      if (!resp) throw new Error("Empty response from analyze-quiz");
      if (resp.insufficientData || resp.analysis === null) {
        setAnalysis(null);
        setInsufficientMessage(
          resp.message || "Not enough submissions yet to analyze this quiz.",
        );
        return;
      }
      setAnalysis(normalizeAnalysis(resp.analysis));
      setInsufficientMessage(null);
    } catch (error: any) {
      if (gen !== requestGenRef.current) return;
      console.error("analyze-quiz failed:", error);
      toast.error(await extractFunctionError(error, "Failed to analyze quiz"));
    } finally {
      if (gen === requestGenRef.current) setGenerating(false);
    }
  };

  // Weak-area chips surfaced in the follow-up dialog so the instructor sees
  // what the generated set will target.
  const weakAreas = useMemo<FollowupWeakAreas>(
    () => ({
      misconceptions: (analysis?.report.common_misconceptions ?? [])
        .map((m) => m.title)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
      gaps: (analysis?.report.knowledge_gaps ?? [])
        .map((g) => g.topic)
        .filter((t): t is string => typeof t === "string" && t.length > 0),
    }),
    [analysis],
  );

  const openWholeClassFollowup = () => {
    setFollowupTarget({
      kind: "whole_class",
      studentCount: analysis?.submission_count ?? 0,
    });
  };

  /**
   * Persist edited clusters back onto this scope's cached row. Scoped by
   * `group_id` exactly as the read is. `silent` writes the row without
   * updating panel state — the clusters section uses it to persist
   * created-group markers mid-edit, where a prop change would re-seed the
   * editor and wipe unsaved renames and moves.
   */
  const saveClusters = async (
    clusters: AnalysisCluster[],
    opts?: { silent?: boolean },
  ) => {
    let query = supabase
      .from("quiz_analyses")
      .update({ clusters, updated_at: new Date().toISOString() })
      .eq("quiz_id", quizId)
      .eq("offering_id", offeringId);
    query = groupId ? query.eq("group_id", groupId) : query.is("group_id", null);
    const { error } = await query;
    if (error) throw error;
    if (!opts?.silent) setAnalysis((prev) => (prev ? { ...prev, clusters } : prev));
  };

  const busy = loading || generating;
  const groupsView = view === "groups";

  return (
    <>
    <Card data-testid={groupsView ? "quiz-groups-panel" : "quiz-analysis-panel"}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {groupsView ? <UsersRound className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
            {groupsView ? "Student groups" : "Class assessment"}
            <Badge variant="outline" className="font-normal">
              {scopeLabel}
            </Badge>
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {analysis?.generated_at ? (
              <>
                Generated {formatDistanceToNow(new Date(analysis.generated_at), { addSuffix: true })}{" "}
                from {analysis.submission_count}{" "}
                {analysis.submission_count === 1 ? "submission" : "submissions"}
                {submissionCount > analysis.submission_count && (
                  <>
                    {" "}·{" "}
                    <span className="text-amber-600 dark:text-amber-400">
                      {submissionCount - analysis.submission_count} newer since
                    </span>
                  </>
                )}
              </>
            ) : groupsView ? (
              "AI-suggested groups of students who share a struggle, read from their answers."
            ) : (
              "An AI reading of how the class did on this quiz."
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (analysis ? setRegenConfirmOpen(true) : void generate())}
          disabled={busy || clustersWriting}
          data-testid="quiz-analysis-refresh"
        >
          {generating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {analysis ? "Refresh" : "Generate"}
        </Button>
      </CardHeader>
      <CardContent>
        {busy ? (
          <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <p className="text-sm">
              {generating ? "Analyzing submissions…" : "Loading analysis…"}
            </p>
          </div>
        ) : insufficientMessage ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Info className="h-5 w-5 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">{insufficientMessage}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              The statistics on the Students tab are live and do not wait for this.
            </p>
          </div>
        ) : !analysis ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="max-w-md text-sm text-muted-foreground">
              {groupsView
                ? "No student groups yet. Generate the class assessment to have students grouped by the struggle they share."
                : "No assessment yet. Generate one to get an AI reading of class understanding, common misconceptions and knowledge gaps."}
            </p>
          </div>
        ) : (
          <>
          {/* Both halves stay mounted whichever view is showing — the inactive
              one is only hidden. The panel is a single instance spanning the
              Report and Follow up sub-tabs, and keeping the clusters editor
              mounted is what preserves unsaved group edits (and the in-flight
              save guard on Refresh) across a sub-tab flip. */}
          <div className={groupsView ? "space-y-5" : "hidden"}>
            {analysis.low_confidence && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Low-confidence grouping — based on only {analysis.submission_count}{" "}
                  {analysis.submission_count === 1 ? "submission" : "submissions"}. Treat these
                  groups as tentative.
                </span>
              </div>
            )}

            <AnalysisClustersSection
              clusters={analysis.clusters}
              nameByUserId={nameByUserId}
              offeringId={offeringId}
              sourceTitle={quizTitle}
              onSave={saveClusters}
              onWritingChange={setClustersWriting}
              busy={busy}
              hideHeading
              followupQuestions={{ courseId, quizId }}
              description={
                <>
                  <p>
                    Students grouped by the struggle they share, read from their quiz answers.
                    Rename a group or move students between them, then:
                  </p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    <li>
                      <span className="font-medium text-foreground">Save groups</span> keeps
                      your edits on this analysis — no real student groups are created.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">Create student groups</span>{" "}
                      turns every group into a real student group you can assign work to.
                    </li>
                    <li>
                      Each group's{" "}
                      <span className="font-medium text-foreground">
                        Create AI Interactive Question
                      </span>{" "}
                      creates that one group, then generates a follow-up question aimed at its
                      struggle for you to review and assign.
                    </li>
                    <li>
                      <span className="font-medium text-foreground">
                        Follow-up quiz: whole class
                      </span>{" "}
                      skips the groups and generates a new practice quiz for the whole class,
                      targeting the weak areas this analysis found — it arrives as a draft you
                      review and publish.
                    </li>
                  </ul>
                </>
              }
              emptyMessage="No student groups for this quiz yet. Groups appear once submissions show a shared pattern to act on — refresh after more students submit."
              headerActions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openWholeClassFollowup}
                  disabled={busy}
                  title="Generates a new practice quiz for the whole class, targeting the weak areas this analysis found. It is created as a draft assignment you review and publish."
                  data-testid="followup-whole-class"
                >
                  <Target className="w-3.5 h-3.5 mr-1.5" />
                  Follow-up quiz: whole class
                </Button>
              }
            />
          </div>
          <div className={groupsView ? "hidden" : "space-y-5"}>
            {analysis.low_confidence && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Low-confidence analysis — based on only {analysis.submission_count}{" "}
                  {analysis.submission_count === 1 ? "submission" : "submissions"}. Treat these
                  findings as tentative.
                </span>
              </div>
            )}

            {analysis.report.overall_understanding && (
              <section>
                <h4 className="mb-1 text-sm font-semibold">Overall understanding</h4>
                <p className="text-sm text-muted-foreground">
                  {analysis.report.overall_understanding}
                </p>
              </section>
            )}

            {analysis.report.common_misconceptions.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold">Common misconceptions</h4>
                <ol className="space-y-2">
                  {analysis.report.common_misconceptions.map((m, i) => (
                    <li key={i} className="rounded-lg border p-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className="text-xs">
                          #{i + 1}
                        </Badge>
                        <span className="text-sm font-medium">{m.title}</span>
                        {m.related_question_orders?.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            Q{m.related_question_orders.join(", Q")}
                          </span>
                        )}
                      </div>
                      {m.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {analysis.report.knowledge_gaps.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold">Knowledge gaps</h4>
                <ul className="space-y-2">
                  {analysis.report.knowledge_gaps.map((g, i) => (
                    <li key={i} className="rounded-lg border p-3">
                      <p className="text-sm font-medium">{g.topic}</p>
                      {g.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{g.description}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {analysis.report.question_signals.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold">Per-question signal</h4>
                <ul className="space-y-1.5">
                  {analysis.report.question_signals.map((s, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 rounded-md border px-3 py-2"
                    >
                      <Badge variant="outline" className="text-xs shrink-0">
                        Q{s.question_order}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`text-xs shrink-0 ${difficultyStyles[s.difficulty_signal] ?? ""}`}
                      >
                        {s.difficulty_signal}
                      </Badge>
                      {s.note && (
                        <span className="text-xs text-muted-foreground">{s.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {analysis.report.summary && (
              <section className="rounded-lg border bg-muted/30 p-3">
                <h4 className="mb-1 text-sm font-semibold">Summary</h4>
                <p className="text-sm text-muted-foreground">{analysis.report.summary}</p>
              </section>
            )}
          </div>
          </>
        )}
      </CardContent>
    </Card>

    <AlertDialog open={regenConfirmOpen} onOpenChange={setRegenConfirmOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Refresh the analysis?</AlertDialogTitle>
          <AlertDialogDescription>
            This re-runs the AI analysis from the latest submissions and overwrites the stored
            report and student groups — discarding any unsaved edits and previously saved group
            changes. Groups already created as real student groups are unaffected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setRegenConfirmOpen(false);
              void generate();
            }}
          >
            Refresh
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <FollowupPracticeDialog
      open={followupTarget !== null}
      onOpenChange={(next) => {
        if (!next) setFollowupTarget(null);
      }}
      quizId={quizId}
      offeringId={offeringId}
      quizTitle={quizTitle}
      target={followupTarget}
      weakAreas={weakAreas}
      onAssignmentsChanged={onAssignmentsChanged}
    />
    </>
  );
}

export default QuizAnalysisPanel;
