/**
 * Study guides tab in Learning Design (#979).
 *
 * Lists the course's guides, launches generation, opens the piece editor, and
 * assigns finished guides to sections/groups/students through the same
 * `offering_*` machinery every other artifact uses.
 *
 * Generation is instructor-driven and step-by-step (#1004) — outline here,
 * then theory and questions per piece in the editor — so there is no job to
 * watch and no background state to poll. Every call is a request the
 * instructor makes and waits on, and its failure is a toast rather than a
 * silently failed row.
 *
 * There is no publish step. A guide is only ever visible to a student once it
 * is assigned to a section — both RLS visibility helpers key off
 * `offering_study_guides.published_at` and nothing else — so a separate
 * draft/ready flag gated nothing a student could observe and only stopped the
 * instructor assigning their own work. Assignment IS the publish action, and
 * the completeness warning that used to fire on publish now fires there.
 *
 * One guard the Publish button carried was real and is kept: a guide with no
 * pieces cannot be assigned, because the student would open it to an empty
 * shell. That is a property of the guide's content, not a workflow state.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  AlertCircle,
  BarChart2,
  BookText,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectFilter } from "@/components/question-bank/filters/MultiSelectFilter";
import { useFormatters } from "@/i18n/formatters";
import { buildCompactClassDisplayName } from "@/lib/greek-school";
import { fetchAuthorNames } from "@/lib/author-names";
import { isoToLocalInputs, localInputsToIso } from "@/lib/assign-due-dates";
import { useContentAssignments } from "@/hooks/useContentAssignments";
import { AssignedClassesBadges } from "@/components/AssignedClassesBadges";
import { ContentAssignDialog } from "@/components/ContentAssignDialog";
import type { AssignSelection, CourseClass } from "@/types/content-assignments";
import {
  CreateStudyGuideDialog,
  type CreateStudyGuideMaterial,
} from "@/components/study-guide/CreateStudyGuideDialog";
import { StudyGuidePieceEditor } from "@/components/study-guide/StudyGuidePieceEditor";
import { StudyGuideResultsDialog } from "@/components/study-guide/StudyGuideResultsDialog";
import {
  assignmentIsDone,
  disallowedNewTargets,
  guideIsAssignable,
  pieceIsStale,
} from "@/lib/study-guide";

interface StudyGuideRow {
  id: string;
  title: string;
  material_id: string | null;
  created_by: string | null;
  /** Resolved display name, or null when RLS hides the profile / no creator. */
  authorName: string | null;
  materialLabel: string;
  pieceCount: number;
  /** Pieces with no questions yet — warned about when the guide is assigned. */
  incompletePieces: number;
  /**
   * Pieces whose questions predate their current theory. Checking only that
   * question links EXIST would let a guide reach students with questions
   * written against text the instructor has since rewritten.
   */
  stalePieces: number;
}

/**
 * One offering_study_guides row, as the due-date / done features need it.
 * Fetched separately from `useContentAssignments` (whose select is shared by
 * every content type, most of which have no due_date or closed_at column).
 */
interface GuideAssignmentMeta {
  id: string;
  study_guide_id: string;
  offering_id: string;
  group_id: string | null;
  published_at: string | null;
  due_date: string | null;
  closed_at: string | null;
}


interface StudyGuideManagerProps {
  courseId: string;
  materials: CreateStudyGuideMaterial[];
  classes?: CourseClass[];
  /**
   * Open this guide's results dialog once the guides load — the instructor
   * home's "Analysis & Follow-up" deep link (?guide=<id>). Consumed once, so closing
   * the dialog doesn't reopen it.
   */
  initialResultsGuideId?: string | null;
  /**
   * Fired the moment the deep link above is consumed. The parent uses it to
   * strip `?guide=` from the URL — without that, leaving this tab and coming
   * back remounts the manager against the same param and the dialog pops
   * again on every return.
   */
  onInitialResultsConsumed?: () => void;
}

async function readInvokeError(error: unknown, fallback: string): Promise<string> {
  let message = (error as { message?: string })?.message ?? fallback;
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = await ctx.clone().json();
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON body — keep the generic message.
    }
  }
  return message;
}

/**
 * Flatten a dialog selection into the same (offering, group) target shape
 * `getAssignedTargets` returns, so the two can be compared.
 *
 * Mirrors `normalizeSelection` in useContentAssignments: a bare Set and the
 * `offerings` variant both mean whole-class, while `targets` carries an
 * explicit whole-class flag alongside any group ids.
 */
function selectionToTargets(
  selection: Set<string> | AssignSelection,
): Array<{ offering_id: string; group_id: string | null }> {
  const out: Array<{ offering_id: string; group_id: string | null }> = [];
  if (selection instanceof Set) {
    for (const oid of selection) out.push({ offering_id: oid, group_id: null });
    return out;
  }
  if (selection.kind === "offerings") {
    for (const oid of selection.offeringIds) out.push({ offering_id: oid, group_id: null });
    return out;
  }
  for (const [oid, sel] of selection.perOffering) {
    if (sel.wholeClass) out.push({ offering_id: oid, group_id: null });
    for (const gid of sel.groupIds) out.push({ offering_id: oid, group_id: gid });
  }
  return out;
}

export function StudyGuideManager({
  courseId,
  materials,
  classes = [],
  initialResultsGuideId = null,
  onInitialResultsConsumed,
}: StudyGuideManagerProps) {
  const [guides, setGuides] = useState<StudyGuideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editorGuideId, setEditorGuideId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StudyGuideRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignTargetId, setAssignTargetId] = useState<string | null>(null);
  // Due dates edited in the assign dialog, one per offering: two sections can
  // carry the same guide with different deadlines, so the dialog edits each
  // class's deadline next to that class rather than one value for all.
  const [dueByOffering, setDueByOffering] = useState<
    Record<string, { date: string; time: string }>
  >({});
  // offering_study_guides rows by guide id — due dates and closure state.
  const [assignMeta, setAssignMeta] = useState<Record<string, GuideAssignmentMeta[]>>({});
  const [doneBusyId, setDoneBusyId] = useState<string | null>(null);
  /**
   * The results dialog, plus which of its panels to open on. The AI class
   * assessment used to be reachable only by opening results and finding the
   * fourth tab; it is the one panel an instructor comes back for on its own,
   * so it gets its own row action and lands directly on that tab.
   */
  const [results, setResults] = useState<{
    guideId: string;
    tab: "students" | "assessment";
  } | null>(null);
  const [initialResultsConsumed, setInitialResultsConsumed] = useState(false);

  // A new deep-link id re-arms the preselect; an id the list doesn't (yet)
  // contain stays un-consumed, so a later successful load can still open it,
  // while a stale id simply never fires.
  useEffect(() => {
    setInitialResultsConsumed(false);
  }, [initialResultsGuideId]);

  useEffect(() => {
    if (initialResultsConsumed || !initialResultsGuideId || loading) return;
    if (!guides.some((g) => g.id === initialResultsGuideId)) return;
    setInitialResultsConsumed(true);
    setResults({ guideId: initialResultsGuideId, tab: "students" });
    // Tell the parent so it can drop `?guide=` from the URL — the local
    // consumed flag dies with this mount, and this tab unmounts on every
    // tab switch, so without the callback the dialog reopens each time the
    // instructor comes back to this tab.
    onInitialResultsConsumed?.();
  }, [initialResultsConsumed, initialResultsGuideId, loading, guides, onInitialResultsConsumed]);

  // Every guide is assignable — assignment is the only thing that puts one in
  // front of a student, so there is nothing to withhold it from.
  const assignableIds = useMemo(() => guides.map((g) => g.id), [guides]);
  const contentAssignments = useContentAssignments("study_guide", assignableIds, classes);

  const { compareText, formatDate, formatTime } = useFormatters();

  // "Not assigned" is a claim about the database, so only make it when the
  // assignment fetch has actually answered (the StudySessionManager rule). An
  // empty target list also means "still loading", "the query failed", or "this
  // course has no classes" — flagging a guide as needing assignment in any of
  // those states would push instructors to re-assign content that already went
  // out. While unknown, the status chips and the needs-assigning cue are
  // withheld and the status filter does not narrow.
  const assignmentStateKnown =
    classes.length > 0 && !contentAssignments.loading && !contentAssignments.error;

  // Question-bank-style filters (the AssessmentList pattern, #1316): toggleable
  // assigned/unassigned chips — both on by default — and an author multi-select.
  const GUIDE_STATUSES = ["assigned", "unassigned"] as const;
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    () => new Set(GUIDE_STATUSES),
  );
  const [selectedAuthors, setSelectedAuthors] = useState<Set<string>>(new Set());

  const statusOf = (guide: StudyGuideRow): (typeof GUIDE_STATUSES)[number] =>
    contentAssignments.isAssigned(guide.id) ? "assigned" : "unassigned";

  // Keyed by creator id rather than display name — two creators can share a
  // name (or both resolve to "Unknown") and must stay filterable apart.
  const authorOptions = useMemo(() => {
    const byId = new Map<string, { label: string; count: number }>();
    for (const g of guides) {
      if (!g.created_by) continue;
      const entry = byId.get(g.created_by);
      if (entry) entry.count += 1;
      else byId.set(g.created_by, { label: g.authorName ?? "Unknown", count: 1 });
    }
    return [...byId.entries()]
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => compareText(a.label, b.label));
  }, [guides, compareText]);

  // Not memoised: `isAssigned` reads the assignments hook, which has no stable
  // identity to depend on, and the list is small enough to filter per render.
  const statusCounts: Record<string, number> = { assigned: 0, unassigned: 0 };
  for (const g of guides) statusCounts[statusOf(g)] += 1;

  const visibleGuides = guides.filter((g) => {
    if (selectedAuthors.size > 0 && (!g.created_by || !selectedAuthors.has(g.created_by)))
      return false;
    // The status split only filters while it can be answered truthfully: with
    // no classes it is meaningless, and while loading/errored every guide
    // would read as unassigned. The chips are hidden in the same states.
    if (assignmentStateKnown && !selectedStatuses.has(statusOf(g))) return false;
    return true;
  });

  const hasActiveFilters =
    selectedAuthors.size > 0 || selectedStatuses.size < GUIDE_STATUSES.length;

  const toggleStatus = (status: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const clearFilters = () => {
    setSelectedStatuses(new Set(GUIDE_STATUSES));
    setSelectedAuthors(new Set());
  };

  const materialLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of materials) map.set(m.id, m.title?.trim() || m.file_name);
    return map;
  }, [materials]);

  /**
   * Counts a guide's incomplete and stale pieces straight from the database.
   *
   * Used both to populate the list and, critically, again at publish time.
   * Reading the cached row there would let an instructor save changed theory,
   * close the editor and publish before the refetch lands — publishing without
   * the warning that the questions predate the text students will read.
   */
  const loadCompleteness = useCallback(
    async (guideId: string): Promise<{ pieceCount: number; incomplete: number; stale: number }> => {
      const { data: pieces, error } = await supabase
        .from("study_guide_pieces")
        .select("id, theory_updated_at, questions_generated_at")
        .eq("study_guide_id", guideId);
      if (error) throw error;

      const rows = (pieces ?? []) as Array<{
        id: string;
        theory_updated_at: string | null;
        questions_generated_at: string | null;
      }>;
      if (rows.length === 0) return { pieceCount: 0, incomplete: 0, stale: 0 };

      const { data: links } = await supabase
        .from("study_guide_piece_questions")
        .select("piece_id")
        .in("piece_id", rows.map((r) => r.id));
      const withQuestions = new Set(
        (links ?? []).map((l) => (l as { piece_id: string }).piece_id),
      );

      let incomplete = 0;
      let stale = 0;
      for (const r of rows) {
        if (!withQuestions.has(r.id)) {
          incomplete++;
          continue;
        }
        if (pieceIsStale(r.questions_generated_at, r.theory_updated_at)) stale++;
      }
      return { pieceCount: rows.length, incomplete, stale };
    },
    [],
  );

  const fetchGuides = useCallback(async () => {
    try {
      const { data: guideRows, error: guideError } = await supabase
        .from("study_guides")
        .select("id, title, material_id, created_by")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });
      if (guideError) throw guideError;

      const authorNames = await fetchAuthorNames(
        (guideRows ?? []).map((g) => (g as { created_by?: string | null }).created_by),
      );

      const ids = (guideRows ?? []).map((g) => g.id);
      const pieceCounts = new Map<string, number>();
      const incomplete = new Map<string, number>();
      const stale = new Map<string, number>();

      // Deliberately NOT querying study_guide_answers to decide whether a guide
      // has submissions: RLS scopes that read to the offerings this instructor
      // manages, while deletion cascades across every offering. The count would
      // therefore under-report and the confirmation would lie. The authority is
      // `delete_study_guide`, which counts as definer and refuses.
      if (ids.length > 0) {
        const { data: pieces } = await supabase
          .from("study_guide_pieces")
          .select("id, study_guide_id, theory_updated_at, questions_generated_at")
          .in("study_guide_id", ids);
        const pieceRows = (pieces ?? []) as Array<{
          id: string;
          study_guide_id: string;
          theory_updated_at: string | null;
          questions_generated_at: string | null;
        }>;
        for (const p of pieceRows) {
          pieceCounts.set(p.study_guide_id, (pieceCounts.get(p.study_guide_id) ?? 0) + 1);
        }

        const pieceIds = pieceRows.map((p) => p.id);
        const withQuestions = new Set<string>();
        if (pieceIds.length > 0) {
          const { data: links } = await supabase
            .from("study_guide_piece_questions")
            .select("piece_id")
            .in("piece_id", pieceIds);
          for (const l of links ?? []) {
            withQuestions.add((l as { piece_id: string }).piece_id);
          }
        }
        for (const p of pieceRows) {
          if (!withQuestions.has(p.id)) {
            incomplete.set(p.study_guide_id, (incomplete.get(p.study_guide_id) ?? 0) + 1);
            continue;
          }
          if (pieceIsStale(p.questions_generated_at, p.theory_updated_at)) {
            stale.set(p.study_guide_id, (stale.get(p.study_guide_id) ?? 0) + 1);
          }
        }
      }

      setGuides(
        (guideRows ?? []).map((g) => {
          const createdBy = (g as { created_by?: string | null }).created_by ?? null;
          return {
            id: g.id,
            title: g.title,
            material_id: g.material_id,
            created_by: createdBy,
            authorName: createdBy ? authorNames[createdBy] ?? "Unknown" : null,
            materialLabel: g.material_id ? materialLabelById.get(g.material_id) ?? "—" : "—",
            pieceCount: pieceCounts.get(g.id) ?? 0,
            incompletePieces: incomplete.get(g.id) ?? 0,
            stalePieces: stale.get(g.id) ?? 0,
          };
        }),
      );
    } catch (err) {
      console.error("Failed to load study guides", err);
      toast.error("Could not load study guides");
    } finally {
      setLoading(false);
    }
  }, [courseId, materialLabelById]);

  useEffect(() => {
    void fetchGuides();
  }, [fetchGuides]);

  /**
   * Due dates and closure state per assignment row. Failure leaves the map
   * empty, which reads as "no due date, not done" — the affected column and
   * button simply don't decorate, nothing false is claimed.
   */
  const guideIdsKey = guides.map((g) => g.id).join(",");
  const fetchAssignmentMeta = useCallback(async () => {
    const ids = guideIdsKey ? guideIdsKey.split(",") : [];
    if (ids.length === 0) {
      setAssignMeta({});
      return;
    }
    const { data, error } = await supabase
      .from("offering_study_guides")
      .select("id, study_guide_id, offering_id, group_id, published_at, due_date, closed_at")
      .in("study_guide_id", ids);
    if (error) {
      console.error("Failed to load study guide assignment details", error);
      return;
    }
    const map: Record<string, GuideAssignmentMeta[]> = {};
    for (const row of (data ?? []) as GuideAssignmentMeta[]) {
      (map[row.study_guide_id] ??= []).push(row);
    }
    setAssignMeta(map);
  }, [guideIdsKey]);

  useEffect(() => {
    void fetchAssignmentMeta();
  }, [fetchAssignmentMeta]);

  const publishedMetaOf = (guideId: string): GuideAssignmentMeta[] =>
    (assignMeta[guideId] ?? []).filter((r) => r.published_at !== null);

  /** Done = every published assignment is done (marked, or past its due date). */
  const guideIsDone = (guideId: string): boolean => {
    const rows = publishedMetaOf(guideId);
    return rows.length > 0 && rows.every((r) => assignmentIsDone(r.closed_at, r.due_date));
  };

  /**
   * The Due column's view of a guide: one entry per section (offering) with a
   * published assignment. A section's due date is the earliest across its rows
   * (whole-class + groups), and it is "done" only when every one of its rows
   * is — mirroring `guideIsDone`, which is the same rule over all sections.
   */
  const sectionDuesOf = (
    guideId: string,
  ): Array<{ offeringId: string; label: string; due: string | null; done: boolean }> => {
    const byOffering = new Map<string, GuideAssignmentMeta[]>();
    for (const row of publishedMetaOf(guideId)) {
      const list = byOffering.get(row.offering_id);
      if (list) list.push(row);
      else byOffering.set(row.offering_id, [row]);
    }
    const out: Array<{ offeringId: string; label: string; due: string | null; done: boolean }> = [];
    for (const cls of classes) {
      const rows = byOffering.get(cls.offering_id);
      if (!rows) continue;
      const dues = rows.map((r) => r.due_date).filter((d): d is string => !!d).sort();
      out.push({
        offeringId: cls.offering_id,
        label: buildCompactClassDisplayName(cls),
        due: dues[0] ?? null,
        done: rows.every((r) => assignmentIsDone(r.closed_at, r.due_date)),
      });
    }
    return out;
  };

  /**
   * Mark every published assignment of the guide as done. Students keep the
   * content and their results but can no longer submit answers — the same
   * contract as closing a quiz assignment. Per-row RLS scopes the update to
   * the offerings this instructor manages.
   */
  async function markGuideDone(guide: StudyGuideRow) {
    setDoneBusyId(guide.id);
    try {
      const { error } = await supabase
        .from("offering_study_guides")
        .update({ closed_at: new Date().toISOString() })
        .eq("study_guide_id", guide.id)
        .not("published_at", "is", null)
        .is("closed_at", null);
      if (error) throw error;
      toast.success("Study guide marked as done — students can no longer submit answers.");
      await fetchAssignmentMeta();
    } catch (err) {
      console.error("Failed to mark study guide as done", err);
      toast.error("Could not mark this study guide as done");
    } finally {
      setDoneBusyId(null);
    }
  }

  /**
   * Reopen a done guide. Clearing `closed_at` is not always enough: a due
   * date that has already passed keeps the guide auto-done, so reopening
   * would visibly do nothing. Passed due dates are therefore cleared too
   * (and said so) — the instructor can set a fresh one from the assign dialog.
   */
  async function reopenGuide(guide: StudyGuideRow) {
    setDoneBusyId(guide.id);
    try {
      // Whether a stale deadline is about to be cleared — read before the
      // write, for the toast wording only. The clearing itself is the RPC's.
      const nowIso = new Date().toISOString();
      const hadPastDue = publishedMetaOf(guide.id).some(
        (r) => r.due_date && r.due_date < nowIso,
      );
      // Through the RPC so the whole reopen is ONE statement: every published
      // row's closure cleared, and each section's due date cleared only where
      // it has already passed (a deadline still ahead survives). Doing this
      // client-side would take two updates, and a partial commit between them
      // reopens some sections while others still read Done — the shape
      // #1350's review already rejected once.
      const { error } = await supabase.rpc("reopen_study_guide", {
        _study_guide_id: guide.id,
      });
      if (error) throw error;
      toast.success(
        hadPastDue
          ? "Study guide reopened — passed due dates were cleared."
          : "Study guide reopened.",
      );
    } catch (err) {
      console.error("Failed to reopen study guide", err);
      toast.error("Could not reopen this study guide");
    } finally {
      // Refetch on failure too: the write may have landed even when the
      // response didn't, and stale Done state here would invite a re-click.
      await fetchAssignmentMeta();
      setDoneBusyId(null);
    }
  }

  /**
   * Build the outline for a guide that has none — the recovery path for a
   * draft whose creation failed after the guide row was written. Rebuilding an
   * outline that already has pieces is no longer offered, so this only ever
   * fills an empty guide.
   */
  async function buildOutline(guide: StudyGuideRow) {
    setRegeneratingId(guide.id);
    try {
      const { data, error } = await supabase.functions.invoke(
        "generate-study-guide-outline",
        { body: { studyGuideId: guide.id } },
      );
      if (error) throw new Error(await readInvokeError(error, "Could not build the outline"));
      if (data?.error) throw new Error(data.error);
      const count = Array.isArray(data?.pieces) ? data.pieces.length : 0;
      toast.success(`Outline ready — ${count} piece${count === 1 ? "" : "s"}`);
      await fetchGuides();
    } catch (err) {
      console.error("Failed to build the outline", err);
      toast.error((err as Error).message || "Could not build the outline");
    } finally {
      setRegeneratingId(null);
    }
  }

  async function deleteGuide(guide: StudyGuideRow) {
    setDeletingId(guide.id);
    try {
      // Through the RPC so the submissions check sees every offering, not just
      // the ones this instructor can read.
      const { error } = await supabase.rpc("delete_study_guide", {
        _study_guide_id: guide.id,
      });
      if (error) throw error;
      toast.success("Study guide deleted");
      await fetchGuides();
    } catch (err) {
      console.error("Failed to delete study guide", err);
      toast.error((err as Error).message || "Could not delete this study guide");
    } finally {
      setDeletingId(null);
      setConfirmDelete(null);
    }
  }

  function handleOpenAssignDialog(guideId: string) {
    setAssignTargetId(guideId);
    // Prefill each class's inputs from what is already saved for that class
    // (earliest across its rows, should whole-class and group rows ever
    // disagree), so reopening the dialog edits the current deadlines instead
    // of silently clearing them.
    const earliestByOffering = new Map<string, string>();
    for (const row of assignMeta[guideId] ?? []) {
      if (!row.due_date) continue;
      const current = earliestByOffering.get(row.offering_id);
      if (!current || row.due_date < current) {
        earliestByOffering.set(row.offering_id, row.due_date);
      }
    }
    const next: Record<string, { date: string; time: string }> = {};
    for (const [offeringId, iso] of earliestByOffering) {
      next[offeringId] = isoToLocalInputs(iso);
    }
    setDueByOffering(next);
    setAssignDialogOpen(true);
  }

  /**
   * Assignment is what puts a guide in front of students, so it is where the
   * completeness warning belongs — it used to fire on publish (#1004), and
   * that was only ever a proxy for this moment.
   *
   * Incomplete pieces are now BLOCKED at the entry point (`guideIsAssignable`)
   * rather than warned about here — a student who reaches a piece with nothing
   * to answer cannot advance past it, so letting one out was never really a
   * judgement call.
   *
   * An ALREADY-assigned guide keeps its dialog reachable however incomplete it
   * has become, because the instructor must be able to retract it. That escape
   * hatch is not a licence to hand the guide to ANOTHER class, though, so while
   * it is incomplete a save here may only keep or drop targets it already had.
   * Additions are refused outright; pure removals go through, which is the
   * whole reason the dialog stays open.
   *
   * The completeness read happens BEFORE the write, and from the database
   * rather than the cached row: an edit made in the editor moments ago may not
   * have been refetched, and a check that silently misses is worse than none.
   */
  async function handleSaveAssign(selection: Set<string> | AssignSelection) {
    if (!assignTargetId) return;
    const targetId = assignTargetId;

    let fresh: { pieceCount: number; incomplete: number; stale: number };
    try {
      fresh = await loadCompleteness(targetId);
    } catch (err) {
      console.error("Failed to read guide completeness", err);
      toast.error("Could not check this guide before assigning it");
      return;
    }

    // Read the CURRENT assignments from the database, not the hook's cache.
    // "What this guide is already assigned to" is half the comparison below,
    // and the cache can be minutes old: one that has forgotten a target would
    // classify it as an ADDITION and refuse a save that only removes things,
    // while one that remembers a target another session has since dropped would
    // wave a genuine addition through.
    //
    // `contentAssignments.refetch()` is deliberately NOT used here. It returns
    // void and only sets state, so awaiting it cannot refresh the
    // `getAssignedTargets` closure this function already captured — it would
    // add a round-trip and change nothing.
    //
    // This narrows the window; it does not close it. Two sessions can still
    // interleave between this read and the write. Closing it properly means
    // enforcing the rule in the database — a trigger on offering_study_guides,
    // or routing the write through an RPC that re-checks — rather than in a
    // component; every assignment gate in the app is currently a UI affordance
    // of this kind. Tracked separately.
    let currentTargets: Array<{ offering_id: string; group_id: string | null }>;
    try {
      const { data, error } = await supabase
        .from("offering_study_guides")
        .select("offering_id, group_id")
        .eq("study_guide_id", targetId)
        .not("published_at", "is", null);
      if (error) throw error;
      currentTargets = (data ?? []).map((r) => ({
        offering_id: (r as { offering_id: string }).offering_id,
        group_id: (r as { group_id: string | null }).group_id ?? null,
      }));
    } catch (err) {
      console.error("Failed to read current assignments", err);
      toast.error("Could not check this guide's current assignments");
      return;
    }

    const additions = disallowedNewTargets(
      fresh.incomplete,
      currentTargets,
      selectionToTargets(selection),
    );
    if (additions.length > 0) {
      toast.error(
        `${fresh.incomplete} of ${fresh.pieceCount} pieces still have no questions — generate them before assigning this guide to anyone new. You can still remove existing assignments.`,
      );
      return;
    }

    await contentAssignments.saveAssignments([targetId], selection, false);

    // Due dates ride on the assignment rows, so they can only be written
    // after those exist. One value per SECTION: each selected offering's rows
    // (whole-class and group alike) get that offering's input, and an empty
    // input clears that section's deadline. Deselected offerings need no
    // write — their rows were just deleted. The updates are scoped by RLS to
    // the offerings this instructor manages.
    const selectedOfferingIds = [
      ...new Set(selectionToTargets(selection).map((t) => t.offering_id)),
    ];
    let dueWriteFailed = false;
    for (const offeringId of selectedOfferingIds) {
      const inputs = dueByOffering[offeringId];
      const dueIso = localInputsToIso(inputs?.date ?? "", inputs?.time ?? "");
      const { error: dueError } = await supabase
        .from("offering_study_guides")
        .update({ due_date: dueIso })
        .eq("study_guide_id", targetId)
        .eq("offering_id", offeringId);
      if (dueError) {
        console.error("Failed to save the due date", dueError);
        dueWriteFailed = true;
      }
    }
    if (dueWriteFailed) {
      toast.error("Assignments saved, but a due date could not be saved");
    }
    await fetchAssignmentMeta();
    setAssignDialogOpen(false);

    try {
      if (fresh.incomplete > 0) {
        toast.warning(
          `${fresh.incomplete} of ${fresh.pieceCount} pieces have no questions yet — students will reach them with nothing to answer.`,
        );
      }
      if (fresh.stale > 0) {
        toast.warning(
          `${fresh.stale} piece${fresh.stale === 1 ? "" : "s"} have questions written before the theory was last edited — they may test text students no longer read.`,
        );
      }
    } catch (err) {
      // The assignment already succeeded; a failed warning must not read as a
      // failed assignment.
      console.error("Could not check study guide completeness", err);
    }
  }

  const editorGuide = guides.find((g) => g.id === editorGuideId) ?? null;
  const resultsGuide = guides.find((g) => g.id === results?.guideId) ?? null;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BookText className="w-5 h-5" />
            Study Guides
            {guides.length > 0 && (
              <Badge variant="secondary">
                {hasActiveFilters ? `${visibleGuides.length} of ${guides.length}` : guides.length}
              </Badge>
            )}
          </CardTitle>
          <Button onClick={() => setCreateOpen(true)} data-testid="sg-new">
            <Plus className="w-4 h-4 mr-2" />
            New study guide
          </Button>
        </CardHeader>
        <CardContent>
          {/* The same wording StudySessionManager uses for this failure: the
              badges still render whatever the hook managed to load, so the
              honest claim is "incomplete", not "gone". */}
          {contentAssignments.error && (
            <Alert variant="destructive" className="mb-3" data-testid="sg-assignments-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Could not load which classes these guides are assigned to. The
                assignment badges below are incomplete.
              </AlertDescription>
            </Alert>
          )}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading study guides…
            </div>
          ) : guides.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6">
              No study guides yet. A study guide turns a textbook into an ordered path: each piece
              teaches one idea and then checks it.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {assignmentStateKnown && (
                  <>
                    {GUIDE_STATUSES.map((status) => {
                      const active = selectedStatuses.has(status);
                      return (
                        <button
                          key={status}
                          type="button"
                          onClick={() => toggleStatus(status)}
                          className={active ? "opacity-100" : "opacity-40 grayscale"}
                          data-testid={`sg-status-chip-${status}`}
                          aria-pressed={active}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            {status === "assigned" ? (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                              >
                                Assigned
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">
                                Unassigned
                              </Badge>
                            )}
                            <Badge variant="secondary" className="text-[10px]">
                              {statusCounts[status]}
                            </Badge>
                          </span>
                        </button>
                      );
                    })}
                  </>
                )}
                {authorOptions.length > 0 && (
                  <MultiSelectFilter
                    label="Author"
                    options={authorOptions}
                    selected={selectedAuthors}
                    onChange={setSelectedAuthors}
                    testId="sg-author-filter"
                  />
                )}
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="ml-auto text-xs"
                    data-testid="sg-clear-filters"
                  >
                    <X className="w-3 h-3 mr-1" />
                    Clear filters
                  </Button>
                )}
              </div>
              {visibleGuides.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No study guides match the current filters
                </p>
              ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  {/* The material title is the longest string in the row and
                      the least useful — bounded so it cannot push the action
                      lane narrow enough to wrap. */}
                  <TableHead className="max-w-[220px]">Material</TableHead>
                  <TableHead className="whitespace-nowrap">Pieces</TableHead>
                  {classes.length > 0 && <TableHead>Classes</TableHead>}
                  {classes.length > 0 && <TableHead className="whitespace-nowrap">Due</TableHead>}
                  <TableHead className="w-[208px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleGuides.map((guide) => (
                  <TableRow key={guide.id} data-testid={`sg-row-${guide.id}`}>
                    <TableCell className="font-medium">
                      {guide.title}
                      {guide.authorName && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {guide.authorName}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px] text-muted-foreground">
                      <span className="block truncate" title={guide.materialLabel}>
                        {guide.materialLabel}
                      </span>
                    </TableCell>
                    <TableCell>
                      {guide.pieceCount === 0 ? (
                        "—"
                      ) : (
                        <span className="whitespace-nowrap">
                          {guide.pieceCount - guide.incompletePieces}/{guide.pieceCount} complete
                          {guide.stalePieces > 0 && (
                            <span className="ml-1 text-destructive">
                              · {guide.stalePieces} stale
                            </span>
                          )}
                        </span>
                      )}
                    </TableCell>
                    {classes.length > 0 && (
                      <TableCell>
                        {/* A guide with no pieces cannot be handed out: the
                            student would open it to "This study guide has no
                            pieces yet". The old Publish button carried this
                            guard as `disabled={pieceCount === 0}`; dropping the
                            publish step must not drop the guard with it.

                            Still shows the badges when a pieceless guide DOES
                            have assignments — every piece deleted after it went
                            out — because the instructor has to be able to
                            reach the dialog to take it back. */}
                        {!guideIsAssignable(
                          guide.pieceCount,
                          contentAssignments.getAssignedTargets(guide.id).length > 0,
                          guide.incompletePieces,
                        ) ? (
                          <span
                            className="block max-w-[240px] text-xs text-muted-foreground"
                            title={
                              guide.pieceCount === 0
                                ? "Build the outline before assigning this guide"
                                : `${guide.incompletePieces} of ${guide.pieceCount} pieces still have no questions — generate them before assigning this guide.`
                            }
                            data-testid={`sg-assign-blocked-${guide.id}`}
                          >
                            {guide.pieceCount === 0
                              ? "This guide has no pieces yet — build the outline to complete it."
                              : "This guide is not complete — click edit to complete it."}
                          </span>
                        ) : assignmentStateKnown &&
                          contentAssignments.getAssignedTargets(guide.id).length === 0 ? (
                          /* Assignable but unassigned. Same quiet ghost Assign
                             affordance the cheat-sheet table uses, so both
                             tables read the same. Only when the assignment
                             state is actually KNOWN: while it is loading or
                             failed, an assigned guide would wear the link too,
                             and the badges branch below is the honest
                             fallback. */
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs text-muted-foreground h-auto py-1 px-2"
                            onClick={() => handleOpenAssignDialog(guide.id)}
                            title="This guide is complete but no section has it yet — click to assign it"
                            aria-label={`Assign ${guide.title}`}
                            data-testid={`sg-needs-assign-${guide.id}`}
                          >
                            <Users className="w-3 h-3 mr-1" />
                            Assign
                          </Button>
                        ) : (
                          <div className="flex items-center gap-1">
                            {/* An explicit assigned cue: the class badges say
                                WHERE, this says THAT — the green check is what
                                makes an assigned row scannable in a long list.
                                Only when the state is known; the fallback
                                badges during load/error must not claim it. */}
                            {assignmentStateKnown &&
                              contentAssignments.isAssigned(guide.id) && (
                                <span
                                  title={`Assigned to ${
                                    contentAssignments.getAssignedTargets(guide.id).length
                                  } target${
                                    contentAssignments.getAssignedTargets(guide.id).length === 1
                                      ? ""
                                      : "s"
                                  }`}
                                  data-testid={`sg-assigned-check-${guide.id}`}
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                </span>
                              )}
                            <AssignedClassesBadges
                              classes={classes}
                              assignedTargets={contentAssignments.getAssignedTargets(guide.id)}
                              groupsByOffering={contentAssignments.groupsByOffering}
                              onClickAssign={() => handleOpenAssignDialog(guide.id)}
                              showAddButton={false}
                              compact
                            />
                            {/* Explicit "more sections" affordance — the badges
                                open the same dialog but do not look clickable.
                                Withheld while incomplete: the gate would refuse
                                every addition, so offering one is a dead end
                                (removal stays reachable through the badges). */}
                            {assignmentStateKnown &&
                              guide.pieceCount > 0 &&
                              guide.incompletePieces === 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                onClick={() => handleOpenAssignDialog(guide.id)}
                                title="Assign to more sections"
                                aria-label={`Assign ${guide.title} to more sections`}
                                data-testid={`sg-assign-more-${guide.id}`}
                              >
                                <Plus className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        )}
                      </TableCell>
                    )}
                    {classes.length > 0 && (
                      <TableCell className="whitespace-nowrap">
                        {(() => {
                          const sections = sectionDuesOf(guide.id);
                          const done = guideIsDone(guide.id);
                          if (sections.length === 0) {
                            return <span className="text-sm text-muted-foreground">—</span>;
                          }
                          const doneBadge = done ? (
                            <Badge
                              variant="outline"
                              className="mr-1.5 border-border bg-muted text-muted-foreground"
                              data-testid={`sg-done-badge-${guide.id}`}
                            >
                              Done
                            </Badge>
                          ) : null;
                          const formatDue = (iso: string) =>
                            `${formatDate(iso)} ${formatTime(iso, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`;
                          // One compact value while every section agrees; the
                          // moment deadlines (or done-ness) diverge, a line per
                          // section says which class has which.
                          const uniform =
                            new Set(sections.map((s) => s.due ?? "")).size === 1 &&
                            (done || sections.every((s) => !s.done));
                          if (uniform) {
                            const due = sections[0].due;
                            if (due) {
                              return (
                                <>
                                  {doneBadge}
                                  <span
                                    className="text-sm text-muted-foreground"
                                    data-testid={`sg-due-${guide.id}`}
                                  >
                                    {formatDue(due)}
                                  </span>
                                </>
                              );
                            }
                            return (
                              done ? doneBadge : (
                                <span className="text-sm italic text-muted-foreground">
                                  No due date
                                </span>
                              )
                            );
                          }
                          return (
                            <div className="space-y-0.5">
                              {doneBadge}
                              {sections.map((s) => (
                                <div
                                  key={s.offeringId}
                                  className="text-xs text-muted-foreground"
                                  data-testid={`sg-due-${guide.id}-${s.offeringId}`}
                                >
                                  <span className="font-medium">{s.label}</span>
                                  {" · "}
                                  {s.due ? formatDue(s.due) : "no due date"}
                                  {s.done && !done && (
                                    <Badge
                                      variant="outline"
                                      className="ml-1 border-border bg-muted px-1 py-0 text-[10px] text-muted-foreground"
                                    >
                                      done
                                    </Badge>
                                  )}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </TableCell>
                    )}
                    <TableCell className="w-[208px]">
                      <div className="flex flex-nowrap items-center justify-end gap-0.5">
                        {/* Results only exist once the guide is out with a class
                            (#981) — offered on assigned guides only so the button
                            never opens on an empty view. */}
                        {contentAssignments.isAssigned(guide.id) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setResults({ guideId: guide.id, tab: "students" })}
                            title="See how the class is doing"
                            aria-label={`Results for ${guide.title}`}
                            data-testid={`sg-results-${guide.id}`}
                          >
                            <BarChart2 className="w-4 h-4" />
                          </Button>
                        )}
                        {/* Mark as done / reopen — only meaningful once the
                            guide is out with a class. Done guides stay
                            readable for students; only submitting is closed. */}
                        {publishedMetaOf(guide.id).length > 0 &&
                          (guideIsDone(guide.id) ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => reopenGuide(guide)}
                              disabled={doneBusyId === guide.id}
                              title="Reopen — let students submit again"
                              aria-label={`Reopen ${guide.title}`}
                              data-testid={`sg-reopen-${guide.id}`}
                            >
                              {doneBusyId === guide.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <RotateCcw className="w-4 h-4" />
                              )}
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => markGuideDone(guide)}
                              disabled={doneBusyId === guide.id}
                              title="Mark as done — students can no longer submit"
                              aria-label={`Mark ${guide.title} as done`}
                              data-testid={`sg-mark-done-${guide.id}`}
                            >
                              {doneBusyId === guide.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-4 h-4" />
                              )}
                            </Button>
                          ))}
                        {/* The AI class assessment reads the same answers, so it
                            is offered on the same condition as results. */}
                        {contentAssignments.isAssigned(guide.id) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setResults({ guideId: guide.id, tab: "assessment" })}
                            title="Read the AI class assessment"
                            aria-label={`Assessment for ${guide.title}`}
                            data-testid={`sg-assessment-${guide.id}`}
                          >
                            <Sparkles className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => setEditorGuideId(guide.id)}
                          disabled={guide.pieceCount === 0}
                          aria-label={`Edit ${guide.title}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        {/* Only ever a FIRST build: a guide that already has
                            pieces has no rebuild action, so the outline can no
                            longer be discarded from this row. */}
                        {guide.pieceCount === 0 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => buildOutline(guide)}
                            disabled={regeneratingId === guide.id}
                            title="Build the outline"
                            aria-label={`Build outline for ${guide.title}`}
                          >
                            {regeneratingId === guide.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RefreshCw className="w-4 h-4" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => setConfirmDelete(guide)}
                          disabled={deletingId === guide.id}
                          aria-label={`Delete ${guide.title}`}
                        >
                          <Trash2 className="w-4 h-4" />
                          </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateStudyGuideDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        courseId={courseId}
        materials={materials}
        onCreated={() => void fetchGuides()}
      />

      <StudyGuidePieceEditor
        open={!!editorGuideId}
        onOpenChange={(next) => !next && setEditorGuideId(null)}
        studyGuideId={editorGuideId}
        studyGuideTitle={editorGuide?.title ?? "Study guide"}
        onChanged={() => void fetchGuides()}
      />

      <StudyGuideResultsDialog
        open={!!results}
        onOpenChange={(next) => !next && setResults(null)}
        studyGuideId={results?.guideId ?? null}
        courseId={courseId}
        studyGuideTitle={resultsGuide?.title ?? "Study guide"}
        initialTab={results?.tab ?? "students"}
      />

      {classes.length > 0 && assignTargetId && (
        <ContentAssignDialog
          open={assignDialogOpen}
          onOpenChange={setAssignDialogOpen}
          classes={classes}
          currentAssignedTargets={contentAssignments.getAssignedTargets(assignTargetId)}
          groupsByOffering={contentAssignments.groupsByOffering}
          onSave={handleSaveAssign}
          saving={contentAssignments.saving}
          title="Assign study guide"
          description="Students work through the pieces in order. Choose which classes, groups or students get this guide."
          perOfferingControls={(cls, selected) =>
            selected ? (
              <div className="mt-3 ml-7 flex items-center gap-2">
                <Label
                  htmlFor={`sg-assign-due-date-${cls.offering_id}`}
                  className="whitespace-nowrap text-xs text-muted-foreground"
                >
                  Due
                </Label>
                <Input
                  id={`sg-assign-due-date-${cls.offering_id}`}
                  type="date"
                  className="h-8"
                  value={dueByOffering[cls.offering_id]?.date ?? ""}
                  onChange={(e) =>
                    setDueByOffering((prev) => ({
                      ...prev,
                      [cls.offering_id]: {
                        date: e.target.value,
                        time: prev[cls.offering_id]?.time ?? "",
                      },
                    }))
                  }
                  data-testid={`sg-assign-due-date-${cls.offering_id}`}
                />
                <Input
                  type="time"
                  className="h-8"
                  value={dueByOffering[cls.offering_id]?.time ?? ""}
                  onChange={(e) =>
                    setDueByOffering((prev) => ({
                      ...prev,
                      [cls.offering_id]: {
                        date: prev[cls.offering_id]?.date ?? "",
                        time: e.target.value,
                      },
                    }))
                  }
                  aria-label={`Due time for ${cls.name}`}
                  data-testid={`sg-assign-due-time-${cls.offering_id}`}
                />
              </div>
            ) : null
          }
          extraControls={
            <p className="pt-2 text-xs text-muted-foreground">
              Due dates are optional and per class, so two sections can have
              different deadlines. When a class's deadline passes, its
              assignment is marked as done automatically.
            </p>
          }
        />
      )}

      <AlertDialog open={!!confirmDelete} onOpenChange={(next) => !next && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this study guide?</AlertDialogTitle>
            <AlertDialogDescription>
              Its pieces and generated questions are deleted with it, and this cannot be undone.
              If any student has submitted an answer — in any section, including ones you do not
              teach — the deletion is refused rather than destroying their work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDelete && deleteGuide(confirmDelete)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default StudyGuideManager;
