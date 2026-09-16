/**
 * The cached AI class assessment for an assigned study guide (#981).
 *
 * Deliberately NOT auto-generating. `QuizAnalysisPanel` generates on first open
 * because a quiz is analyzed once, after it closes. A study guide is live —
 * students are still working through it — so an auto-generate on open would
 * bill a model call every time an instructor glanced at the results, and would
 * do it against whatever partial data existed at that moment. Here the cached
 * report is rendered if one exists, and generating is always an explicit act.
 *
 * The raw statistics next to this panel are live and unconditional; this is
 * the only part gated behind the submission floor.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Info, Loader2, RefreshCw, Sparkles, UsersRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  normalizeStudyGuideAnalysis,
  type AnalyticsStudent,
  type StudyGuideAnalysis,
  type StudyGuideFinding,
} from "@/lib/study-guide-analytics";
import { AnalysisClustersSection } from "@/components/analysis/AnalysisClustersSection";
import type { AnalysisCluster } from "@/lib/analysis-clusters";

interface Props {
  studyGuideId: string;
  /** The guide's course — the follow-up question generator is scoped to it. */
  courseId: string;
  offeringId: string;
  groupId: string | null;
  /**
   * Which half of the cached analysis is showing. The report and the student
   * groups live on the same `study_guide_analyses` row and are regenerated
   * together, but they sit on different sub-tabs of the results dialog's
   * Assessment tab — which renders ONE instance of this panel across both
   * sub-tabs and flips this prop. "assessment" (the default) shows the
   * narrative report; "groups" shows the editable student-groups section. The
   * hidden half stays mounted so unsaved group edits and the in-flight save
   * guard survive the flip.
   */
  view?: "assessment" | "groups";
  /**
   * Human name for the cohort this report covers ("Whole class", or the group).
   * Rendered next to the title: the cache is keyed by scope, so the panel must
   * also SAY which scope it is showing — otherwise a group's findings read as
   * the class's to anyone who did not notice the filter above.
   */
  scopeLabel: string;
  /** Piece position → title, for rendering the positions the report cites. */
  pieceTitleByPosition: Map<number, string>;
  /** Competency id → title, for the same reason. */
  competencyTitleById: Map<string, string>;
  /** Live count from the raw data, used only for the pre-generation blurb. */
  submissionCount: number;
  /** The guide's title. Names the groups the clusters are turned into. */
  guideTitle: string;
  /**
   * The cohort this report covers. Only used to put a name on each clustered
   * student: the analysis stores opaque user_ids, and resolving them to people
   * happens here, in the browser, exactly as it does for the quiz panel.
   */
  roster: AnalyticsStudent[];
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

export function StudyGuideAnalysisPanel({
  studyGuideId,
  courseId,
  offeringId,
  groupId,
  view = "assessment",
  scopeLabel,
  pieceTitleByPosition,
  competencyTitleById,
  submissionCount,
  guideTitle,
  roster,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [analysis, setAnalysis] = useState<StudyGuideAnalysis | null>(null);
  const [insufficientMessage, setInsufficientMessage] = useState<string | null>(null);
  // True while the clusters section is saving or creating groups. Refresh
  // upserts the same row that section writes, so it must not race it: a save
  // resolving after a refresh would put the pre-refresh clusters back.
  const [clustersWriting, setClustersWriting] = useState(false);

  // Incremented on each load/generate so a response from a superseded request
  // can't overwrite newer state.
  const requestGenRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++requestGenRef.current;
    setLoading(true);
    try {
      // Scoped by group as well as offering: a cached report describes one
      // cohort, and showing a group's findings while the filter says "Whole
      // class" would misattribute them to the whole class.
      let query = supabase
        .from("study_guide_analyses")
        .select("report, clusters, submission_count, low_confidence, generated_at, model")
        .eq("study_guide_id", studyGuideId)
        .eq("offering_id", offeringId);
      query = groupId ? query.eq("group_id", groupId) : query.is("group_id", null);

      const { data, error } = await query.maybeSingle();
      if (gen !== requestGenRef.current) return;
      if (error) throw error;
      setAnalysis(data ? normalizeStudyGuideAnalysis(data) : null);
      setInsufficientMessage(null);
    } catch (err) {
      if (gen !== requestGenRef.current) return;
      console.error("Failed to load the study guide assessment", err);
      toast.error((err as Error).message || "Could not load the assessment");
    } finally {
      if (gen === requestGenRef.current) setLoading(false);
    }
    // `groupId` is a dependency, not just a query parameter: switching the
    // scope must re-read, or the panel keeps rendering the previous cohort's
    // report under the new filter.
  }, [studyGuideId, offeringId, groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    const gen = ++requestGenRef.current;
    setGenerating(true);
    setInsufficientMessage(null);
    try {
      const { data, error } = await supabase.functions.invoke("analyze-study-guide", {
        body: {
          study_guide_id: studyGuideId,
          offering_id: offeringId,
          group_id: groupId,
        },
      });
      if (gen !== requestGenRef.current) return;
      if (error) throw error;
      const resp = data as {
        analysis?: unknown;
        insufficientData?: boolean;
        message?: string;
      } | null;
      if (!resp) throw new Error("Empty response from analyze-study-guide");
      if (resp.insufficientData || !resp.analysis) {
        setInsufficientMessage(
          resp.message || "Not enough submissions yet to assess this study guide.",
        );
        return;
      }
      setAnalysis(normalizeStudyGuideAnalysis(resp.analysis));
    } catch (err) {
      if (gen !== requestGenRef.current) return;
      console.error("analyze-study-guide failed:", err);
      toast.error(await extractFunctionError(err, "Failed to assess this study guide"));
    } finally {
      if (gen === requestGenRef.current) setGenerating(false);
    }
  };

  const nameByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of roster) map.set(s.userId, s.fullName);
    return map;
  }, [roster]);

  /**
   * Persist edited clusters back onto this scope's cached row.
   *
   * Scoped by `group_id` exactly as the read is: the cache holds one row per
   * cohort, and writing without the scope predicate would push a group's edited
   * grouping onto the whole class's report.
   *
   * `silent` writes the row without updating panel state. The clusters section
   * uses it to persist created-group markers mid-edit: pushing those clusters
   * back through the prop would re-seed the editor and wipe the instructor's
   * unsaved renames and moves.
   */
  const saveClusters = async (
    clusters: AnalysisCluster[],
    opts?: { silent?: boolean },
  ) => {
    let query = supabase
      .from("study_guide_analyses")
      .update({ clusters, updated_at: new Date().toISOString() })
      .eq("study_guide_id", studyGuideId)
      .eq("offering_id", offeringId);
    query = groupId ? query.eq("group_id", groupId) : query.is("group_id", null);
    const { error } = await query;
    if (error) throw error;
    if (!opts?.silent) setAnalysis((prev) => (prev ? { ...prev, clusters } : prev));
  };

  const lowConfidencePositions = new Set(analysis?.report.low_confidence_piece_positions ?? []);
  const lowConfidenceCompetencies = new Set(analysis?.report.low_confidence_competency_ids ?? []);

  const renderPieceRefs = (positions: number[]) =>
    positions
      .filter((p) => pieceTitleByPosition.has(p))
      .map((p) => (
        <Badge key={p} variant="outline" className="text-[10px] font-normal">
          {lowConfidencePositions.has(p) && <AlertTriangle className="mr-1 h-2.5 w-2.5" />}
          {p + 1}. {pieceTitleByPosition.get(p)}
        </Badge>
      ));

  const renderCompetencyRefs = (ids: string[]) =>
    ids
      .filter((id) => competencyTitleById.has(id))
      .map((id) => (
        <Badge key={id} variant="secondary" className="text-[10px] font-normal">
          {lowConfidenceCompetencies.has(id) && <AlertTriangle className="mr-1 h-2.5 w-2.5" />}
          {competencyTitleById.get(id)}
        </Badge>
      ));

  const busy = loading || generating;
  const groupsView = view === "groups";

  return (
    <Card data-testid={groupsView ? "sg-groups-panel" : "sg-analysis-panel"}>
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
              "An AI reading of where the class is strong and weak so far."
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={generate}
          disabled={busy || clustersWriting}
          data-testid="sg-analysis-refresh"
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
              {generating ? "Reading the submissions…" : "Loading the assessment…"}
            </p>
          </div>
        ) : insufficientMessage ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <Info className="h-5 w-5 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground">{insufficientMessage}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              The statistics above are live and do not wait for this.
            </p>
          </div>
        ) : !analysis ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="max-w-md text-sm text-muted-foreground">
              {groupsView
                ? "No student groups yet. Generate the class assessment to have students grouped by the struggle they share."
                : "No assessment yet. Generate one to get a reading of the class's strengths, weaknesses and common misconceptions so far."}
            </p>
          </div>
        ) : (
          <>
          {/* Both halves stay mounted whichever view is showing — the inactive
              one is only hidden. The panel is a single instance spanning the
              Report and Groups sub-tabs, and keeping the clusters editor
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
              sourceTitle={guideTitle}
              onSave={saveClusters}
              onWritingChange={setClustersWriting}
              busy={busy}
              hideHeading
              followupQuestions={{ courseId, studyGuideId }}
              description={
                <>
                  <p>
                    Students grouped by the struggle they share, read from their answers so
                    far. Rename a group or move students between them, then:
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
                      creates that one group, then generates a follow-up question from this
                      guide for you to review and assign.
                    </li>
                  </ul>
                </>
              }
              emptyMessage="No student groups yet. Groups appear once enough answers show a shared pattern to act on — refresh after more students have worked through the guide."
            />
          </div>
          <div className={groupsView ? "hidden" : "space-y-5"}>
            {analysis.low_confidence && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Low-confidence assessment — based on only {analysis.submission_count}{" "}
                  {analysis.submission_count === 1 ? "submission" : "submissions"}. Treat these
                  findings as tentative.
                </span>
              </div>
            )}

            {analysis.report.overall_narrative && (
              <section>
                <h4 className="mb-1 text-sm font-semibold">Where the class is</h4>
                <p className="text-sm text-muted-foreground">
                  {analysis.report.overall_narrative}
                </p>
              </section>
            )}

            <FindingList
              title="Strengths"
              findings={analysis.report.strengths}
              renderPieceRefs={renderPieceRefs}
              renderCompetencyRefs={renderCompetencyRefs}
              accent="border-emerald-500/40"
            />
            <FindingList
              title="Weaknesses"
              findings={analysis.report.weaknesses}
              renderPieceRefs={renderPieceRefs}
              renderCompetencyRefs={renderCompetencyRefs}
              accent="border-red-500/40"
            />

            {analysis.report.misconceptions.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold">Common misconceptions</h4>
                <ol className="space-y-2">
                  {analysis.report.misconceptions.map((m, i) => (
                    <li key={i} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="text-xs">
                          #{i + 1}
                        </Badge>
                        <span className="text-sm font-medium">{m.title}</span>
                        {renderPieceRefs(m.piece_positions ?? [])}
                      </div>
                      {m.description && (
                        <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>
                      )}
                      {m.evidence && (
                        <p className="mt-1.5 rounded bg-muted/50 p-2 text-xs text-muted-foreground">
                          <span className="font-medium">Evidence: </span>
                          {m.evidence}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {analysis.report.suggested_actions.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold">Suggested next steps</h4>
                <ol className="space-y-2">
                  {analysis.report.suggested_actions.map((a, i) => (
                    <li key={i} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{a.action}</span>
                        {renderPieceRefs(a.piece_positions ?? [])}
                      </div>
                      {a.rationale && (
                        <p className="mt-1 text-xs text-muted-foreground">{a.rationale}</p>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {analysis.report.summary && (
              <section className="rounded-lg bg-muted/40 p-3">
                <h4 className="mb-1 text-sm font-semibold">At a glance</h4>
                <p className="text-sm text-muted-foreground">{analysis.report.summary}</p>
              </section>
            )}
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FindingList({
  title,
  findings,
  renderPieceRefs,
  renderCompetencyRefs,
  accent,
}: {
  title: string;
  findings: StudyGuideFinding[];
  renderPieceRefs: (positions: number[]) => ReactNode;
  renderCompetencyRefs: (ids: string[]) => ReactNode;
  accent: string;
}) {
  if (findings.length === 0) return null;
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      <ol className="space-y-2">
        {findings.map((f, i) => (
          <li key={i} className={`rounded-lg border border-l-2 ${accent} p-3`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{f.topic}</span>
              {renderPieceRefs(f.piece_positions ?? [])}
              {renderCompetencyRefs(f.competency_ids ?? [])}
            </div>
            {f.description && (
              <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default StudyGuideAnalysisPanel;
