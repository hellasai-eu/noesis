import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// CourseCompetencies reports its count upward so CoursePage can flag a course
// with no competencies on the Class Management tab. The number it reports has
// to be the number of rows that actually reached the database — an unsaved
// draft clearing that warning is exactly the failure this file guards.

const mockFromImpl = vi.hoisted(() => vi.fn());

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockFromImpl,
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

type ChainResult = { data: unknown; error: unknown };

function createChainMock(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((cb: (val: ChainResult) => void) => Promise.resolve(cb(result)));
  return chain;
}

const persistedCompetency = {
  id: 'comp-1',
  title: 'Reads a primary source critically',
  description: 'desc',
  chapter_id: null,
  material_id: null,
  order_num: 0,
};

function mockTables(competencies: unknown[]) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === 'course_competencies') {
      return createChainMock({ data: competencies, error: null });
    }
    return createChainMock({ data: [], error: null });
  });
}

async function loadPanel() {
  const mod = await import('@/components/CourseCompetencies');
  return mod.default;
}

async function renderPanel(onCountChange: (n: number) => void, courseId = 'course-1') {
  const Component = await loadPanel();
  return render(
    <Component
      courseId={courseId}
      courseTitle="Test Course"
      onCountChange={onCountChange}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTables([]);
});

describe('CourseCompetencies — count reported to the parent tab', () => {
  it('reports 0 for a course with no competencies', async () => {
    const onCountChange = vi.fn();
    await renderPanel(onCountChange);

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
  });

  it('reports the number of stored competencies', async () => {
    mockTables([persistedCompetency]);
    const onCountChange = vi.fn();
    await renderPanel(onCountChange);

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
  });

  it('reports nothing for a course whose load failed', async () => {
    // The panel stays mounted across a courseId change, and a failed fetch
    // leaves the previous course's rows in state. Reporting their count would
    // hand the parent a number belonging to a different course.
    mockTables([persistedCompetency]);
    const onCountChange = vi.fn();
    const Component = await loadPanel();
    const { rerender } = render(
      <Component courseId="course-1" courseTitle="Test Course" onCountChange={onCountChange} />
    );

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
    onCountChange.mockClear();

    mockFromImpl.mockImplementation(() =>
      createChainMock({ data: null, error: { message: 'boom' } })
    );
    rerender(
      <Component courseId="course-2" courseTitle="Other Course" onCountChange={onCountChange} />
    );

    // Wait for the failed fetch to settle, then assert nothing was reported.
    await waitFor(() => expect(mockFromImpl).toHaveBeenCalledWith('course_competencies'));
    await waitFor(() => expect(screen.getByTestId('competency-count')).toBeInTheDocument());
    expect(onCountChange).not.toHaveBeenCalled();
  });

  it('discards a load that a newer courseId has superseded', async () => {
    // Course A's fetch is still in flight when the panel switches to course B.
    // Whichever order they finish in, A's rows must never land in state — from
    // there a later successful write would stamp them as B's.
    let releaseCourseA: () => void = () => {};
    const courseALanded = new Promise<void>(resolve => {
      releaseCourseA = resolve;
    });

    let competencyQueries = 0;
    mockFromImpl.mockImplementation((table: string) => {
      if (table !== 'course_competencies') {
        return createChainMock({ data: [], error: null });
      }
      competencyQueries += 1;
      const result = competencyQueries === 1
        ? { data: [persistedCompetency], error: null }
        : { data: [], error: null };
      const chain = createChainMock(result);
      if (competencyQueries === 1) {
        chain.then = vi.fn((cb: (val: ChainResult) => void) =>
          courseALanded.then(() => cb(result))
        );
      }
      return chain;
    });

    const onCountChange = vi.fn();
    const Component = await loadPanel();
    const { rerender } = render(
      <Component courseId="course-a" courseTitle="A" onCountChange={onCountChange} />
    );
    rerender(
      <Component courseId="course-b" courseTitle="B" onCountChange={onCountChange} />
    );

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));

    // Course A answers late.
    await act(async () => {
      releaseCourseA();
      await courseALanded;
    });

    expect(screen.queryByText(persistedCompetency.title)).not.toBeInTheDocument();
    expect(onCountChange).not.toHaveBeenCalledWith(1);
  });

  it('ignores a write that lands after the panel has moved to another course', async () => {
    // The instructor saves in course A and navigates immediately. The insert
    // resolves under course B, carrying A's courseId in its closure.
    //
    // Unlike the other cases here, this one does not fail against the code
    // before the fix: the ownership guard already suppresses the report, and a
    // wrongly-stamped owner is corrected by the next write or load. The fix
    // stops the panel from claiming a course it has left at all; this test
    // pins the invariant that matters either way — a write belonging to
    // course A is never reported as course B's count.
    let releaseInsert: () => void = () => {};
    const insertLanded = new Promise<void>(resolve => {
      releaseInsert = resolve;
    });

    mockFromImpl.mockImplementation((table: string) => {
      const chain = createChainMock({ data: [], error: null });
      if (table === 'course_competencies') {
        chain.single = vi.fn(() =>
          insertLanded.then(() => ({ data: { id: 'comp-new' }, error: null }))
        );
      }
      return chain;
    });

    const user = userEvent.setup();
    const onCountChange = vi.fn();
    const Component = await loadPanel();
    const { rerender } = render(
      <Component courseId="course-a" courseTitle="A" onCountChange={onCountChange} />
    );

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
    await user.click(await screen.findByRole('button', { name: /add your first competency/i }));
    await user.type(await screen.findByPlaceholderText(/competency title/i), 'In flight');
    await user.click(screen.getByRole('button', { name: /save competency/i }));

    // Navigate away while the insert is still open, then let it land.
    rerender(
      <Component courseId="course-b" courseTitle="B" onCountChange={onCountChange} />
    );
    onCountChange.mockClear();
    await act(async () => {
      releaseInsert();
      await insertLanded;
    });

    // Course B's own load is what may speak for B — and it reports 0, not the
    // 1 that belonged to course A.
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
    expect(onCountChange).not.toHaveBeenCalledWith(1);
  });

  it('shows a load failure as a failure, not as an empty course', async () => {
    mockFromImpl.mockImplementation(() =>
      createChainMock({ data: null, error: { message: 'boom' } })
    );
    await renderPanel(vi.fn());

    // The assertive "no competencies yet" copy would be a lie here.
    expect(await screen.findByTestId('competencies-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('competencies-empty-state')).not.toBeInTheDocument();
  });

  it('reports again once a competency is saved after a failed load', async () => {
    const user = userEvent.setup();
    const onCountChange = vi.fn();

    // Everything fails except the insert, which returns a real row id.
    mockFromImpl.mockImplementation((table: string) => {
      const chain = createChainMock({ data: null, error: { message: 'boom' } });
      if (table === 'course_competencies') {
        chain.single = vi.fn().mockResolvedValue({ data: { id: 'comp-new' }, error: null });
      }
      return chain;
    });

    await renderPanel(onCountChange);
    await screen.findByTestId('competencies-load-error');
    // Nothing is known about this course, so nothing may be reported.
    expect(onCountChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^Add$/i }));
    const title = await screen.findByPlaceholderText(/competency title/i);
    await user.type(title, 'Saved after the failure');
    await user.click(screen.getByRole('button', { name: /save competency/i }));

    // The saved row is unambiguously this course's, so the marker must clear.
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
  });

  it('does not count an unsaved draft added with Add', async () => {
    const user = userEvent.setup();
    const onCountChange = vi.fn();
    await renderPanel(onCountChange);

    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(0));
    onCountChange.mockClear();

    // The empty state's own call to action creates a `temp-` row in state only.
    await user.click(await screen.findByRole('button', { name: /add your first competency/i }));

    // The draft is on screen…
    expect(screen.queryByTestId('competencies-empty-state')).not.toBeInTheDocument();
    // …but the course still has nothing stored, so the parent must not be told
    // otherwise. Any call at all here would have to be 0.
    for (const call of onCountChange.mock.calls) {
      expect(call[0]).toBe(0);
    }
  });
});
