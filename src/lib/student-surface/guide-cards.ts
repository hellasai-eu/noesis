import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One assigned study guide, shaped for the course page's guide list. Unlike
 * `DueItem` this keeps the offering id — the player needs to know WHICH
 * assignment the student is working in, since progress is offering-scoped.
 */
export interface StudyGuideCard {
  studyGuideId: string;
  offeringId: string;
  title: string;
  pieceCount: number;
  completedCount: number;
  completedAt: string | null;
  dueDate: string | null;
  /** Set when the kept assignment is closed (see the dedupe rule below). */
  closedAt: string | null;
}

/**
 * The course page's study-guide cards (#980), as a pure loader so the course
 * and dashboard surfaces read assignments through the same layer.
 *
 * RLS enforces group scoping on `offering_study_guides`, so a plain select
 * returns only guides published to this student. A guide published to more
 * than one of the student's offerings is one card: keep the first offering as
 * the working one, except that an open assignment always beats a closed one —
 * one open route keeps the card actionable, matching the dashboard's loader.
 */
export async function loadStudyGuideCards(
  supabase: SupabaseClient,
  params: { userId: string; offeringIds: string[] },
): Promise<StudyGuideCard[]> {
  const { userId, offeringIds } = params;
  if (offeringIds.length === 0) return [];

  const { data: guideRows } = await supabase
    .from("offering_study_guides")
    .select(
      "study_guide_id, offering_id, due_date, closed_at, study_guides!inner(id, title)",
    )
    .in("offering_id", offeringIds)
    .not("published_at", "is", null);

  const byGuide = new Map<
    string,
    { offeringId: string; title: string; dueDate: string | null; closedAt: string | null }
  >();
  for (const row of guideRows || []) {
    const r = row as unknown as {
      study_guide_id: string;
      offering_id: string;
      due_date: string | null;
      closed_at: string | null;
      study_guides: { id: string; title: string };
    };
    const existing = byGuide.get(r.study_guide_id);
    if (existing && !(existing.closedAt && !r.closed_at)) continue;
    byGuide.set(r.study_guide_id, {
      offeringId: r.offering_id,
      title: r.study_guides.title,
      dueDate: r.due_date,
      closedAt: r.closed_at ?? null,
    });
  }

  const guideIds = Array.from(byGuide.keys());
  if (guideIds.length === 0) return [];

  const { data: pieceRows } = await supabase
    .from("study_guide_pieces")
    .select("study_guide_id")
    .in("study_guide_id", guideIds);
  const pieceCounts = new Map<string, number>();
  for (const p of pieceRows || []) {
    pieceCounts.set(p.study_guide_id, (pieceCounts.get(p.study_guide_id) || 0) + 1);
  }

  const { data: progressRows } = await supabase
    .from("study_guide_progress")
    .select("study_guide_id, offering_id, current_piece_position, completed_at")
    .eq("user_id", userId)
    .in("study_guide_id", guideIds);
  const progressByKey = new Map<string, { current: number; completedAt: string | null }>();
  for (const p of progressRows || []) {
    progressByKey.set(`${p.study_guide_id}::${p.offering_id}`, {
      current: p.current_piece_position ?? 0,
      completedAt: p.completed_at ?? null,
    });
  }

  return guideIds.map((gid) => {
    const info = byGuide.get(gid)!;
    const pieceCount = pieceCounts.get(gid) || 0;
    const progress = progressByKey.get(`${gid}::${info.offeringId}`);
    return {
      studyGuideId: gid,
      offeringId: info.offeringId,
      title: info.title,
      pieceCount,
      completedCount: Math.min(progress?.current ?? 0, pieceCount),
      completedAt: progress?.completedAt ?? null,
      dueDate: info.dueDate,
      closedAt: info.closedAt,
    };
  });
}
