import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React, { ReactElement } from 'react';

// --- Hoisted mocks ---
const mockNavigate = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({
  id: 'test-user-id',
  email: 'test@example.com',
  user_metadata: { full_name: 'Test User' },
}));

// --- Module mocks ---

// useAuth
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    session: {
      user: mockUser,
      access_token: 'mock-token',
      refresh_token: 'mock-refresh',
    },
    profile: {
      id: 'profile-id',
      user_id: 'test-user-id',
      full_name: 'Test User',
      email: 'test@example.com',
    },
    loading: false,
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null, data: { user: null } }),
    signOut: vi.fn().mockResolvedValue(undefined),
    updatePassword: vi.fn().mockResolvedValue({ error: null }),
    effectiveInstitutionId: 'inst-123',
    isSuperAdmin: true,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// useUserInstitution
vi.mock('@/hooks/useUserInstitution', () => ({
  useUserInstitution: () => ({
    membership: null,
    loading: false,
    institutionId: 'inst-123',
    role: 'admin',
    isAdmin: true,
    isInstructor: false,
    isStudent: false,
    refetch: vi.fn(),
  }),
}));

// useInstitutionConfig
vi.mock('@/hooks/useInstitutionConfig', () => ({
  useInstitutionConfig: () => ({
    institutionType: 'greek_school',
    schoolLevels: ['dimotiko', 'gymnasio', 'lykeio'],
    defaultLanguage: 'el',
    academicPeriod: '2025-2026',
    loading: false,
  }),
}));

// Supabase client
vi.mock('@/integrations/supabase/client', () => {
  const chainMethods = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    like: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: vi.fn((cb: (val: { data: unknown[]; error: null }) => void) =>
      Promise.resolve(cb({ data: [], error: null }))
    ),
  };
  // Make every method also chainable to itself
  for (const key of Object.keys(chainMethods)) {
    const fn = chainMethods[key as keyof typeof chainMethods];
    if (typeof fn === 'function' && key !== 'then' && key !== 'single' && key !== 'maybeSingle') {
      (fn as ReturnType<typeof vi.fn>).mockReturnValue(chainMethods);
    }
  }
  return {
    supabase: {
      from: vi.fn(() => chainMethods),
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
        signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
        signUp: vi.fn().mockResolvedValue({ data: {}, error: null }),
        signOut: vi.fn().mockResolvedValue({ error: null }),
        updateUser: vi.fn().mockResolvedValue({ data: {}, error: null }),
        onAuthStateChange: vi.fn().mockReturnValue({
          data: { subscription: { unsubscribe: vi.fn() } },
        }),
      },
      functions: {
        invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
      },
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
      })),
      removeChannel: vi.fn(),
      storage: {
        from: vi.fn(() => ({
          getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'http://example.com/img.png' } })),
          upload: vi.fn().mockResolvedValue({ data: null, error: null }),
          download: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      },
    },
  };
});

// sonner
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

// use-toast hook
vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

// react-router-dom: we keep real Router but mock useNavigate
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// latex-utils
vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
  renderLatexInHtml: (text: string) => text,
  sanitizeMathContent: (text: string) => text,
}));

// lib/utils
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatExplanation: (text: string) => text,
}));

// PasswordStrengthIndicator
vi.mock('@/components/PasswordStrengthIndicator', () => ({
  default: () => <div data-testid="password-strength" />,
}));

// Recharts (used by admin pages)
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  Legend: () => <div />,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: () => <div />,
  Cell: () => <div />,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => <div />,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => <div />,
}));

// @supabase/supabase-js
vi.mock('@supabase/supabase-js', () => ({
  AuthApiError: class AuthApiError extends Error {
    code: string;
    constructor(message: string, code = 'unknown') {
      super(message);
      this.code = code;
    }
  },
  createClient: vi.fn(),
}));

// pdfjs-dist (used by PdfViewerWithExtract)
vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

vi.mock('@/components/PdfViewerWithExtract', () => ({
  default: () => <div data-testid="pdf-viewer" />,
}));

// --- Helpers ---

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderPage(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderWithRoute(
  Component: React.ComponentType,
  { route = '/', path = '/' }: { route?: string; path?: string } = {}
) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path={path} element={<Component />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

// Pages without route params
const simplePages = [
  { name: 'Auth', path: () => import('@/pages/Auth') },
  { name: 'Dashboard', path: () => import('@/pages/Dashboard') },
  { name: 'InstructorHome', path: () => import('@/pages/InstructorHome') },
  { name: 'StudentDashboard', path: () => import('@/pages/StudentDashboard') },
  { name: 'EvaluatorDashboard', path: () => import('@/pages/EvaluatorDashboard') },
  { name: 'UserManagement', path: () => import('@/pages/UserManagement') },
  { name: 'ClassManagement', path: () => import('@/pages/ClassManagement') },
  { name: 'SelectInstitution', path: () => import('@/pages/SelectInstitution') },
  { name: 'Contact', path: () => import('@/pages/Contact') },
  { name: 'ResetPassword', path: () => import('@/pages/ResetPassword') },
  { name: 'NotFound', path: () => import('@/pages/NotFound') },
  { name: 'SuperAdminDashboard', path: () => import('@/pages/SuperAdminDashboard') },
  { name: 'SuperAdminStats', path: () => import('@/pages/SuperAdminStats') },
  { name: 'SuperAdminUsers', path: () => import('@/pages/SuperAdminUsers') },
  { name: 'SuperAdminUsage', path: () => import('@/pages/SuperAdminUsage') },
  { name: 'SuperAdminAI', path: () => import('@/pages/SuperAdminAI') },
  { name: 'SuperAdminExport', path: () => import('@/pages/SuperAdminExport') },
  { name: 'SuperAdminVersion', path: () => import('@/pages/SuperAdminVersion') },
  { name: 'SuperAdminAgentLogs', path: () => import('@/pages/SuperAdminAgentLogs') },
  { name: 'VectorStoreAdmin', path: () => import('@/pages/VectorStoreAdmin') },
];

describe('Page smoke tests', () => {
  describe.each(simplePages)('$name', ({ path }) => {
    it('renders without crashing', async () => {
      const mod = await path();
      const Component = mod.default;
      renderPage(<Component />);
      expect(document.body).toBeTruthy();
    });
  });

  // Pages with route params
  describe('InstitutionPage', () => {
    it('renders without crashing', async () => {
      const mod = await import('@/pages/InstitutionPage');
      renderWithRoute(mod.default, { route: '/i/test-school', path: '/i/:slug' });
      expect(document.body).toBeTruthy();
    });
  });

  describe('CoursePage', () => {
    it('renders without crashing', async () => {
      const mod = await import('@/pages/CoursePage');
      renderWithRoute(mod.default, { route: '/course/abc', path: '/course/:courseId' });
      expect(document.body).toBeTruthy();
    });
  });

  describe('StudentCourse', () => {
    it('renders without crashing', async () => {
      const mod = await import('@/pages/StudentCourse');
      renderWithRoute(mod.default, {
        route: '/student/course/abc',
        path: '/student/course/:courseId',
      });
      expect(document.body).toBeTruthy();
    });
  });

  describe('StudentQuizHistory', () => {
    it('renders without crashing', async () => {
      const mod = await import('@/pages/StudentQuizHistory');
      renderWithRoute(mod.default, {
        route: '/student/course/abc/quiz-history',
        path: '/student/course/:courseId/quiz-history',
      });
      expect(document.body).toBeTruthy();
    });
  });

  describe('EvaluatorCourse', () => {
    it('renders without crashing', async () => {
      const mod = await import('@/pages/EvaluatorCourse');
      renderWithRoute(mod.default, {
        route: '/evaluator/course/abc',
        path: '/evaluator/course/:courseId',
      });
      expect(document.body).toBeTruthy();
    });
  });

  // --- Key page interaction tests ---

  describe('NotFound interactions', () => {
    it('displays 404 text', async () => {
      const mod = await import('@/pages/NotFound');
      renderPage(<mod.default />);
      expect(screen.getByText('404')).toBeInTheDocument();
      expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    });

    it('has a link to home', async () => {
      const mod = await import('@/pages/NotFound');
      renderPage(<mod.default />);
      const link = screen.getByText(/return to home/i);
      expect(link).toHaveAttribute('href', '/');
    });
  });

  describe('Contact interactions', () => {
    it('displays the contact form fields', async () => {
      const mod = await import('@/pages/Contact');
      renderPage(<mod.default />);
      expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/subject/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/message/i)).toBeInTheDocument();
    });
  });
});
