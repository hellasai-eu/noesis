import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  ContentType,
  CourseClass,
  OfferingAssignment,
  AssignmentTarget,
  AssignSelection,
  OfferingGroup,
  OfferingSelection,
} from "@/types/content-assignments";
import { useFormatters } from "@/i18n/formatters";

/**
 * Where each content type's assignments live.
 *
 * This is a total `Record<ContentType, …>` rather than an if-chain on purpose
 * (#977): the previous chains ended in bare `return 'offering_chapter_flashcards'`
 * / `return 'chapter_id'` fallbacks, so adding a member to `ContentType` without
 * adding a branch silently wrote that type's assignments into the flashcards
 * table. With a total record, omitting an entry is a compile error.
 *
 * After #582 open + MCQ questions share `offering_questions`; fill_gaps (#604),
 * ordering (#606) and classification (#610) reuse it too — all five types live
 * in the unified `questions` table. Flashcards and cheatsheets are both keyed by
 * `chapter_id`.
 */
const ASSIGNMENT_TARGETS: Record<ContentType, { table: string; idColumn: string }> = {
  open_question:      { table: 'offering_questions',            idColumn: 'question_id' },
  mcq_question:       { table: 'offering_questions',            idColumn: 'question_id' },
  fill_gaps:          { table: 'offering_questions',            idColumn: 'question_id' },
  ordering:           { table: 'offering_questions',            idColumn: 'question_id' },
  classification:     { table: 'offering_questions',            idColumn: 'question_id' },
  study_session:      { table: 'offering_study_sessions',       idColumn: 'study_session_id' },
  chapter_flashcard:  { table: 'offering_chapter_flashcards',   idColumn: 'chapter_id' },
  chapter_cheatsheet: { table: 'offering_chapter_cheatsheets',  idColumn: 'chapter_id' },
  study_guide:        { table: 'offering_study_guides',         idColumn: 'study_guide_id' },
  quiz:               { table: 'offering_quizzes',              idColumn: 'quiz_id' },
};

export function getTableName(type: ContentType): string {
  return ASSIGNMENT_TARGETS[type].table;
}

export function getIdColumnName(type: ContentType): string {
  return ASSIGNMENT_TARGETS[type].idColumn;
}

function targetKey(t: { offering_id: string; group_id: string | null }): string {
  return `${t.offering_id}::${t.group_id ?? ''}`;
}

export function useContentAssignments(
  contentType: ContentType,
  contentIds: string[],
  classes: CourseClass[]
) {
  const { compareText } = useFormatters();
  const [assignments, setAssignments] = useState<Record<string, OfferingAssignment[]>>({});
  const [groupsByOffering, setGroupsByOffering] = useState<Record<string, OfferingGroup[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // A failed assignment fetch used to be indistinguishable from "assigned to
  // nobody": the error was logged and `assignments` stayed empty. Callers that
  // render an unassigned state need to be able to tell the two apart.
  const [error, setError] = useState<string | null>(null);

  const tableName = getTableName(contentType);
  const idColumn = getIdColumnName(contentType);
  const offeringIds = classes.map(c => c.offering_id);

  // The inputs change as the page fills in — an empty content-id list becomes a
  // populated one, classes arrive — so several fetches can be in flight at once
  // and they do not necessarily finish in order. Only the newest may write:
  // otherwise a slow earlier request lands after a newer one and overwrites it,
  // and a stale *failure* would leave a permanent error alert sitting on top of
  // assignments that actually loaded fine.
  const latestFetchId = useRef(0);

  const fetchAssignments = useCallback(async () => {
    const fetchId = ++latestFetchId.current;

    if (offeringIds.length === 0 || contentIds.length === 0) {
      setAssignments({});
      setError(null);
      // This invocation supersedes any request still in flight, whose `finally`
      // the id guard will now skip — so it owns clearing the spinner. Without
      // this the hook stays loading forever once the last content item is
      // deleted or an empty course is selected mid-fetch.
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase
        .from(tableName as any)
        .select(`${idColumn}, offering_id, published_at, group_id`)
        .in("offering_id", offeringIds)
        .in(idColumn, contentIds);

      if (error) throw error;

      const map: Record<string, OfferingAssignment[]> = {};
      (data || []).forEach((a: any) => {
        const contentId = a[idColumn];
        if (!map[contentId]) map[contentId] = [];
        map[contentId].push({
          offering_id: a.offering_id,
          published_at: a.published_at,
          group_id: a.group_id ?? null,
        });
      });
      if (fetchId !== latestFetchId.current) return;
      setAssignments(map);
      setError(null);
    } catch (err) {
      console.error("Error fetching assignments:", err);
      if (fetchId !== latestFetchId.current) return;
      // Supabase rejects with a PostgrestError, which is a plain object rather
      // than an Error, so `instanceof` alone would discard every real message.
      const message = (err as { message?: unknown } | null)?.message;
      setError(typeof message === "string" && message ? message : "Failed to load assignments");
    } finally {
      if (fetchId === latestFetchId.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, idColumn, contentIds.join(","), offeringIds.join(",")]);

  const fetchGroups = useCallback(async () => {
    if (offeringIds.length === 0) {
      setGroupsByOffering({});
      return;
    }
    try {
      const { data, error } = await supabase
        .from("offering_groups")
        .select("id, offering_id, name, description, is_individual, owner_user_id")
        .in("offering_id", offeringIds);
      if (error) throw error;

      const rows = (data || []) as Array<{
        id: string;
        offering_id: string;
        name: string;
        description: string | null;
        is_individual: boolean | null;
        owner_user_id: string | null;
      }>;

      // Resolve display names for individual groups via a single profiles lookup.
      const ownerIds = Array.from(
        new Set(
          rows
            .filter(g => g.is_individual && g.owner_user_id)
            .map(g => g.owner_user_id as string)
        )
      );
      const ownerLabelByUserId = new Map<string, string>();
      if (ownerIds.length > 0) {
        const { data: profiles, error: pErr } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", ownerIds);
        if (pErr) console.error("Error fetching profiles for individual groups:", pErr);
        for (const p of profiles || []) {
          const label =
            (p.full_name && p.full_name.trim()) ||
            (p.email && p.email.trim()) ||
            "Student";
          ownerLabelByUserId.set(p.user_id, label);
        }
      }

      const map: Record<string, OfferingGroup[]> = {};
      for (const g of rows) {
        if (!map[g.offering_id]) map[g.offering_id] = [];
        const isIndividual = !!g.is_individual;
        map[g.offering_id].push({
          id: g.id,
          offering_id: g.offering_id,
          name: g.name,
          description: g.description ?? null,
          is_individual: isIndividual,
          owner_label: isIndividual
            ? (g.owner_user_id ? ownerLabelByUserId.get(g.owner_user_id) ?? "Student" : "Student")
            : null,
        });
      }
      // Manual groups first (alphabetized by name), then individual groups
      // (alphabetized by owner_label), so the dialog can render two sub-lists
      // without re-sorting.
      for (const oid of Object.keys(map)) {
        map[oid].sort((a, b) => {
          if (!!a.is_individual !== !!b.is_individual) {
            return a.is_individual ? 1 : -1;
          }
          if (a.is_individual) {
            return compareText((a.owner_label ?? ""), b.owner_label ?? "");
          }
          return compareText(a.name, b.name);
        });
      }
      setGroupsByOffering(map);
    } catch (error) {
      console.error("Error fetching offering groups:", error);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offeringIds.join(",")]);

  useEffect(() => {
    fetchAssignments();
    fetchGroups();
  }, [fetchAssignments, fetchGroups]);

  const getAssignedOfferingIds = useCallback((contentId: string): string[] => {
    return (assignments[contentId] || [])
      .filter(a => a.published_at !== null && (a.group_id ?? null) === null)
      .map(a => a.offering_id);
  }, [assignments]);

  const getAssignedTargets = useCallback((contentId: string): AssignmentTarget[] => {
    return (assignments[contentId] || [])
      .filter(a => a.published_at !== null)
      .map(a => ({ offering_id: a.offering_id, group_id: a.group_id ?? null }));
  }, [assignments]);

  const isAssigned = useCallback((contentId: string): boolean => {
    return (assignments[contentId] || []).some(a => a.published_at !== null);
  }, [assignments]);

  function normalizeSelection(
    selection: AssignSelection | Set<string>
  ): Map<string, OfferingSelection> {
    if (selection instanceof Set) {
      const m = new Map<string, OfferingSelection>();
      for (const oid of selection) {
        m.set(oid, { wholeClass: true, groupIds: new Set() });
      }
      return m;
    }
    if (selection.kind === 'offerings') {
      const m = new Map<string, OfferingSelection>();
      for (const oid of selection.offeringIds) {
        m.set(oid, { wholeClass: true, groupIds: new Set() });
      }
      return m;
    }
    return new Map(selection.perOffering);
  }

  const saveAssignments = useCallback(async (
    targetContentIds: string[],
    selection: Set<string> | AssignSelection,
    isBulk: boolean
  ) => {
    if (targetContentIds.length === 0) {
      toast.error("No items selected");
      return;
    }

    const perOffering = normalizeSelection(selection);

    setSaving(true);
    try {
      for (const contentId of targetContentIds) {
        const current = (assignments[contentId] || []).map(a => ({
          offering_id: a.offering_id,
          group_id: a.group_id ?? null,
          published_at: a.published_at,
        }));
        const currentByKey = new Map<string, typeof current[number]>();
        current.forEach(t => currentByKey.set(targetKey(t), t));

        // Build the desired set of (offering_id, group_id) keys from the selection.
        const desired = new Set<string>();
        for (const oid of offeringIds) {
          const sel = perOffering.get(oid);
          if (!sel) continue;
          if (sel.wholeClass) desired.add(targetKey({ offering_id: oid, group_id: null }));
          for (const gid of sel.groupIds) desired.add(targetKey({ offering_id: oid, group_id: gid }));
        }

        // Inserts: desired but not currently published.
        for (const oid of offeringIds) {
          const sel = perOffering.get(oid);
          if (!sel) continue;
          const wantedTargets: AssignmentTarget[] = [];
          if (sel.wholeClass) wantedTargets.push({ offering_id: oid, group_id: null });
          for (const gid of sel.groupIds) wantedTargets.push({ offering_id: oid, group_id: gid });

          for (const t of wantedTargets) {
            // Any existing row wins — published OR draft. An unpublished row
            // is a draft another flow parked (quiz follow-up practice), and
            // the dialog never displayed it; letting the upsert land here
            // would stamp published_at onto it, publishing a possibly
            // still-generating draft past the tracking board's guard.
            const existing = currentByKey.get(targetKey(t));
            if (existing) continue;
            const row: Record<string, unknown> = {
              [idColumn]: contentId,
              offering_id: oid,
              published_at: new Date().toISOString(),
            };
            if (t.group_id) row.group_id = t.group_id;
            const { error } = await supabase
              .from(tableName as any)
              .upsert(row, { onConflict: `offering_id,${idColumn},group_id` });
            if (error) throw error;
          }
        }

        // Deletes (only when not bulk): currently in scope (same offering) but not in desired.
        if (!isBulk) {
          for (const t of current) {
            if (!offeringIds.includes(t.offering_id)) continue; // out-of-scope offering — leave untouched
            if (desired.has(targetKey(t))) continue;
            // The dialog edits the PUBLISHED set — that's what it seeds its
            // selection from — so an unpublished row it never displayed must
            // not be deleted for being unselected. Quiz follow-up practice
            // parks draft offering_quizzes rows (published_at null) for the
            // instructor to publish from the tracking board; a save here that
            // silently removed them would erase that pending work.
            if (t.published_at === null) continue;
            let q = supabase
              .from(tableName as any)
              .delete()
              .eq(idColumn, contentId)
              .eq("offering_id", t.offering_id);
            q = t.group_id === null ? q.is("group_id", null) : q.eq("group_id", t.group_id);
            const { error } = await q;
            if (error) throw error;
          }
        }
      }

      toast.success(isBulk ? `${targetContentIds.length} items assigned` : "Assignments updated");
      await fetchAssignments();
    } catch (error: any) {
      console.error("Error saving assignments:", error);
      toast.error(error.message || "Failed to save assignments");
    } finally {
      setSaving(false);
    }
  }, [assignments, offeringIds, tableName, idColumn, fetchAssignments]);

  return {
    assignments,
    groupsByOffering,
    loading,
    saving,
    error,
    getAssignedOfferingIds,
    getAssignedTargets,
    isAssigned,
    saveAssignments,
    refetch: fetchAssignments,
    refetchGroups: fetchGroups,
  };
}
