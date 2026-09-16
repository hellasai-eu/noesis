import type { SupabaseClient } from "@supabase/supabase-js";
import { assignmentIsDone } from "@/lib/study-guide";
import { buildClassDisplayName } from "@/lib/greek-school";

/**
 * Pure loaders for My Class → Class Performance (same shape as
 * `instructor-surface` / `student-surface`): all reads live here, the
 * components consume them through thin React Query hooks
 * (`useClassPerformanceSurface.ts`) and render whatever comes back.
 *
 * Both rosters answer the same question — "who has it, how far along is
 * it?" — so both rows share the published-target vocabulary: a target is
 * one published `offering_*` assignment row (drafts are invisible to
 * students and therefore not targets), and it is done when closed or past
 * due, mirroring the managers' state model. Items with no published target
 * are dropped entirely: this surface is about performance, and an
 * unassigned quiz or guide has none — the managers list those.
 */

/** One published assignment target of a quiz or guide. */
export interface PublishedTarget {
  /** "class" or "class — group". */
  label: string;
  /** The offering the assignment row targets, so rosters can filter by class. */
  offeringId: string;
  done: boolean;
}

export interface QuizPerformanceRow {
  id: string;
  title: string;
  questionCount: number;
  targets: PublishedTarget[];
}

export interface GuidePerformanceRow {
  id: string;
  title: string;
  targets: PublishedTarget[];
}

export async function loadQuizPerformance(
  supabase: SupabaseClient,
  courseId: string,
): Promise<QuizPerformanceRow[]> {
  const { data, error } = await supabase
    .from("quizzes")
    .select(`
      id, title, created_at,
      quiz_questions(count),
      offering_quizzes(
        offering_id, published_at, closed_at,
        offerings(classes(name, grade_level_id, section_name, category)),
        offering_groups(name)
      )
    `)
    .eq("course_id", courseId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[])
    .map((q) => ({
      id: q.id,
      title: q.title,
      questionCount: q.quiz_questions?.[0]?.count ?? 0,
      targets: (q.offering_quizzes ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((a: any) => a.published_at !== null)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((a: any) => {
          const cls = a.offerings?.classes
            ? buildClassDisplayName(a.offerings.classes)
            : "Unknown class";
          return {
            label: a.offering_groups?.name ? `${cls} — ${a.offering_groups.name}` : cls,
            offeringId: a.offering_id,
            // A quiz assignment has no due-date auto-close: done means closed.
            done: a.closed_at !== null,
          };
        }),
    }))
    .filter((row) => row.targets.length > 0);
}

export async function loadStudyGuidePerformance(
  supabase: SupabaseClient,
  courseId: string,
  /** offering id → class label, from the caller's already-loaded class list. */
  classLabelByOffering: Record<string, string>,
): Promise<GuidePerformanceRow[]> {
  const { data: guides, error } = await supabase
    .from("study_guides")
    .select("id, title")
    .eq("course_id", courseId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const ids = (guides ?? []).map((g) => g.id);
  let assignments: Array<{
    study_guide_id: string;
    offering_id: string;
    group_id: string | null;
    published_at: string | null;
    due_date: string | null;
    closed_at: string | null;
  }> = [];
  const groupNames = new Map<string, string>();
  if (ids.length > 0) {
    const { data: assignRows, error: assignError } = await supabase
      .from("offering_study_guides")
      .select("study_guide_id, offering_id, group_id, published_at, due_date, closed_at")
      .in("study_guide_id", ids);
    if (assignError) throw assignError;
    assignments = assignRows ?? [];

    const groupIds = [...new Set(assignments.map((a) => a.group_id).filter(Boolean))] as string[];
    if (groupIds.length > 0) {
      const { data: groups, error: groupError } = await supabase
        .from("offering_groups")
        .select("id, name")
        .in("id", groupIds);
      if (groupError) throw groupError;
      for (const g of groups ?? []) groupNames.set(g.id, g.name);
    }
  }

  const byGuide = new Map<string, PublishedTarget[]>();
  for (const a of assignments) {
    if (a.published_at === null) continue; // drafts are invisible to students
    const cls = classLabelByOffering[a.offering_id] ?? "Unknown class";
    const group = a.group_id ? groupNames.get(a.group_id) : null;
    const target: PublishedTarget = {
      label: group ? `${cls} — ${group}` : cls,
      offeringId: a.offering_id,
      // The manager's "done" rule per assignment: marked done, or past due.
      done: assignmentIsDone(a.closed_at, a.due_date),
    };
    const list = byGuide.get(a.study_guide_id);
    if (list) list.push(target);
    else byGuide.set(a.study_guide_id, [target]);
  }

  return (guides ?? [])
    .map((g) => ({
      id: g.id,
      title: g.title,
      targets: byGuide.get(g.id) ?? [],
    }))
    .filter((row) => row.targets.length > 0);
}
