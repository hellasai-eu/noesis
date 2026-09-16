import { describe, it, expect } from 'vitest';
import {
  deriveCourseChecklist,
  COURSE_LINKS,
  type InstructorContent,
  type GuideSummary,
  type QuizSummary,
} from '@/lib/instructor-surface';

const COURSE = 'course-1';

function content(overrides: Partial<InstructorContent> = {}): InstructorContent {
  return {
    materialCountByCourse: {},
    competencyCountByCourse: {},
    guides: [],
    quizzes: [],
    ...overrides,
  };
}

function guide(overrides: Partial<GuideSummary> = {}): GuideSummary {
  return {
    id: 'g1',
    courseId: COURSE,
    title: 'Guide',
    createdAt: '2026-01-01',
    assignedCount: 0,
    doneAssignmentCount: 0,
    nextDueDate: null,
    draftAssignmentCount: 0,
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
    courseId: COURSE,
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

describe('deriveCourseChecklist', () => {
  it('starts a fresh course at step 1: upload a material', () => {
    const cl = deriveCourseChecklist(COURSE, content());
    expect(cl.doneCount).toBe(0);
    expect(cl.nextStep?.key).toBe('material');
    expect(cl.nextStep?.link).toBe(COURSE_LINKS.materials);
  });

  it('advances to competencies once a material exists', () => {
    const cl = deriveCourseChecklist(
      COURSE,
      content({ materialCountByCourse: { [COURSE]: 2 } }),
    );
    expect(cl.doneCount).toBe(1);
    expect(cl.nextStep?.key).toBe('competencies');
    expect(cl.nextStep?.link).toBe(COURSE_LINKS.competencies);
  });

  it('keeps the steps sequential: content created out of order still leaves earlier steps next', () => {
    // A quiz exists but no material row — next step is still the first undone one.
    const cl = deriveCourseChecklist(COURSE, content({ quizzes: [quiz()] }));
    expect(cl.nextStep?.key).toBe('material');
    expect(cl.steps.find((s) => s.key === 'content')?.done).toBe(true);
  });

  it('counts an open or closed quiz assignment as assigned, but not a draft one', () => {
    const base = {
      materialCountByCourse: { [COURSE]: 1 },
      competencyCountByCourse: { [COURSE]: 3 },
    };
    const draft = deriveCourseChecklist(
      COURSE,
      content({ ...base, quizzes: [quiz({ draftAssignmentCount: 1 })] }),
    );
    expect(draft.nextStep?.key).toBe('assign');

    const closed = deriveCourseChecklist(
      COURSE,
      content({ ...base, quizzes: [quiz({ closedCount: 1 })] }),
    );
    expect(closed.nextStep).toBeUndefined();
    expect(closed.doneCount).toBe(4);
  });

  it('counts a published guide assignment as assigned', () => {
    const cl = deriveCourseChecklist(
      COURSE,
      content({
        materialCountByCourse: { [COURSE]: 1 },
        competencyCountByCourse: { [COURSE]: 1 },
        guides: [guide({ assignedCount: 2 })],
      }),
    );
    expect(cl.nextStep).toBeUndefined();
  });

  it('ignores other courses’ content entirely', () => {
    const cl = deriveCourseChecklist(
      COURSE,
      content({
        materialCountByCourse: { other: 5 },
        competencyCountByCourse: { other: 5 },
        guides: [guide({ courseId: 'other', assignedCount: 1 })],
      }),
    );
    expect(cl.doneCount).toBe(0);
    expect(cl.nextStep?.key).toBe('material');
  });

  it('points the assign step at the surface with unassigned work', () => {
    const base = {
      materialCountByCourse: { [COURSE]: 1 },
      competencyCountByCourse: { [COURSE]: 1 },
    };
    // Unassigned guide → study guides tab.
    const guides = deriveCourseChecklist(
      COURSE,
      content({ ...base, guides: [guide()], quizzes: [quiz({ openCount: 1 })] }),
    );
    expect(guides.steps.find((s) => s.key === 'assign')?.link).toBe(COURSE_LINKS.studyGuides);

    // Only quizzes exist → quizzes tab.
    const quizzes = deriveCourseChecklist(COURSE, content({ ...base, quizzes: [quiz()] }));
    expect(quizzes.steps.find((s) => s.key === 'assign')?.link).toBe(COURSE_LINKS.quizzes);
  });
});
