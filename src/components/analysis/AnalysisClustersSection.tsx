/**
 * The editable "Student groups" section shared by the quiz-analysis panel and
 * the study-guide assessment panel.
 *
 * Both surfaces read the same cluster shape out of their own `*_analyses` row
 * and offer the same two actions on it, so the section owns the editing state
 * and both writes:
 *
 *   Save groups   — persist the edited labels and membership back into the
 *                   analysis row. Cheap, reversible, and does not leave the
 *                   analysis.
 *   Create student groups — write real `offering_groups` + members, named
 *                   with the source's "follow ups" postfix. This is the
 *                   irreversible one: the groups outlive the analysis and
 *                   show up wherever groups are listed, so it confirms first.
 *
 * With `followupQuestions` set (both the study-guide and quiz surfaces), the
 * section additionally offers a per-group "Create AI Interactive Question"
 * button: it creates THAT group alone, then generates a follow-up Socratic
 * question from the source material aimed at the group's struggle, and asks
 * the instructor to confirm-and-assign it.
 *
 * Student names are resolved here from the roster the caller already holds.
 * They never went to the model and they do not go back to it — the analysis
 * stores opaque user_ids, and the mapping to a person happens in the browser.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Save, Sparkles, Users, UsersRound } from "lucide-react";
import {
  createGroupsFromClusters,
  followupGroupName,
  type AnalysisCluster,
} from "@/lib/analysis-clusters";
import {
  ClusterFollowupQuestionsDialog,
  type FollowupQuestionItem,
} from "@/components/analysis/ClusterFollowupQuestionsDialog";

/** Reserved selector value for the Unassigned pseudo-cluster. */
const UNASSIGNED_KEY = "__unassigned__";

interface Props {
  /** Clusters as persisted; edits are local until Save or Create. */
  clusters: AnalysisCluster[];
  /** user_id → display name, for the rows. Missing ids render as "Unnamed". */
  nameByUserId: Map<string, string>;
  offeringId: string;
  /** Quiz or study-guide title. Drives the created groups' name postfix. */
  sourceTitle: string;
  /**
   * Persist the edited clusters back to the analysis row. `silent` asks the
   * host not to push the written clusters back through the `clusters` prop —
   * the section uses it for created-group marker bookkeeping mid-edit, where
   * a prop change would re-seed the editor and wipe unsaved edits.
   */
  onSave: (clusters: AnalysisCluster[], opts?: { silent?: boolean }) => Promise<void>;
  /** Shown in place of the list when there are no clusters at all. */
  emptyMessage: string;
  /** Optional blurb under the heading — typically a legend of the actions. */
  description?: ReactNode;
  /**
   * Suppress the section's own "Student groups" heading (the description and
   * actions stay). For hosts that already title the surface — the study-guide
   * Groups tab renders this inside a card whose header says the same thing.
   */
  hideHeading?: boolean;
  /** Extra buttons rendered beside Save (e.g. the quiz follow-up action). */
  headerActions?: ReactNode;
  /** True while the parent is loading/regenerating; disables every action. */
  busy?: boolean;
  /**
   * Reports whether a write is in flight. The section owns both writes, so a
   * parent that can be dismissed — the quiz panel is a dialog — needs this to
   * refuse the dismissal while one is running.
   */
  onWritingChange?: (writing: boolean) => void;
  /**
   * Enables the per-group "Create AI Interactive Question" follow-up action.
   * Needs a generation source — the study-guide surface passes the guide
   * (its theory is what the question is written from), the quiz surface
   * passes the quiz (the question is written from the chapters its questions
   * came from). Absent, the section only saves and creates groups.
   */
  followupQuestions?: { courseId: string; studyGuideId?: string; quizId?: string };
}

export function AnalysisClustersSection({
  clusters,
  nameByUserId,
  offeringId,
  sourceTitle,
  onSave,
  emptyMessage,
  description,
  hideHeading = false,
  headerActions,
  busy = false,
  onWritingChange,
  followupQuestions,
}: Props) {
  const [labels, setLabels] = useState<string[]>([]);
  /** user_id → cluster index as a string, or UNASSIGNED_KEY. */
  const [assignment, setAssignment] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmCreateOpen, setConfirmCreateOpen] = useState(false);
  /** Cluster index whose follow-up group creation is in flight, if any. */
  const [followupBusyIdx, setFollowupBusyIdx] = useState<number | null>(null);
  /**
   * Cluster index → the real offering group already created from it. Seeded
   * from the clusters' persisted `created_group_id` markers and extended after
   * every create here, so no path — the per-group follow-up or Create Groups
   * Only, in this session or a later one — creates the same group twice: the
   * follow-up reuses the recorded group, and the bulk create skips it.
   */
  const [createdByIdx, setCreatedByIdx] = useState<Record<number, { id: string; name: string }>>({});
  /** The just-created group awaiting its question, driving the dialog. */
  const [followupItems, setFollowupItems] = useState<FollowupQuestionItem[]>([]);
  const [followupOpen, setFollowupOpen] = useState(false);

  // Re-seed whenever the persisted clusters change — a Regenerate replaces
  // them wholesale, and keeping the old edit state would show labels and
  // memberships that no longer belong to any cluster.
  useEffect(() => {
    setLabels(clusters.map((c) => c.label));
    const next: Record<string, string> = {};
    clusters.forEach((c, idx) => {
      for (const uid of c.member_user_ids) next[uid] = String(idx);
    });
    setAssignment(next);
    // Which groups already exist comes back from the persisted markers, so a
    // save or reopen cannot forget a creation and allow a duplicate.
    const created: Record<number, { id: string; name: string }> = {};
    clusters.forEach((c, idx) => {
      if (c.created_group_id) {
        created[idx] = { id: c.created_group_id, name: c.created_group_name ?? c.label };
      }
    });
    setCreatedByIdx(created);
  }, [clusters]);

  useEffect(() => {
    onWritingChange?.(saving || creating || followupBusyIdx !== null);
  }, [saving, creating, followupBusyIdx, onWritingChange]);

  // Every student the analysis knows about, so one moved to Unassigned is
  // still tracked and can be moved back.
  const allMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of clusters) for (const uid of c.member_user_ids) ids.add(uid);
    return ids;
  }, [clusters]);

  /** Live (post-edit) membership per cluster index. */
  const liveClusters = useMemo(() => {
    const buckets: string[][] = clusters.map(() => []);
    for (const uid of allMemberIds) {
      const key = assignment[uid];
      const idx = key === undefined || key === UNASSIGNED_KEY ? -1 : Number(key);
      if (idx >= 0 && idx < buckets.length) buckets[idx].push(uid);
    }
    return buckets;
  }, [clusters, assignment, allMemberIds]);

  const liveUnassigned = useMemo(
    () => [...allMemberIds].filter((uid) => assignment[uid] === UNASSIGNED_KEY),
    [assignment, allMemberIds],
  );

  const renameCluster = (idx: number, value: string) =>
    setLabels((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });

  const moveStudent = (userId: string, nextKey: string) =>
    setAssignment((prev) => ({ ...prev, [userId]: nextKey }));

  /**
   * The clusters as currently edited, dropping the empty ones. Each entry
   * keeps its original cluster index so the confirm dialog's per-group opt-ins
   * (keyed by that index) can be matched to the groups creation writes.
   *
   * Returns null after reporting the problem, so both actions reject the same
   * inputs: a group nobody can identify, two groups with the same name, or
   * nothing left to act on.
   */
  const buildEditedClusters = (): { idx: number; cluster: AnalysisCluster }[] | null => {
    const trimmed = labels.map((l) => l.trim());
    const keptIdx = liveClusters
      .map((members, idx) => (members.length > 0 ? idx : -1))
      .filter((idx) => idx >= 0);

    if (keptIdx.length === 0) {
      toast.error("At least one group must have students");
      return null;
    }
    if (keptIdx.some((idx) => trimmed[idx].length === 0)) {
      toast.error("Every group with members needs a name");
      return null;
    }
    const keptNames = keptIdx.map((idx) => trimmed[idx]);
    if (new Set(keptNames).size !== keptNames.length) {
      toast.error("Group names must be unique");
      return null;
    }

    // Rationale and summary are the model's, not the instructor's — they are
    // carried across unchanged so an edited label never loses its evidence.
    // Created-group markers ride along too: a Save must not erase the record
    // of which clusters already became real groups.
    return keptIdx.map((idx) => ({
      idx,
      cluster: {
        label: trimmed[idx],
        rationale: clusters[idx]?.rationale ?? "",
        summary: clusters[idx]?.summary ?? "",
        member_user_ids: liveClusters[idx],
        ...(createdByIdx[idx]
          ? {
              created_group_id: createdByIdx[idx].id,
              created_group_name: createdByIdx[idx].name,
            }
          : {}),
      },
    }));
  };

  const handleSave = async () => {
    const edited = buildEditedClusters();
    if (!edited) return;
    setSaving(true);
    try {
      await onSave(edited.map((e) => e.cluster));
      toast.success("Groups saved");
    } catch (error) {
      console.error("Failed to save clusters:", error);
      toast.error((error as Error)?.message || "Failed to save groups");
    } finally {
      setSaving(false);
    }
  };

  /**
   * Record which clusters now have real groups, in the analysis row itself.
   * Written silently (no prop churn — see onSave) and best-effort: the groups
   * exist regardless, and failing the flow over bookkeeping would help no
   * one. If it does fail, duplicate protection degrades to this session's
   * state plus the insert's numeric-suffix behavior.
   */
  const persistCreatedMarkers = async (
    created: Record<number, { id: string; name: string }>,
  ) => {
    try {
      await onSave(
        clusters.map((c, idx) =>
          created[idx]
            ? {
                ...c,
                created_group_id: created[idx].id,
                created_group_name: created[idx].name,
              }
            : c,
        ),
        { silent: true },
      );
    } catch (error) {
      console.error("Failed to persist created-group markers:", error);
    }
  };

  const handleCreateGroups = async () => {
    const edited = buildEditedClusters();
    if (!edited) return;

    // Clusters that already became groups are skipped, not re-created — a
    // second write would only produce a numerically-suffixed duplicate.
    const notYetCreated = edited.filter(({ idx }) => !createdByIdx[idx]);
    if (notYetCreated.length === 0) {
      toast.error("All of these groups have already been created.");
      return;
    }

    // Reconcile against the CURRENT roster before writing. The clusters are a
    // cached reading that can predate an unenrolment, and
    // `offering_group_members` has an enrollment-integrity trigger: a single
    // departed student would reject that group's whole member insert, failing
    // the operation after other groups had already been created. Saving is
    // deliberately not filtered this way — the analysis is a record of who was
    // grouped at the time, and rewriting it here would erase that.
    const reconciled = notYetCreated
      .map(({ idx, cluster }) => ({
        idx,
        cluster: {
          ...cluster,
          member_user_ids: cluster.member_user_ids.filter((uid) => nameByUserId.has(uid)),
        },
      }))
      .filter(({ cluster }) => cluster.member_user_ids.length > 0);

    const droppedCount = notYetCreated.reduce((n, e) => n + e.cluster.member_user_ids.length, 0) -
      reconciled.reduce((n, e) => n + e.cluster.member_user_ids.length, 0);

    if (reconciled.length === 0) {
      toast.error("None of these students are still enrolled in this class.");
      return;
    }

    setCreating(true);
    try {
      const { groupIds, names } = await createGroupsFromClusters({
        offeringId,
        sourceTitle,
        clusters: reconciled.map((e) => e.cluster),
      });
      const created = `Created ${groupIds.length} student ${groupIds.length === 1 ? "group" : "groups"}`;
      // Say it plainly rather than silently creating a smaller group than the
      // one on screen.
      toast.success(
        droppedCount > 0
          ? `${created} — ${droppedCount} student${droppedCount === 1 ? " is" : "s are"} no longer enrolled and ${droppedCount === 1 ? "was" : "were"} left out`
          : created,
      );

      const nextCreated = { ...createdByIdx };
      reconciled.forEach((e, i) => {
        nextCreated[e.idx] = { id: groupIds[i], name: names[i] };
      });
      setCreatedByIdx(nextCreated);
      void persistCreatedMarkers(nextCreated);
    } catch (error) {
      console.error("Failed to create groups from clusters:", error);
      toast.error((error as Error)?.message || "Failed to create groups");
    } finally {
      setCreating(false);
    }
  };

  /**
   * The per-group follow-up: create THIS group for real, then generate an AI
   * interactive question for it and let the instructor confirm-and-assign.
   *
   * A cluster whose group already exists (this session's create, or a marker
   * persisted by an earlier one) reuses that group instead of creating a
   * duplicate — the question flow runs against the recorded group.
   *
   * Only this cluster is validated — the whole-section rules (unique names
   * across groups) belong to the create-all action, and a name collision here
   * is already resolved by the insert's numeric-suffix retry.
   */
  const handleCreateFollowupQuestion = async (idx: number) => {
    const label = (labels[idx] ?? "").trim() || clusters[idx]?.label?.trim() || "";
    const rationale = clusters[idx]?.rationale ?? "";
    const summary = clusters[idx]?.summary ?? "";

    const existing = createdByIdx[idx];
    if (existing) {
      setFollowupItems([
        { groupId: existing.id, groupName: existing.name, label, rationale, summary },
      ]);
      setFollowupOpen(true);
      return;
    }

    if (!label) {
      toast.error("Name the group before creating its follow-up question");
      return;
    }
    // Same roster reconciliation the create-all write performs — see
    // handleCreateGroups for why departed students must be filtered out.
    const memberIds = (liveClusters[idx] ?? []).filter((uid) => nameByUserId.has(uid));
    if (memberIds.length === 0) {
      toast.error("This group has no enrolled students");
      return;
    }
    const cluster: AnalysisCluster = {
      label,
      rationale,
      summary,
      member_user_ids: memberIds,
    };

    setFollowupBusyIdx(idx);
    try {
      const { groupIds, names } = await createGroupsFromClusters({
        offeringId,
        sourceTitle,
        clusters: [cluster],
      });
      toast.success(`Created student group "${names[0]}"`);
      const nextCreated = { ...createdByIdx, [idx]: { id: groupIds[0], name: names[0] } };
      setCreatedByIdx(nextCreated);
      void persistCreatedMarkers(nextCreated);
      setFollowupItems([
        {
          groupId: groupIds[0],
          groupName: names[0],
          label: cluster.label,
          rationale: cluster.rationale,
          summary: cluster.summary,
        },
      ]);
      setFollowupOpen(true);
    } catch (error) {
      console.error("Failed to create the follow-up group:", error);
      toast.error((error as Error)?.message || "Failed to create the group");
    } finally {
      setFollowupBusyIdx(null);
    }
  };

  const disabled = busy || saving || creating || followupBusyIdx !== null;
  const hasClusters = clusters.length > 0;

  // The names the confirm dialog previews — computed from the live edits, so
  // what the instructor is agreeing to is what gets written.
  const previewEntries = useMemo(() => {
    if (!confirmCreateOpen) return [] as { idx: number; name: string }[];
    return liveClusters
      // Same skip-list and roster reconciliation the write performs, so the
      // preview cannot promise a group that creation will then leave out —
      // neither one already created nor one that reconciles to empty.
      .map((members, idx) =>
        !createdByIdx[idx] && members.some((uid) => nameByUserId.has(uid)) ? idx : -1,
      )
      .filter((idx) => idx >= 0)
      .map((idx) => ({ idx, name: followupGroupName(labels[idx] ?? "", sourceTitle) }));
  }, [confirmCreateOpen, liveClusters, labels, sourceTitle, nameByUserId, createdByIdx]);

  return (
    <section className="space-y-3" data-testid="analysis-clusters">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {!hideHeading && <h4 className="text-sm font-semibold">Student groups</h4>}
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {headerActions}
          {hasClusters && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={disabled}
                title="Saves your renames and student moves to this analysis only — no real student groups are created."
              >
                {saving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                Save groups
              </Button>
              <Button
                size="sm"
                onClick={() => setConfirmCreateOpen(true)}
                disabled={disabled}
                title={
                  followupQuestions
                    ? "Creates every group below as a real student group you can assign work to. Generates no question — use a group's Create AI Interactive Question for that."
                    : "Creates every group below as a real student group you can assign work to."
                }
                data-testid="create-offering-groups"
              >
                {creating ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UsersRound className="mr-1.5 h-3.5 w-3.5" />
                )}
                Create student groups
              </Button>
            </>
          )}
        </div>
      </div>

      {!hasClusters ? (
        <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>
      ) : (
        <>
          {clusters.map((c, idx) => {
            const members = liveClusters[idx] ?? [];
            return (
              <div key={idx} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={labels[idx] ?? ""}
                    onChange={(e) => renameCluster(idx, e.target.value)}
                    className="min-w-[12rem] flex-1 font-medium"
                    disabled={disabled}
                    aria-label={`Group ${idx + 1} name`}
                  />
                  <Badge variant="secondary">
                    {members.length} {members.length === 1 ? "student" : "students"}
                  </Badge>
                  {followupQuestions && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => void handleCreateFollowupQuestion(idx)}
                      disabled={disabled}
                      title={
                        createdByIdx[idx]
                          ? `This group already exists as "${createdByIdx[idx].name}" — generates an AI interactive question targeting its struggle, which you review before it is assigned.`
                          : "As a follow up: saves this group as a real student group, then generates an AI interactive question targeting its struggle — you review it before it is assigned."
                      }
                      data-testid={`cluster-followup-button-${idx}`}
                    >
                      {followupBusyIdx === idx ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Create AI Interactive Question
                    </Button>
                  )}
                </div>
                {c.rationale && (
                  <p className="text-xs italic text-muted-foreground">{c.rationale}</p>
                )}
                {c.summary && <p className="text-xs text-muted-foreground">{c.summary}</p>}
                <div className="space-y-1">
                  {members.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      No students. Move some here from another group.
                    </p>
                  ) : (
                    members.map((uid) => (
                      <MemberRow
                        key={uid}
                        name={nameByUserId.get(uid) || "Unnamed"}
                        currentKey={String(idx)}
                        labels={labels}
                        disabled={disabled}
                        onChange={(v) => moveStudent(uid, v)}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}

          <div className="space-y-2 rounded-lg border border-dashed bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Unassigned</span>
              <Badge variant="outline">{liveUnassigned.length}</Badge>
            </div>
            <div className="space-y-1">
              {liveUnassigned.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">No unassigned students.</p>
              ) : (
                liveUnassigned.map((uid) => (
                  <MemberRow
                    key={uid}
                    name={nameByUserId.get(uid) || "Unnamed"}
                    currentKey={UNASSIGNED_KEY}
                    labels={labels}
                    disabled={disabled}
                    onChange={(v) => moveStudent(uid, v)}
                  />
                ))
              )}
            </div>
          </div>
        </>
      )}

      <AlertDialog open={confirmCreateOpen} onOpenChange={setConfirmCreateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create these as student groups?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Each group below is created in this class and can then be assigned content of
                  its own. Unassigned students are not included. Editing or removing a group
                  afterwards is done from Student Groups, not from here.
                </p>
                <ul className="space-y-1">
                  {previewEntries.map(({ idx, name }) => (
                    <li key={idx} className="rounded border bg-muted/40 px-2 py-1 text-xs">
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmCreateOpen(false);
                void handleCreateGroups();
              }}
            >
              Create student groups
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {followupQuestions && (
        <ClusterFollowupQuestionsDialog
          open={followupOpen}
          onOpenChange={setFollowupOpen}
          courseId={followupQuestions.courseId}
          studyGuideId={followupQuestions.studyGuideId}
          quizId={followupQuestions.quizId}
          offeringId={offeringId}
          items={followupItems}
        />
      )}
    </section>
  );
}

interface MemberRowProps {
  name: string;
  currentKey: string;
  labels: string[];
  disabled: boolean;
  onChange: (next: string) => void;
}

function MemberRow({ name, currentKey, labels, disabled, onChange }: MemberRowProps) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{name}</p>
      </div>
      <Select value={currentKey} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-7 w-[180px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {labels.map((label, i) => (
            <SelectItem key={i} value={String(i)} className="text-xs">
              {label.trim() || `Group ${i + 1}`}
            </SelectItem>
          ))}
          <SelectItem value={UNASSIGNED_KEY} className="text-xs">
            Unassigned
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export default AnalysisClustersSection;
