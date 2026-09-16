import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

vi.mock('@/integrations/supabase/client', () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: vi.fn((cb: (v: { data: unknown[]; error: null }) => void) =>
      Promise.resolve(cb({ data: [], error: null }))
    ),
  };
  for (const key of Object.keys(chain)) {
    const fn = chain[key as keyof typeof chain];
    if (typeof fn === 'function' && !['then', 'single', 'maybeSingle'].includes(key)) {
      (fn as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return {
    supabase: {
      from: vi.fn(() => chain),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'http://example.com/img.png' } })),
          upload: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-123' },
    profile: { full_name: 'Test User' },
    effectiveInstitutionId: 'inst-123',
    isSuperAdmin: true,
  }),
}));

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('@/components/PdfViewerWithExtract', () => ({
  default: () => <div data-testid="pdf-viewer" />,
}));

import { OfferingContentManager } from '@/components/OfferingContentManager';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

describe('OfferingContentManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <OfferingContentManager courseId="course-123" classes={[]} />
        </BrowserRouter>
      </QueryClientProvider>
    );
    expect(document.body).toBeTruthy();
  });

  it('renders with classes', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <OfferingContentManager
            courseId="course-123"
            classes={[{ id: 'c-1', name: 'Class A', grade_level_id: null, section_name: null, category: null, academic_period: null, offering_id: 'off-1' }]}
          />
        </BrowserRouter>
      </QueryClientProvider>
    );
    expect(document.body).toBeTruthy();
  });

  it('accepts defaultTab prop', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <OfferingContentManager
            courseId="course-123"
            classes={[]}
            defaultTab="materials"
          />
        </BrowserRouter>
      </QueryClientProvider>
    );
    expect(document.body).toBeTruthy();
  });
});
