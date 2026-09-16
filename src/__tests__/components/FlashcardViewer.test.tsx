import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

vi.mock('@/integrations/supabase/client', () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((cb: (v: { data: unknown[]; error: null }) => void) =>
      Promise.resolve(cb({ data: [], error: null }))
    ),
  };
  for (const key of Object.keys(chain)) {
    const fn = chain[key as keyof typeof chain];
    if (typeof fn === 'function' && key !== 'then') {
      (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return {
    supabase: {
      from: vi.fn(() => chain),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
      })),
      removeChannel: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import FlashcardViewer from '@/components/FlashcardViewer';

describe('FlashcardViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<FlashcardViewer courseId="course-123" />);
    expect(document.body).toBeTruthy();
  });

  it('accepts isAdmin prop', () => {
    render(<FlashcardViewer courseId="course-123" isAdmin />);
    expect(document.body).toBeTruthy();
  });

  it('accepts onlyVisible prop', () => {
    render(<FlashcardViewer courseId="course-123" onlyVisible />);
    expect(document.body).toBeTruthy();
  });

  it('accepts filterChapterId prop', () => {
    render(<FlashcardViewer courseId="course-123" filterChapterId="ch-1" />);
    expect(document.body).toBeTruthy();
  });

  it('accepts offeringId prop', () => {
    render(<FlashcardViewer courseId="course-123" offeringId="off-1" />);
    expect(document.body).toBeTruthy();
  });

  it('rerenders with different courseId', () => {
    const { rerender } = render(<FlashcardViewer courseId="course-1" />);
    rerender(<FlashcardViewer courseId="course-2" />);
    expect(document.body).toBeTruthy();
  });
});
