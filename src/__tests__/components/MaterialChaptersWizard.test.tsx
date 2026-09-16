import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('@/integrations/supabase/client', () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: vi.fn((cb: (v: { data: unknown[]; error: null }) => void) =>
      Promise.resolve(cb({ data: [], error: null }))
    ),
  };
  for (const key of Object.keys(chain)) {
    const fn = chain[key as keyof typeof chain];
    if (typeof fn === 'function' && !['then', 'single'].includes(key)) {
      (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return {
    supabase: {
      from: vi.fn(() => chain),
      functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import MaterialChaptersWizard from '@/components/MaterialChaptersWizard';

const defaultProps = {
  materialId: 'mat-1',
  materialTitle: 'Test Material',
  materialFileUrl: 'http://example.com/file.pdf',
  materialType: 'pdf',
  open: true,
  onOpenChange: vi.fn(),
};

describe('MaterialChaptersWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing when open', () => {
    render(<MaterialChaptersWizard {...defaultProps} />);
    expect(document.body).toBeTruthy();
  });

  it('does not render content when closed', () => {
    render(<MaterialChaptersWizard {...defaultProps} open={false} />);
    // Dialog should not show material title in content area
    expect(screen.queryByText('Test Material')).not.toBeInTheDocument();
  });

  it('displays material title when open', () => {
    render(<MaterialChaptersWizard {...defaultProps} />);
    expect(screen.getByText(/Test Material/)).toBeInTheDocument();
  });

  it('accepts optional props', () => {
    render(
      <MaterialChaptersWizard
        {...defaultProps}
        openaiFileId="file-123"
        courseId="course-1"
        vectorStoreId="vs-1"
        pageCount={42}
        onChaptersUpdated={vi.fn()}
      />
    );
    expect(document.body).toBeTruthy();
  });
});
