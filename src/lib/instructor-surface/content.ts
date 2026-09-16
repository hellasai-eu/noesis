import type { SupabaseClient } from "@supabase/supabase-js";
import { assignmentIsDone } from "@/lib/study-guide";
import type { GuideSummary, InstructorContent, QuizSummary } from "./types";

/**
 * Everything the home page shows about existing content, in four flat reads.
 *
 * Assignment status comes from the join tables, split-queried by parent id
 * rather than embedded — `offering_*` rows are what "assigned" means here:
 * a `published_at` makes the work visible to students (StudyGuideManager
 * documents this: assignment IS publishing, there is no draft flag on the
 * guide itself). Quiz statuses mirror AssessmentList's model.
 */
export async function loadInstructorContent(
  supabase: SupabaseClient,
  params: {
    courseIds: string[];
    /** From the scope — resolves each assignment's offering to its class. */
    classNameByOffering?: Record<string, string>;
    classIdByOffering?: Record<string, string>;
  },
): Promise<InstructorContent> {
  const { courseIds, classNameByOffering = {}, classIdByOffering = {} } = params;
  if (courseIds.length === 0) {
    return {
      materialCountByCourse: {},
      competencyCountByCourse: {},
      guides: [],
      quizzes: [],
    };
  }

  const [materialsRes, competenciesRes, guidesRes, quizzesRes] = await Promise.all([
    supabase.from("course_materials").select("id, course_id").in("course_id", courseIds),
    supabase.from("course_competencies").select("id, course_id").in("course_id", courseIds),
    supabase
      .from("study_guides")
      .select("id, course_id, title, created_at")
      .in("course_id", courseIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("quizzes")
      .select("id, course_id, title, created_at, quiz_questions(count)")
      .in("course_id", courseIds)
      .order("created_at", { ascending: false }),
  ]);
  for (const res of [materialsRes, competenciesRes, guidesRes, quizzesRes]) {
    if (res.error) throw res.error;
  }

  const countByCourse = (rows: { course_id: string }[] | null) => {
    const counts: Record<string, number> = {};
    for (const row of rows ?? []) counts[row.course_id] = (counts[row.course_id] ?? 0) + 1;
    return counts;
  };

  const guideRows = guidesRes.data ?? [];
  const quizRows = (quizzesRes.data ?? []) as unknown as {
    id: string;
    course_id: string;
    title: string;
    created_at: string;
    quiz_questions: { count: number }[];
  }[];

  // Assignment rows are scoped to the instructor's active offerings in this
  // institution (the keys of the offering→class maps), exactly like the
  // completion reads below. Without the scope, a stale assignment on an
  // inactive offering keeps `assignedCount` positive, which both mislabels
  // the tile ("Assigned" for work no active class can see) and — via the
  // escape hatch in `guideIsAssignable` — hides the incomplete state from
  // the shelf while StudyGuideManager still blocks assignment.
  const offeringIds = Object.keys(classNameByOffering);
  const [guideAssignsRes, quizAssignsRes, guidePiecesRes] = await Promise.all([
    guideRows.length > 0 && offeringIds.length > 0
      ? supabase
          .from("offering_study_guides")
          .select("study_guide_id, offering_id, published_at, due_date, closed_at")
          .in("study_guide_id", guideRows.map((g) => g.id))
          .in("offering_id", offeringIds)
      : Promise.resolve({ data: [], error: null }),
    quizRows.length > 0 && offeringIds.length > 0
      ? supabase
          .from("offering_quizzes")
          .select("quiz_id, offering_id, published_at, closed_at")
          .in("quiz_id", quizRows.map((q) => q.id))
          .in("offering_id", offeringIds)
      : Promise.resolve({ data: [], error: null }),
    // Completeness, for the "finish this before assigning it" tile state. A
    // piece with zero question links is what StudyGuideManager counts as
    // incomplete; `guideIsAssignable` blocks assignment on the same numbers.
    guideRows.length > 0
      ? supabase
          .from("study_guide_pieces")
          .select("study_guide_id, study_guide_piece_questions(count)")
          .in("study_guide_id", guideRows.map((g) => g.id))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (guideAssignsRes.error) throw guideAssignsRes.error;
  if (quizAssignsRes.error) throw quizAssignsRes.error;
  if (guidePiecesRes.error) throw guidePiecesRes.error;

  const guidePieces: Record<string, { pieces: number; incomplete: number }> = {};
  for (const row of (guidePiecesRes.data ?? []) as unknown as {
    study_guide_id: string;
    study_guide_piece_questions: { count: number }[];
  }[]) {
    const entry = (guidePieces[row.study_guide_id] ??= { pieces: 0, incomplete: 0 });
    entry.pieces += 1;
    if ((row.study_guide_piece_questions?.[0]?.count ?? 0) === 0) entry.incomplete += 1;
  }

  // Completion, for the "see the analytics" prompt. `study_guide_progress`
  // is one row per (student, offering) with `completed_at` as the finish
  // line; quiz completion is a `quiz_sessions` row with status "completed".
  // Both are deduped by student so a guide assigned to two offerings the
  // same student sits in counts them once. Both are also scoped to the
  // instructor's active offerings (`offeringIds`, same scope as the
  // assignment reads above) — RLS alone would let completions from inactive
  // classes or other institutions inflate the badge. This deliberately
  // ignores legacy quiz_sessions rows with a NULL offering_id.
  const [guideProgressRes, quizSessionsRes] = await Promise.all([
    guideRows.length > 0 && offeringIds.length > 0
      ? supabase
          .from("study_guide_progress")
          .select("study_guide_id, user_id, completed_at")
          .in("study_guide_id", guideRows.map((g) => g.id))
          .in("offering_id", offeringIds)
          .not("completed_at", "is", null)
      : Promise.resolve({ data: [], error: null }),
    quizRows.length > 0 && offeringIds.length > 0
      ? supabase
          .from("quiz_sessions")
          .select("quiz_id, user_id")
          .in("quiz_id", quizRows.map((q) => q.id))
          .in("offering_id", offeringIds)
          .eq("status", "completed")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (guideProgressRes.error) throw guideProgressRes.error;
  if (quizSessionsRes.error) throw quizSessionsRes.error;

  const guideCompleters: Record<string, Set<string>> = {};
  for (const row of (guideProgressRes.data ?? []) as {
    study_guide_id: string;
    user_id: string;
  }[]) {
    (guideCompleters[row.study_guide_id] ??= new Set()).add(row.user_id);
  }
  const quizCompleters: Record<string, Set<string>> = {};
  for (const row of (quizSessionsRes.data ?? []) as { quiz_id: string; user_id: string }[]) {
    (quizCompleters[row.quiz_id] ??= new Set()).add(row.user_id);
  }

  const guideAssigns: Record<
    string,
    {
      assigned: number;
      done: number;
      nextDueDate: string | null;
      draft: number;
      classNames: string[];
      classIds: string[];
    }
  > = {};
  for (const row of (guideAssignsRes.data ?? []) as {
    study_guide_id: string;
    offering_id: string;
    published_at: string | null;
    due_date: string | null;
    closed_at: string | null;
  }[]) {
    const entry = (guideAssigns[row.study_guide_id] ??= {
      assigned: 0,
      done: 0,
      nextDueDate: null,
      draft: 0,
      classNames: [],
      classIds: [],
    });
    if (row.published_at) {
      entry.assigned += 1;
      if (assignmentIsDone(row.closed_at, row.due_date)) {
        entry.done += 1;
      } else if (
        row.due_date &&
        (!entry.nextDueDate || row.due_date < entry.nextDueDate)
      ) {
        entry.nextDueDate = row.due_date;
      }
      const name = classNameByOffering[row.offering_id];
      if (name && !entry.classNames.includes(name)) entry.classNames.push(name);
      const id = classIdByOffering[row.offering_id];
      if (id && !entry.classIds.includes(id)) entry.classIds.push(id);
    } else {
      entry.draft += 1;
    }
  }

  const quizAssigns: Record<
    string,
    { open: number; closed: number; draft: number; classNames: string[]; classIds: string[] }
  > = {};
  for (const row of (quizAssignsRes.data ?? []) as {
    quiz_id: string;
    offering_id: string;
    published_at: string | null;
    closed_at: string | null;
  }[]) {
    const entry = (quizAssigns[row.quiz_id] ??= {
      open: 0,
      closed: 0,
      draft: 0,
      classNames: [],
      classIds: [],
    });
    if (!row.published_at) {
      entry.draft += 1;
      continue;
    }
    if (row.closed_at) entry.closed += 1;
    else entry.open += 1;
    const name = classNameByOffering[row.offering_id];
    if (name && !entry.classNames.includes(name)) entry.classNames.push(name);
    const id = classIdByOffering[row.offering_id];
    if (id && !entry.classIds.includes(id)) entry.classIds.push(id);
  }

  const guides: GuideSummary[] = guideRows.map((g) => ({
    id: g.id,
    courseId: g.course_id,
    title: g.title,
    createdAt: g.created_at,
    assignedCount: guideAssigns[g.id]?.assigned ?? 0,
    doneAssignmentCount: guideAssigns[g.id]?.done ?? 0,
    nextDueDate: guideAssigns[g.id]?.nextDueDate ?? null,
    draftAssignmentCount: guideAssigns[g.id]?.draft ?? 0,
    pieceCount: guidePieces[g.id]?.pieces ?? 0,
    incompletePieceCount: guidePieces[g.id]?.incomplete ?? 0,
    assignedClassNames: (guideAssigns[g.id]?.classNames ?? []).sort(),
    assignedClassIds: guideAssigns[g.id]?.classIds ?? [],
    studentsCompleted: guideCompleters[g.id]?.size ?? 0,
  }));

  const quizzes: QuizSummary[] = quizRows.map((q) => ({
    id: q.id,
    courseId: q.course_id,
    title: q.title,
    createdAt: q.created_at,
    questionCount: q.quiz_questions?.[0]?.count ?? 0,
    openCount: quizAssigns[q.id]?.open ?? 0,
    closedCount: quizAssigns[q.id]?.closed ?? 0,
    draftAssignmentCount: quizAssigns[q.id]?.draft ?? 0,
    assignedClassNames: (quizAssigns[q.id]?.classNames ?? []).sort(),
    assignedClassIds: quizAssigns[q.id]?.classIds ?? [],
    studentsCompleted: quizCompleters[q.id]?.size ?? 0,
  }));

  return {
    materialCountByCourse: countByCourse(materialsRes.data),
    competencyCountByCourse: countByCourse(competenciesRes.data),
    guides,
    quizzes,
  };
}
