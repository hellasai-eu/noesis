import { formatDate } from "@/i18n/formatters";
import { guideIsAssignable } from "@/lib/study-guide";
import { ANALYTICS_PROMPT_MIN, COURSE_LINKS } from "./checklist";
import type { GuideSummary, QuizSummary } from "./types";

/**
 * What a home-page tile says and does, decided in one pure place so the
 * threshold and deep-link rules are unit-testable without rendering.
 *
 * The one rule worth naming: once enough students have finished
 * (ANALYTICS_PROMPT_MIN) — or, for guides, once every published assignment is
 * done — looking at the results becomes the tile's job: action and link
 * switch together, and a done guide additionally offers a follow-up.
 */
export interface TilePresentation {
  badge: { label: string; tone: "success" | "warning" | "neutral" };
  actionLabel: string;
  /** Query string under /course/:courseId. */
  link: string;
  /** Optional second button — a Done guide also offers a follow-up. */
  secondaryAction?: { label: string; link: string };
  meta: string;
}

export function guideTilePresentation(guide: GuideSummary): TilePresentation {
  const assigned = guide.assignedCount > 0;
  // Done wins the badge outright: every published assignment is done (marked
  // by the instructor or past its due date), so "Assigned"/"completed" would
  // advertise work students can no longer be expected to do.
  const done = assigned && guide.doneAssignmentCount >= guide.assignedCount;
  // The manager's assignability rule, verbatim: a guide with no pieces or
  // with question-less pieces cannot be handed out, so prompting "Assign"
  // would deep-link into a blocked action. Suggest finishing it instead.
  // Once assigned, the escape hatch inside guideIsAssignable applies and the
  // tile stays on the assigned/analytics track.
  const incomplete = !guideIsAssignable(guide.pieceCount, assigned, guide.incompletePieceCount);
  const promptAnalytics = guide.studentsCompleted >= ANALYTICS_PROMPT_MIN;
  const classLine =
    guide.assignedClassNames.length > 0
      ? guide.assignedClassNames.join(" · ")
      : `Assigned to ${guide.assignedCount} ${guide.assignedCount === 1 ? "class" : "classes"}`;
  const dueLine =
    !done && guide.nextDueDate ? `Due ${formatDate(guide.nextDueDate)}` : null;

  return {
    badge: done
      ? { label: "Done", tone: "neutral" }
      : assigned
        ? // A live assignment always advertises its completion count — the
          // instructor's question about work that is out is "who has done it?".
          {
            label: `${guide.studentsCompleted} completed`,
            tone: guide.studentsCompleted > 0 ? "success" : "neutral",
          }
        : incomplete
          ? { label: "Incomplete", tone: "warning" }
          : { label: "Not assigned", tone: "warning" },
    // A done guide (marked done or past its due date) is all about the
    // results, however few students finished — analytics plus a follow-up.
    actionLabel:
      done || promptAnalytics
        ? "Analysis & Follow-up"
        : assigned
          ? "Inspect"
          : incomplete
            ? "Complete"
            : "Assign",
    link:
      done || promptAnalytics
        ? `${COURSE_LINKS.studyGuides}&guide=${guide.id}`
        : COURSE_LINKS.studyGuides,
    secondaryAction: done
      ? {
          label: "Create More Questions",
          link: `${COURSE_LINKS.practiceQuestions}&followupGuide=${guide.id}`,
        }
      : undefined,
    meta: assigned
      ? [classLine, ...(dueLine ? [dueLine] : [])].join(" · ")
      : incomplete
        ? guide.pieceCount === 0
          ? "No pieces yet — build the outline to finish it"
          : `${guide.incompletePieceCount} of ${guide.pieceCount} pieces have no questions yet`
        : guide.draftAssignmentCount > 0
          ? "Staged, not published yet"
          : "Students can't see this yet",
  };
}

/**
 * Shelf order on the instructor home: live assigned work first (that is what
 * the instructor is teaching right now), done work second (still inspectable,
 * no longer urgent), assignable drafts third, and incomplete guides — the
 * ones that cannot be assigned until they are finished — last. Ties keep the
 * loader's newest-first order — sort stability does the rest.
 */
export function guideShelfRank(guide: GuideSummary): number {
  if (guide.assignedCount === 0) {
    return guideIsAssignable(guide.pieceCount, false, guide.incompletePieceCount) ? 2 : 3;
  }
  return guide.doneAssignmentCount >= guide.assignedCount ? 1 : 0;
}

/** Same shelf order for quizzes: open → closed → never assigned. */
export function quizShelfRank(quiz: QuizSummary): number {
  if (quiz.openCount > 0) return 0;
  if (quiz.closedCount > 0) return 1;
  return 2;
}

export function quizTilePresentation(quiz: QuizSummary): TilePresentation {
  const live = quiz.openCount > 0;
  const promptAnalytics = quiz.studentsCompleted >= ANALYTICS_PROMPT_MIN;
  const questionLine = `${quiz.questionCount} ${quiz.questionCount === 1 ? "question" : "questions"}`;

  return {
    badge: promptAnalytics
      ? { label: `${quiz.studentsCompleted} completed`, tone: "success" }
      : live
        ? { label: "Open", tone: "success" }
        : quiz.closedCount > 0
          ? { label: "Closed", tone: "neutral" }
          : quiz.draftAssignmentCount > 0
            ? { label: "Draft assignment", tone: "neutral" }
            : { label: "Not assigned", tone: "warning" },
    actionLabel: promptAnalytics
      ? "See results"
      : live || quiz.closedCount > 0
        ? "Inspect"
        : "Assign",
    link: promptAnalytics ? `${COURSE_LINKS.quizzes}&quiz=${quiz.id}` : COURSE_LINKS.quizzes,
    meta: [
      questionLine,
      ...quiz.assignedClassNames,
      ...(quiz.studentsCompleted > 0 && !promptAnalytics
        ? [`${quiz.studentsCompleted} completed`]
        : []),
    ].join(" · "),
  };
}
