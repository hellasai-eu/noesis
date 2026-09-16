import type { SupabaseClient } from "@supabase/supabase-js";
import type { DueItem, DueStatus, StudentScope } from "./types";

/**
 * Whether the student can no longer act on this item: a closed assignment, or
 * one that was never started and whose deadline has passed. (A started
 * attempt stays resumable past its deadline.) `DueTile` renders these locked;
 * the "n due" counts on the dashboard's course cards and the course launcher
 * skip them — everything must agree on the rule, so it lives here.
 * The rule is the same for quizzes and study guides now that
 * `offering_study_guides` carries `closed_at` too.
 */
export function isDeadDueItem(item: DueItem): boolean {
  if (item.status === "completed") return false;
  if (item.closedAt) return true;
  return (
    item.status === "not_started" &&
    !!item.dueDate &&
    new Date(item.dueDate).getTime() < Date.now()
  );
}

/**
 * Everything with a deadline attached, across every course.
 *
 * Two rules carried over from the pages this replaces, both load-bearing:
 *
 *  - a quiz reaches a student through `offering_quizzes`, never through
 *    `quizzes.is_published`. That flag is course-wide and says only that the
 *    quiz exists; the assignment row decides who was given it and from when.
 *    Reading the quizzes table instead credits a student with sets aimed at
 *    other students, which `StudentDashboard.quiz-gate.test.tsx` pins against.
 *  - a quiz met through two of the student's offerings is one quiz, not two.
 *    Collapse to the nearest due date.
 *
 * Status comes from `quiz_sessions` first — it is the source of truth — with
 * bare answers treated as in-progress so legacy rows are not lost.
 */
export async function loadDueItems(
  supabase: SupabaseClient,
  params: { userId: string; scope: StudentScope },
): Promise<DueItem[]> {
  const { userId, scope } = params;
  if (scope.offeringIds.length === 0) return [];

  const courseTitle = new Map(scope.courses.map((c) => [c.id, c.title]));
  const items: DueItem[] = [];

  const [quizItems, guideItems] = await Promise.all([
    loadQuizItems(supabase, userId, scope, courseTitle),
    loadGuideItems(supabase, userId, scope, courseTitle),
  ]);
  items.push(...quizItems, ...guideItems);

  // Nearest deadline first; undated work sorts after everything dated, since
  // "no deadline" is the weakest claim on a student's evening.
  return items.sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.title.localeCompare(b.title);
  });
}

async function loadQuizItems(
  supabase: SupabaseClient,
  userId: string,
  scope: StudentScope,
  courseTitle: Map<string, string>,
): Promise<DueItem[]> {
  const { data, error } = await supabase
    .from("offering_quizzes")
    .select(
      `id, offering_id, quiz_id, due_date, time_limit_override, published_at, closed_at,
       quizzes!inner(id, course_id, title, time_limit_minutes, quiz_questions(count))`,
    )
    .in("offering_id", scope.offeringIds)
    .not("published_at", "is", null);
  if (error) throw error;

  interface Row {
    id: string;
    offering_id: string;
    quiz_id: string;
    due_date: string | null;
    time_limit_override: number | null;
    closed_at: string | null;
    quizzes: {
      id: string;
      course_id: string;
      title: string;
      time_limit_minutes: number | null;
      quiz_questions: { count: number }[];
    } | null;
  }

  const byQuiz = new Map<string, DueItem>();
  for (const row of (data ?? []) as unknown as Row[]) {
    const quiz = row.quizzes;
    if (!quiz) continue;
    if (!courseTitle.has(quiz.course_id)) continue;

    const dueDate = row.due_date ?? null;
    const existing = byQuiz.get(quiz.id);
    if (existing) {
      // Same quiz, second offering: keep the deadline that lands first, and
      // stay closed only if every assignment of it is closed.
      if (dueDate && (!existing.dueDate || dueDate < existing.dueDate)) {
        existing.dueDate = dueDate;
      }
      if (!row.closed_at) existing.closedAt = null;
      continue;
    }

    byQuiz.set(quiz.id, {
      kind: "quiz",
      id: row.id,
      quizId: quiz.id,
      courseId: quiz.course_id,
      courseTitle: courseTitle.get(quiz.course_id) ?? "",
      title: quiz.title,
      dueDate,
      status: "not_started",
      questionCount: quiz.quiz_questions?.[0]?.count ?? 0,
      timeLimit: row.time_limit_override ?? quiz.time_limit_minutes ?? null,
      closedAt: row.closed_at ?? null,
    });
  }

  const quizIds = [...byQuiz.keys()];
  if (quizIds.length === 0) return [];

  const [{ data: sessions }, { data: answers }] = await Promise.all([
    supabase
      .from("quiz_sessions")
      .select("quiz_id, status")
      .eq("user_id", userId)
      .in("quiz_id", quizIds),
    supabase
      .from("quiz_answers")
      .select("quiz_id")
      .eq("user_id", userId)
      .in("quiz_id", quizIds),
  ]);

  // The schema allows more than one session per quiz; prefer the most advanced
  // so a finished attempt is never hidden behind a stale in-progress row.
  const rank = (s: string) =>
    s === "completed" ? 4 : s === "expired" ? 3 : s === "in_progress" ? 2 : 1;
  const sessionStatus = new Map<string, string>();
  for (const row of (sessions ?? []) as { quiz_id: string; status: string }[]) {
    const current = sessionStatus.get(row.quiz_id);
    if (!current || rank(row.status) > rank(current)) {
      sessionStatus.set(row.quiz_id, row.status);
    }
  }
  const answered = new Set(
    ((answers ?? []) as { quiz_id: string }[]).map((a) => a.quiz_id),
  );

  for (const [quizId, item] of byQuiz) {
    const status = sessionStatus.get(quizId);
    let resolved: DueStatus = "not_started";
    if (status === "completed" || status === "expired") resolved = "completed";
    else if (status === "in_progress" || (!status && answered.has(quizId))) {
      resolved = "in_progress";
    }
    item.status = resolved;
  }

  return [...byQuiz.values()];
}

async function loadGuideItems(
  supabase: SupabaseClient,
  userId: string,
  scope: StudentScope,
  courseTitle: Map<string, string>,
): Promise<DueItem[]> {
  const { data: guideRows, error } = await supabase
    .from("offering_study_guides")
    .select(
      "study_guide_id, offering_id, due_date, closed_at, study_guides!inner(id, title, course_id)",
    )
    .in("offering_id", scope.offeringIds)
    .not("published_at", "is", null);
  if (error) throw error;

  interface Row {
    study_guide_id: string;
    offering_id: string;
    due_date: string | null;
    closed_at: string | null;
    study_guides: { id: string; title: string; course_id: string } | null;
  }

  // A guide published to two of the student's offerings is one guide, but its
  // deadline AND its progress row are both scoped to an offering — so which
  // assignment we keep decides what the student is shown. Collect every
  // assignment first and choose once the progress rows are in: the offering
  // the student has actually worked in wins, and failing that the one that
  // falls due first. Keeping whichever row PostgREST happened to return first
  // (which is what the course page does) makes the tile unstable between loads.
  interface Assignment {
    offeringId: string;
    title: string;
    courseId: string;
    dueDate: string | null;
    closedAt: string | null;
  }
  const assignmentsByGuide = new Map<string, Assignment[]>();
  for (const row of (guideRows ?? []) as unknown as Row[]) {
    const guide = row.study_guides;
    if (!guide || !courseTitle.has(guide.course_id)) continue;
    const list = assignmentsByGuide.get(row.study_guide_id) ?? [];
    list.push({
      offeringId: row.offering_id,
      title: guide.title,
      courseId: guide.course_id,
      dueDate: row.due_date,
      closedAt: row.closed_at ?? null,
    });
    assignmentsByGuide.set(row.study_guide_id, list);
  }

  const guideIds = [...assignmentsByGuide.keys()];
  if (guideIds.length === 0) return [];

  const [{ data: pieces }, { data: progress }] = await Promise.all([
    supabase.from("study_guide_pieces").select("study_guide_id").in("study_guide_id", guideIds),
    supabase
      .from("study_guide_progress")
      .select("study_guide_id, offering_id, current_piece_position, completed_at")
      .eq("user_id", userId)
      .in("study_guide_id", guideIds),
  ]);

  const pieceCounts = new Map<string, number>();
  for (const p of (pieces ?? []) as { study_guide_id: string }[]) {
    pieceCounts.set(p.study_guide_id, (pieceCounts.get(p.study_guide_id) ?? 0) + 1);
  }
  const progressByKey = new Map<string, { current: number; completedAt: string | null }>();
  for (const p of (progress ?? []) as {
    study_guide_id: string;
    offering_id: string;
    current_piece_position: number | null;
    completed_at: string | null;
  }[]) {
    progressByKey.set(`${p.study_guide_id}::${p.offering_id}`, {
      current: p.current_piece_position ?? 0,
      completedAt: p.completed_at ?? null,
    });
  }

  /** Worked-in first, then finished, then most progress, then soonest due. */
  const pickAssignment = (guideId: string, candidates: Assignment[]): Assignment =>
    [...candidates].sort((a, b) => {
      const pa = progressByKey.get(`${guideId}::${a.offeringId}`);
      const pb = progressByKey.get(`${guideId}::${b.offeringId}`);
      if (!!pa !== !!pb) return pa ? -1 : 1;
      if (!!pa?.completedAt !== !!pb?.completedAt) return pa?.completedAt ? -1 : 1;
      if ((pa?.current ?? 0) !== (pb?.current ?? 0)) return (pb?.current ?? 0) - (pa?.current ?? 0);
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
        return a.dueDate.localeCompare(b.dueDate);
      }
      if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
      // Nothing to choose between them — order by id so the tile is at least
      // the same one on every load.
      return a.offeringId.localeCompare(b.offeringId);
    })[0];

  return guideIds.map((guideId) => {
    const candidates = assignmentsByGuide.get(guideId)!;
    const info = pickAssignment(guideId, candidates);
    const pieceCount = pieceCounts.get(guideId) ?? 0;
    const seen = progressByKey.get(`${guideId}::${info.offeringId}`);
    const completedCount = Math.min(seen?.current ?? 0, pieceCount);
    // Same rule as quizzes above: closed only when EVERY assignment of the
    // guide is closed — one open route keeps the tile actionable.
    const allClosed = candidates.every((c) => !!c.closedAt);
    return {
      kind: "guide" as const,
      id: guideId,
      studyGuideId: guideId,
      courseId: info.courseId,
      courseTitle: courseTitle.get(info.courseId) ?? "",
      title: info.title,
      dueDate: info.dueDate,
      closedAt: allClosed ? (info.closedAt ?? candidates[0].closedAt) : null,
      status: seen?.completedAt
        ? ("completed" as DueStatus)
        : completedCount > 0
          ? ("in_progress" as DueStatus)
          : ("not_started" as DueStatus),
      pieceCount,
      completedCount,
    };
  });
}
