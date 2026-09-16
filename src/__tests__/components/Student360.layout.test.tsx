/**
 * Where the class selector sits.
 *
 * Student360 is mounted two ways, and the selector belongs in a different
 * place in each:
 *
 *  - **Tabbed** (ClassDetailPanel, no `panels` prop) — the selector scopes all
 *    three panels at once, so it sits in the header row beside the tab strip.
 *  - **Single panel** (CoursePage's My Class / Data Bank sub-tabs) — the
 *    caller's own tab already names the panel, so the selector drops into the
 *    panel. For Interactions that means *below* its inner tab strip, so the
 *    strip stays tight under the tab that opened it; for the panels with no
 *    inner strip it stays at the top.
 *
 * Every other test in the suite mocks this component out, so ordering is only
 * covered here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const offeringRows = [
  {
    id: 'off-1',
    class_id: 'class-1',
    classes: {
      id: 'class-1',
      name: 'Α1',
      grade_level_id: 'gl-1',
      section_name: 'Α',
      is_active: true,
    },
  },
];

const eqMock = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: eqMock })) })) },
}));

vi.mock('@/i18n/formatters', () => ({
  useFormatters: () => ({ compareText: (a: string, b: string) => a.localeCompare(b) }),
}));

vi.mock('@/lib/greek-school', () => ({
  buildClassDisplayName: (c: { name: string }) => c.name,
}));

vi.mock('@/components/StudentEvaluations', () => ({
  default: () => <div data-testid="student-evaluations" />,
}));
vi.mock('@/components/QuizHistory', () => ({
  default: () => <div data-testid="quiz-history" />,
}));
vi.mock('@/components/OpenQuestionChatHistory', () => ({
  default: () => <div data-testid="open-question-chat-history" />,
}));
vi.mock('@/components/QuestionFeedback', () => ({
  default: () => <div data-testid="question-feedback" />,
}));
vi.mock('@/components/ClassCompetencyAnalytics', () => ({
  ClassCompetencyAnalytics: () => <div data-testid="class-competency-analytics" />,
}));

import Student360, { type Student360Panel } from '@/components/Student360';

/** DOCUMENT_POSITION_FOLLOWING === 4 — `a` comes before `b` in the DOM. */
const precedes = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

const renderPanels = async (panels?: Student360Panel[]) => {
  render(<Student360 courseId="course-1" panels={panels} />);
  // The selector only renders once the offerings query resolves.
  return screen.findByRole('combobox');
};

beforeEach(() => {
  vi.clearAllMocks();
  eqMock.mockResolvedValue({ data: offeringRows, error: null });
});

describe('Student360 — class selector placement', () => {
  it('puts the selector below the tab strip in the single Interactions panel', async () => {
    const selector = await renderPanels(['interactions']);

    // The one tab strip on screen is the panel's own (Question Answers /
    // Student Chats / Question Feedback) — there is no outer strip in
    // single-panel mode.
    const strip = screen.getByRole('tablist');
    expect(screen.getByRole('tab', { name: /Question Answers/i })).toBeInTheDocument();

    expect(precedes(strip, selector)).toBe(true);
    expect(precedes(selector, screen.getByTestId('quiz-history'))).toBe(true);

    // Exactly once — the panel places it, the wrapper no longer also does.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('keeps the selector at the top of panels that have no tab strip', async () => {
    const selector = await renderPanels(['evaluations']);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(precedes(selector, screen.getByTestId('student-evaluations'))).toBe(true);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('keeps the selector above the Class Competencies charts', async () => {
    const selector = await renderPanels(['competencies']);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(precedes(selector, screen.getByTestId('class-competency-analytics'))).toBe(true);
  });

  it('keeps the selector in the header row when all three panels are tabbed', async () => {
    // No `panels` prop — how ClassDetailPanel mounts it.
    const selector = await renderPanels(undefined);

    const strip = screen.getByRole('tablist');
    expect(screen.getByRole('tab', { name: /Student Evaluations/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Interactions/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Class Competencies/i })).toBeInTheDocument();

    // Beside the strip, and above the panel it scopes.
    expect(precedes(strip, selector)).toBe(true);
    expect(precedes(selector, screen.getByTestId('student-evaluations'))).toBe(true);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('renders no selector at all for a course with no classes', async () => {
    eqMock.mockResolvedValue({ data: [], error: null });

    render(<Student360 courseId="course-1" panels={['interactions']} />);

    // The panel still renders; only the selector is withheld.
    expect(await screen.findByRole('tab', { name: /Question Answers/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
