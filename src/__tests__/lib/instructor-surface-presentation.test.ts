import { describe, it, expect } from 'vitest';
import { formatDate } from '@/i18n/formatters';
import {
  guideShelfRank,
  guideTilePresentation,
  quizShelfRank,
  quizTilePresentation,
  ANALYTICS_PROMPT_MIN,
  COURSE_LINKS,
  type GuideSummary,
  type QuizSummary,
} from '@/lib/instructor-surface';

function guide(overrides: Partial<GuideSummary> = {}): GuideSummary {
  return {
    id: 'g1',
    courseId: 'course-1',
    title: 'Guide',
    createdAt: '2026-01-01',
    assignedCount: 0,
    doneAssignmentCount: 0,
    nextDueDate: null,
    draftAssignmentCount: 0,
    // Complete by default so every pre-existing case keeps its meaning.
    pieceCount: 5,
    incompletePieceCount: 0,
    assignedClassNames: [],
    assignedClassIds: [],
    studentsCompleted: 0,
    ...overrides,
  };
}

function quiz(overrides: Partial<QuizSummary> = {}): QuizSummary {
  return {
    id: 'q1',
    courseId: 'course-1',
    title: 'Quiz',
    createdAt: '2026-01-01',
    questionCount: 5,
    openCount: 0,
    closedCount: 0,
    draftAssignmentCount: 0,
    assignedClassNames: [],
    assignedClassIds: [],
    studentsCompleted: 0,
    ...overrides,
  };
}

describe('guideTilePresentation', () => {
  it('prompts an unassigned guide to be assigned', () => {
    const tile = guideTilePresentation(guide());
    expect(tile.actionLabel).toBe('Assign');
    expect(tile.badge).toEqual({ label: 'Not assigned', tone: 'warning' });
    expect(tile.link).toBe(COURSE_LINKS.studyGuides);
    expect(tile.meta).toBe("Students can't see this yet");
  });

  it('shows the assigned class names, not a count, once assigned', () => {
    const tile = guideTilePresentation(
      guide({ assignedCount: 2, assignedClassNames: ['Τμήμα 1Α', 'Τμήμα 1Β'] }),
    );
    expect(tile.meta).toBe('Τμήμα 1Α · Τμήμα 1Β');
    expect(tile.actionLabel).toBe('Inspect');
  });

  it('always badges a live assignment with its completion count, even at zero', () => {
    const tile = guideTilePresentation(guide({ assignedCount: 1 }));
    expect(tile.badge).toEqual({ label: '0 completed', tone: 'neutral' });
    expect(tile.secondaryAction).toBeUndefined();
  });

  it('falls back to a count when class names are unresolved', () => {
    const tile = guideTilePresentation(guide({ assignedCount: 1 }));
    expect(tile.meta).toBe('Assigned to 1 class');
  });

  it('keeps Inspect just below the analytics threshold, counting finishers in the badge', () => {
    const tile = guideTilePresentation(
      guide({
        assignedCount: 1,
        assignedClassNames: ['Τμήμα 1Α'],
        studentsCompleted: ANALYTICS_PROMPT_MIN - 1,
      }),
    );
    expect(tile.actionLabel).toBe('Inspect');
    expect(tile.badge).toEqual({
      label: `${ANALYTICS_PROMPT_MIN - 1} completed`,
      tone: 'success',
    });
    // The count lives in the badge — the meta doesn't repeat it.
    expect(tile.meta).toBe('Τμήμα 1Α');
    expect(tile.link).toBe(COURSE_LINKS.studyGuides);
  });

  it('switches action and deep link together at the threshold', () => {
    const tile = guideTilePresentation(
      guide({
        id: 'guide-42',
        assignedCount: 1,
        assignedClassNames: ['Τμήμα 1Α'],
        studentsCompleted: ANALYTICS_PROMPT_MIN,
      }),
    );
    expect(tile.actionLabel).toBe('Analysis & Follow-up');
    expect(tile.badge).toEqual({ label: `${ANALYTICS_PROMPT_MIN} completed`, tone: 'success' });
    expect(tile.link).toBe(`${COURSE_LINKS.studyGuides}&guide=guide-42`);
    expect(tile.meta).toBe('Τμήμα 1Α');
  });

  it('labels a draft-only assignment as staged', () => {
    const tile = guideTilePresentation(guide({ draftAssignmentCount: 1 }));
    expect(tile.meta).toBe('Staged, not published yet');
    expect(tile.actionLabel).toBe('Assign');
  });

  it('shows the upcoming due date in the meta while the guide is live', () => {
    const due = '2026-12-01T21:59:00.000Z';
    const tile = guideTilePresentation(
      guide({ assignedCount: 1, assignedClassNames: ['Τμήμα 1Α'], nextDueDate: due }),
    );
    expect(tile.meta).toBe(`Τμήμα 1Α · Due ${formatDate(due)}`);
  });

  it('offers analytics and a follow-up once every published assignment is done', () => {
    const tile = guideTilePresentation(
      guide({
        id: 'guide-5',
        assignedCount: 2,
        doneAssignmentCount: 2,
        assignedClassNames: ['Τμήμα 1Α'],
      }),
    );
    expect(tile.badge).toEqual({ label: 'Done', tone: 'neutral' });
    // Done means results time — analytics regardless of the completion
    // threshold, plus a follow-up seeded from the guide.
    expect(tile.actionLabel).toBe('Analysis & Follow-up');
    expect(tile.link).toBe(`${COURSE_LINKS.studyGuides}&guide=guide-5`);
    expect(tile.secondaryAction).toEqual({
      label: 'Create More Questions',
      link: `${COURSE_LINKS.practiceQuestions}&followupGuide=guide-5`,
    });
    // Done, so there is no upcoming deadline to advertise.
    expect(tile.meta).toBe('Τμήμα 1Α');
  });

  it('Done outranks the completed-count badge but keeps the analytics action', () => {
    const tile = guideTilePresentation(
      guide({
        id: 'guide-9',
        assignedCount: 1,
        doneAssignmentCount: 1,
        studentsCompleted: ANALYTICS_PROMPT_MIN,
      }),
    );
    expect(tile.badge).toEqual({ label: 'Done', tone: 'neutral' });
    expect(tile.actionLabel).toBe('Analysis & Follow-up');
    expect(tile.link).toBe(`${COURSE_LINKS.studyGuides}&guide=guide-9`);
  });

  it('stays on the live track while any published assignment is still open', () => {
    const tile = guideTilePresentation(guide({ assignedCount: 2, doneAssignmentCount: 1 }));
    expect(tile.badge).toEqual({ label: '0 completed', tone: 'neutral' });
    expect(tile.actionLabel).toBe('Inspect');
    expect(tile.secondaryAction).toBeUndefined();
  });

  it('suggests completing a pieceless guide instead of assigning it', () => {
    const tile = guideTilePresentation(guide({ pieceCount: 0 }));
    expect(tile.badge).toEqual({ label: 'Incomplete', tone: 'warning' });
    expect(tile.actionLabel).toBe('Complete');
    expect(tile.link).toBe(COURSE_LINKS.studyGuides);
    expect(tile.meta).toBe('No pieces yet — build the outline to finish it');
  });

  it('suggests completing a guide whose pieces still lack questions', () => {
    const tile = guideTilePresentation(guide({ pieceCount: 5, incompletePieceCount: 2 }));
    expect(tile.badge).toEqual({ label: 'Incomplete', tone: 'warning' });
    expect(tile.actionLabel).toBe('Complete');
    expect(tile.meta).toBe('2 of 5 pieces have no questions yet');
  });

  it('incompleteness wins over the staged-draft meta line', () => {
    const tile = guideTilePresentation(guide({ pieceCount: 0, draftAssignmentCount: 1 }));
    expect(tile.actionLabel).toBe('Complete');
    expect(tile.meta).toBe('No pieces yet — build the outline to finish it');
  });

  it('keeps the assigned track for a guide that became incomplete after assignment', () => {
    // guideIsAssignable's escape hatch: an assigned guide must stay
    // retractable, so the tile never flips to "Complete" once it is out.
    const tile = guideTilePresentation(guide({ assignedCount: 1, pieceCount: 0 }));
    expect(tile.badge).toEqual({ label: '0 completed', tone: 'neutral' });
    expect(tile.actionLabel).toBe('Inspect');
  });
});

describe('shelf ranks', () => {
  it('orders guides live → done → not assigned → incomplete', () => {
    expect(guideShelfRank(guide({ assignedCount: 1 }))).toBe(0);
    expect(guideShelfRank(guide({ assignedCount: 2, doneAssignmentCount: 1 }))).toBe(0);
    expect(guideShelfRank(guide({ assignedCount: 2, doneAssignmentCount: 2 }))).toBe(1);
    expect(guideShelfRank(guide())).toBe(2);
    // A draft-only (staged) guide is still invisible to students.
    expect(guideShelfRank(guide({ draftAssignmentCount: 1 }))).toBe(2);
    // Incomplete guides go last: they cannot be assigned yet.
    expect(guideShelfRank(guide({ pieceCount: 0 }))).toBe(3);
    expect(guideShelfRank(guide({ pieceCount: 5, incompletePieceCount: 1 }))).toBe(3);
    // …unless already assigned — live work stays first however broken.
    expect(guideShelfRank(guide({ assignedCount: 1, pieceCount: 0 }))).toBe(0);
  });

  it('orders quizzes open → closed → not assigned', () => {
    expect(quizShelfRank(quiz({ openCount: 1 }))).toBe(0);
    expect(quizShelfRank(quiz({ openCount: 1, closedCount: 1 }))).toBe(0);
    expect(quizShelfRank(quiz({ closedCount: 1 }))).toBe(1);
    expect(quizShelfRank(quiz())).toBe(2);
    expect(quizShelfRank(quiz({ draftAssignmentCount: 1 }))).toBe(2);
  });

  it('sorting by rank puts the shelves in the Assigned, Done, Not-assigned, Incomplete order', () => {
    const done = guide({ id: 'done', assignedCount: 1, doneAssignmentCount: 1 });
    const live = guide({ id: 'live', assignedCount: 1 });
    const unassigned = guide({ id: 'un' });
    const incomplete = guide({ id: 'inc', pieceCount: 0 });
    const sorted = [incomplete, unassigned, done, live].sort(
      (a, b) => guideShelfRank(a) - guideShelfRank(b),
    );
    expect(sorted.map((g) => g.id)).toEqual(['live', 'done', 'un', 'inc']);
  });
});

describe('quizTilePresentation', () => {
  it('prompts an unassigned quiz to be assigned', () => {
    const tile = quizTilePresentation(quiz());
    expect(tile.actionLabel).toBe('Assign');
    expect(tile.badge).toEqual({ label: 'Not assigned', tone: 'warning' });
    expect(tile.link).toBe(COURSE_LINKS.quizzes);
  });

  it('shows class names beside the question count', () => {
    const tile = quizTilePresentation(
      quiz({ openCount: 1, assignedClassNames: ['Τμήμα 1Α'], questionCount: 1 }),
    );
    expect(tile.meta).toBe('1 question · Τμήμα 1Α');
    expect(tile.badge).toEqual({ label: 'Open', tone: 'success' });
    expect(tile.actionLabel).toBe('Inspect');
  });

  it('keeps Inspect just below the threshold, listing finishers in the meta', () => {
    const tile = quizTilePresentation(
      quiz({ openCount: 1, studentsCompleted: ANALYTICS_PROMPT_MIN - 1 }),
    );
    expect(tile.actionLabel).toBe('Inspect');
    expect(tile.meta).toBe(`5 questions · ${ANALYTICS_PROMPT_MIN - 1} completed`);
    expect(tile.link).toBe(COURSE_LINKS.quizzes);
  });

  it('switches badge, action, and deep link together at the threshold', () => {
    const tile = quizTilePresentation(
      quiz({ id: 'quiz-7', closedCount: 1, studentsCompleted: ANALYTICS_PROMPT_MIN }),
    );
    expect(tile.actionLabel).toBe('See results');
    expect(tile.badge).toEqual({ label: `${ANALYTICS_PROMPT_MIN} completed`, tone: 'success' });
    expect(tile.link).toBe(`${COURSE_LINKS.quizzes}&quiz=quiz-7`);
    expect(tile.meta).toBe('5 questions');
  });

  it('marks a closed, un-completed quiz as Closed/Inspect', () => {
    const tile = quizTilePresentation(quiz({ closedCount: 1 }));
    expect(tile.badge).toEqual({ label: 'Closed', tone: 'neutral' });
    expect(tile.actionLabel).toBe('Inspect');
  });
});
