import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import React from 'react';

// --- Hoisted state ---
const mockNavigate = vi.hoisted(() => vi.fn());
const mockUser = vi.hoisted(() => ({
  id: 'instructor-user-id',
  email: 'instructor@test.local',
  user_metadata: { full_name: 'Test Instructor' },
}));
const mockFromImpl = vi.hoisted(() => vi.fn());
const routeCourseId = vi.hoisted(() => ({ current: 'course-1' }));
const userInstitutionResult = vi.hoisted(() => ({
  current: {
    membership: null,
    loading: false,
    institutionId: 'inst-123',
    role: 'admin' as string,
    isAdmin: true,
    isInstructor: false,
    isStudent: false,
    refetch: vi.fn(),
  },
}));

// --- Module mocks ---
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    session: { user: mockUser, access_token: 't', refresh_token: 'r' },
    profile: { id: 'profile-id', user_id: mockUser.id, full_name: 'Test', email: mockUser.email },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    updatePassword: vi.fn(),
    effectiveInstitutionId: 'inst-123',
    isSuperAdmin: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useUserInstitution', () => ({
  useUserInstitution: () => userInstitutionResult.current,
}));

vi.mock('@/hooks/useInstitutionConfig', () => ({
  useInstitutionConfig: () => ({
    institutionType: 'greek_school',
    schoolLevels: ['dimotiko', 'gymnasio', 'lykeio'],
    defaultLanguage: 'el',
    academicPeriod: '2025-2026',
    loading: false,
  }),
}));

type ChainResult = { data: unknown; error: unknown; count?: number | null };

function createChainMock(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'delete', 'eq', 'neq', 'in', 'not',
    'is', 'or', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'order',
    'limit', 'range', 'upsert',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.then = vi.fn((cb: (val: ChainResult) => void) =>
    Promise.resolve(cb(result))
  );
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mockFromImpl,
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
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
        createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'x' }, error: null }),
      })),
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/hooks/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}));

// The course in the URL. Mocked rather than driven through MemoryRouter
// because `initialEntries` only applies on mount, so a rerender cannot walk
// between courses — and walking between them is what the effects react to.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ courseId: routeCourseId.current }),
  };
});

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatExplanation: (text: string) => text,
}));

vi.mock('@/lib/latex-utils', () => ({
  processLatexContent: (text: string) => text,
  renderLatexInHtml: (text: string) => text,
  sanitizeMathContent: (text: string) => text,
}));

// Stub all heavy child components so the test can focus on tab structure.
// QuizManager / StudyGuideManager also capture their props: the analytics
// deep-link describe drives their consumed callbacks by hand.
const quizManagerProps = vi.hoisted(() => ({
  current: null as null | {
    initialReportQuizId?: string | null;
    onInitialReportConsumed?: () => void;
  },
}));
vi.mock('@/components/QuizManager', () => ({
  QuizManager: (props: {
    courseId: string;
    initialReportQuizId?: string | null;
    onInitialReportConsumed?: () => void;
  }) => {
    quizManagerProps.current = props;
    return (
      <div data-testid="quiz-manager" data-quiz={props.initialReportQuizId ?? ''}>
        QuizManager:{props.courseId}
      </div>
    );
  },
}));
const sgManagerProps = vi.hoisted(() => ({
  current: null as null | {
    initialResultsGuideId?: string | null;
    onInitialResultsConsumed?: () => void;
  },
}));
vi.mock('@/components/StudyGuideManager', () => ({
  StudyGuideManager: (props: {
    courseId: string;
    initialResultsGuideId?: string | null;
    onInitialResultsConsumed?: () => void;
  }) => {
    sgManagerProps.current = props;
    return (
      <div
        data-testid="study-guide-manager"
        data-guide={props.initialResultsGuideId ?? ''}
      />
    );
  },
}));
vi.mock('@/components/TestBuilder', () => ({
  TestBuilder: ({ courseId }: { courseId: string }) => (
    <div data-testid="test-builder">TestBuilder:{courseId}</div>
  ),
}));
vi.mock('@/components/HandwrittenTestGrading', () => ({
  HandwrittenTestGrading: ({ courseId }: { courseId: string }) => (
    <div data-testid="handwritten-grading">HandwrittenTestGrading:{courseId}</div>
  ),
}));
vi.mock('@/components/quiz/AssignedQuizzesBoard', () => ({
  AssignedQuizzesBoard: ({ courseId }: { courseId: string }) => (
    <div data-testid="assigned-quizzes-board">AssignedQuizzesBoard:{courseId}</div>
  ),
}));
vi.mock('@/components/CourseProgress', () => ({
  CourseProgress: () => <div data-testid="course-progress" />,
}));
// Student360 is now mounted one panel at a time (My Class takes evaluations and
// competencies, Data Bank takes interactions), so the stub echoes back which
// panels it was asked for.
vi.mock('@/components/Student360', () => ({
  default: ({ panels }: { panels?: string[] }) => (
    <div data-testid="student-360" data-panels={(panels ?? []).join(',')} />
  ),
}));
// The Class Performance nested tabs mount these read-only rosters; the stubs
// echo the course so the wiring (not the data fetch) is what's under test.
vi.mock('@/components/class-performance/QuizPerformanceList', () => ({
  QuizPerformanceList: ({ courseId }: { courseId: string }) => (
    <div data-testid="quiz-performance-list">QuizPerformanceList:{courseId}</div>
  ),
}));
vi.mock('@/components/class-performance/StudyGuidePerformanceList', () => ({
  StudyGuidePerformanceList: ({ courseId }: { courseId: string }) => (
    <div data-testid="guide-performance-list">StudyGuidePerformanceList:{courseId}</div>
  ),
}));
vi.mock('@/components/StudySessionManager', () => ({
  StudySessionManager: () => <div data-testid="study-session-manager" />,
}));
vi.mock('@/components/FlashcardManager', () => ({
  FlashcardManager: () => <div data-testid="flashcard-manager" />,
}));
vi.mock('@/components/CheatSheetViewer', () => ({
  default: () => <div data-testid="cheat-sheet-viewer" />,
}));
vi.mock('@/components/UnifiedQuestionBank', () => ({
  default: () => <div data-testid="unified-question-bank" />,
}));
vi.mock('@/components/AIInteractiveQuestions', () => ({
  default: () => <div data-testid="ai-interactive-questions" />,
}));
vi.mock('@/components/OpenQuestionChatHistory', () => ({
  default: () => <div data-testid="open-question-chat-history" />,
}));
vi.mock('@/components/QuizHistory', () => ({
  default: () => <div data-testid="quiz-history" />,
}));
vi.mock('@/components/QuestionFeedback', () => ({
  default: () => <div data-testid="question-feedback" />,
}));
// The real panel reports its competency count upward. The stub reports
// whatever `competenciesStubCount.current` holds, so a test can stand in for
// "the panel has seen a write this page has not".
const competenciesStubCount = vi.hoisted(() => ({ current: null as number | null }));
vi.mock('@/components/CourseCompetencies', () => {
  function CourseCompetenciesStub({ onCountChange }: { onCountChange?: (n: number) => void }) {
    React.useEffect(() => {
      if (competenciesStubCount.current !== null) onCountChange?.(competenciesStubCount.current);
    }, [onCountChange]);
    return <div data-testid="course-competencies" />;
  }
  return { default: CourseCompetenciesStub };
});
vi.mock('@/components/MaterialChaptersWizard', () => ({
  default: () => <div data-testid="material-chapters-wizard" />,
}));
vi.mock('@/components/FlashcardViewer', () => ({
  default: () => <div data-testid="flashcard-viewer" />,
}));
vi.mock('@/components/MaterialUploadDialog', () => ({
  MaterialUploadDialog: () => <div data-testid="material-upload-dialog" />,
  // The module is also the single source of truth for the material_type
  // vocabulary (#1019), which CoursePage reads directly.
  MATERIAL_TYPE_LABELS: {
    textbook: 'Textbook',
    teacher_companion: "Teacher's Companion",
    reference_exercises: 'Reference Exercises',
    images: 'Images',
    other: 'Other',
  },
  MATERIAL_TYPE_ORDER: [
    'textbook',
    'teacher_companion',
    'reference_exercises',
    'images',
    'other',
  ],
  CHAPTERLESS_MATERIAL_TYPES: ['images', 'other'],
  WHOLE_DOCUMENT_MATERIAL_TYPE: 'other',
}));
vi.mock('@/components/ImageUploadDialog', () => ({
  ImageUploadDialog: () => <div data-testid="image-upload-dialog" />,
}));
vi.mock('@/components/EditableChapterTitle', () => ({
  EditableChapterTitle: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock('@/components/TestsAssignmentView', () => ({
  TestsAssignmentView: () => <div data-testid="tests-assignment-view" />,
}));
vi.mock('@/components/ChapterStudyMaterialsManager', () => ({
  ChapterStudyMaterialsManager: () => <div data-testid="chapter-study-materials-manager" />,
}));
vi.mock('@/components/announcements', () => ({
  InstructorAnnouncementsTab: () => <div data-testid="announcements-tab" />,
  AnnouncementCard: () => <div />,
  AnnouncementEditorDialog: () => <div />,
  AnnouncementsSection: () => <div />,
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/course-notes', () => ({
  InstructorNotesTab: ({ courseId }: { courseId: string }) => (
    <div data-testid="notes-tab">InstructorNotesTab:{courseId}</div>
  ),
  StudentNotesList: () => <div />,
}));
vi.mock('@/components/PdfViewerWithExtract', () => ({
  PdfViewerWithExtract: () => <div data-testid="pdf-viewer" />,
}));
vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: '' },
}));

const course = {
  id: 'course-1',
  title: 'Test Course',
  description: 'desc',
  theme: null,
  leaderboard_enabled: false,
  student_questions_enabled: false,
  restrict_to_completed_chapters: false,
  show_difficulty_to_students: true,
  grade_level_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  competenciesStubCount.current = null;
  quizManagerProps.current = null;
  sgManagerProps.current = null;
  routeCourseId.current = 'course-1';
  // Default: admin
  userInstitutionResult.current = {
    membership: null,
    loading: false,
    institutionId: 'inst-123',
    role: 'admin',
    isAdmin: true,
    isInstructor: false,
    isStudent: false,
    refetch: vi.fn(),
  };

  mockFromImpl.mockImplementation((table: string) => {
    if (table === 'courses') {
      return createChainMock({ data: course, error: null });
    }
    return createChainMock({ data: [], error: null });
  });
});

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

async function renderCoursePage(route = '/course/course-1') {
  const mod = await import('@/pages/CoursePage');
  const Component = mod.default;
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/course/:courseId" element={<Component />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CoursePage — top-level Assessments tab', () => {
  it('renders the Assessments top-level tab trigger for an admin/instructor', async () => {
    await renderCoursePage();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Assessments/i })).toBeInTheDocument();
    });
  });

  it('renders the Assessments tab when isInstructor is true and isAdmin is false', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'instructor',
      isAdmin: false,
      isInstructor: true,
      isStudent: false,
      refetch: vi.fn(),
    };

    await renderCoursePage();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Assessments/i })).toBeInTheDocument();
    });
  });

  it('does NOT render the Assessments top-level tab trigger for a student', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'student',
      isAdmin: false,
      isInstructor: false,
      isStudent: true,
      refetch: vi.fn(),
    };

    await renderCoursePage();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Class Management/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('tab', { name: /Assessments/i })).not.toBeInTheDocument();
  });

  it('positions the Assessments tab between Learning Design and Data Bank', async () => {
    await renderCoursePage();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Assessments/i })).toBeInTheDocument();
    });

    const learningDesign = screen.getByRole('tab', { name: /Learning Design/i });
    const assessments = screen.getByRole('tab', { name: /^Assessments$/i });
    const dataBank = screen.getByRole('tab', { name: /^Data Bank$/i });

    // DOCUMENT_POSITION_FOLLOWING === 4
    expect(learningDesign.compareDocumentPosition(assessments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(assessments.compareDocumentPosition(dataBank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders QuizManager (with courseId) when the Assessments tab is selected', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    const assessmentsTab = await screen.findByRole('tab', { name: /^Assessments$/i });
    await user.click(assessmentsTab);

    await waitFor(() => {
      expect(screen.getByTestId('quiz-manager')).toHaveTextContent('QuizManager:course-1');
    });
  });

  it('no longer renders an Assessments sub-tab inside Class Management', async () => {
    await renderCoursePage();

    await screen.findByRole('tab', { name: /Class Management/i });

    // Class Management is the default first tab, so its sub-tabs are visible without clicking.
    // The only Assessments tab in the document should remain the top-level one.
    const assessmentsTabs = screen.getAllByRole('tab', { name: /^Assessments$/i });
    expect(assessmentsTabs).toHaveLength(1);
  });
});

describe('CoursePage — Notes and Competencies placement', () => {
  // Notes sits under Course Materials (it IS course material); Competencies is
  // a Class Management concern and sits in that row, directly beside Course
  // Materials because the two are authored together. Both are nested tabs, and
  // Radix pairs a TabsContent with the trigger of the same value in the SAME
  // Tabs root — so a trigger that moves rows without its panel silently renders
  // nothing. Hence the separate tests below that the panels still mount, which
  // is what a half-finished move would break.

  it('flags the Competencies tab when the course has no competencies', async () => {
    await renderCoursePage();

    const competencies = await screen.findByRole('tab', { name: /^Competencies$/i });

    await waitFor(() => {
      expect(screen.getByTestId('competencies-empty-indicator')).toBeInTheDocument();
    });
    // The marker rides on the trigger itself, and must not alter its name —
    // every other test here finds this tab by /^Competencies$/.
    expect(competencies).toContainElement(screen.getByTestId('competencies-empty-indicator'));
  });

  it('does not flag the Competencies tab when the course has competencies', async () => {
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'courses') {
        return createChainMock({ data: course, error: null });
      }
      if (table === 'course_competencies') {
        // head:true count query — no rows, just the count.
        return createChainMock({ data: null, error: null, count: 3 });
      }
      return createChainMock({ data: [], error: null });
    });

    await renderCoursePage();

    await screen.findByRole('tab', { name: /^Competencies$/i });
    await waitFor(() => {
      expect(screen.queryByTestId('competencies-empty-indicator')).not.toBeInTheDocument();
    });
  });

  it('lets the panel win over a slower count query that started earlier', async () => {
    // The page's own head-count is only a bootstrap. If it is still in flight
    // while the panel persists a competency, its pre-insert snapshot must not
    // land on top of what the panel has since reported.
    let releaseCount: () => void = () => {};
    const countLanded = new Promise<void>(resolve => {
      releaseCount = resolve;
    });

    competenciesStubCount.current = 2;
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'courses') {
        return createChainMock({ data: course, error: null });
      }
      if (table === 'course_competencies') {
        const result = { data: null, error: null, count: 0 };
        const chain = createChainMock(result);
        chain.then = vi.fn((cb: (val: ChainResult) => void) =>
          countLanded.then(() => cb(result))
        );
        return chain;
      }
      return createChainMock({ data: [], error: null });
    });

    const user = userEvent.setup();
    await renderCoursePage();

    // Open the tab so the panel actually mounts and reports — that is the
    // situation the stale query has to lose.
    await user.click(await screen.findByRole('tab', { name: /^Competencies$/i }));
    await screen.findByTestId('course-competencies');
    expect(screen.queryByTestId('competencies-empty-indicator')).not.toBeInTheDocument();

    await act(async () => {
      releaseCount();
      await countLanded;
    });

    // The stale 0 must not resurrect the marker.
    expect(screen.queryByTestId('competencies-empty-indicator')).not.toBeInTheDocument();
  });

  it('re-reads the count for a course revisited later', async () => {
    // A → B → A. The stamp left by A's panel on the first visit must not make
    // the page ignore A's fresh read on the second: the count can have changed
    // while the instructor was away.
    competenciesStubCount.current = 2;
    const { rerender } = await renderCoursePage();

    await screen.findByRole('tab', { name: /^Competencies$/i });
    // Mount the panel so it stamps course-1 as reported.
    await userEvent.setup().click(screen.getByRole('tab', { name: /^Competencies$/i }));
    await screen.findByTestId('course-competencies');
    expect(screen.queryByTestId('competencies-empty-indicator')).not.toBeInTheDocument();

    // Away to another course, then back. The panel does not report again (the
    // tab is closed), and course-2 has competencies while course-1 has since
    // lost its own — so only a page that re-reads on the revisit gets it right.
    competenciesStubCount.current = null;
    let countQueries = 0;
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'courses') return createChainMock({ data: course, error: null });
      if (table === 'course_competencies') {
        countQueries += 1;
        return createChainMock({
          data: null,
          error: null,
          count: countQueries === 1 ? 2 : 0,
        });
      }
      return createChainMock({ data: [], error: null });
    });

    const mod = await import('@/pages/CoursePage');
    const Component = mod.default;
    const tree = (
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={['/course/course-1']}>
          <Routes>
            <Route path="/course/:courseId" element={<Component />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    routeCourseId.current = 'course-2';
    rerender(tree);
    routeCourseId.current = 'course-1';
    rerender(tree);

    await waitFor(() => {
      expect(screen.getByTestId('competencies-empty-indicator')).toBeInTheDocument();
    });
  });

  it('renders Competencies immediately after Course Materials', async () => {
    await renderCoursePage();

    const competencies = await screen.findByRole('tab', { name: /^Competencies$/i });

    // The Class Management row — the one holding Course Materials, not the
    // nested Textbooks/Notes list.
    const list = competencies.closest('[role="tablist"]') as HTMLElement;
    const materials = within(list).getByRole('tab', { name: /Course Materials/i });

    const siblings = Array.from(list.querySelectorAll('[role="tab"]'));
    expect(siblings.indexOf(competencies)).toBe(siblings.indexOf(materials) + 1);
  });

  it('renders Notes inside Course Materials, after Textbooks & Images', async () => {
    await renderCoursePage();

    const notes = await screen.findByRole('tab', { name: /^Notes$/i });
    const textbooks = screen.getByRole('tab', { name: /Textbooks & Images/i });

    expect(
      textbooks.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Same tablist as Textbooks & Images — i.e. the nested Course Materials
    // row, not the Class Management one it used to live in.
    expect(notes.closest('[role="tablist"]')).toBe(textbooks.closest('[role="tablist"]'));
  });

  it('renders InstructorNotesTab (with courseId) when Notes is selected', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    await user.click(await screen.findByRole('tab', { name: /^Notes$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('notes-tab')).toHaveTextContent(
        'InstructorNotesTab:course-1'
      );
    });
  });

  it('renders CourseCompetencies when Competencies is selected', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    await user.click(await screen.findByRole('tab', { name: /^Competencies$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('course-competencies')).toBeInTheDocument();
    });
  });

  it('renders neither sub-tab for a student', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'student',
      isAdmin: false,
      isInstructor: false,
      isStudent: true,
      refetch: vi.fn(),
    };

    await renderCoursePage();

    await screen.findByRole('tab', { name: /Class Management/i });
    expect(screen.queryByRole('tab', { name: /^Notes$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Competencies$/i })).not.toBeInTheDocument();
  });
});

describe('CoursePage — Class Management tab', () => {
  it('renders Class Management directly after My Class, ahead of Learning Design', async () => {
    await renderCoursePage();

    const classManagement = await screen.findByRole('tab', { name: /Class Management/i });
    const myClass = screen.getByRole('tab', { name: /^My Class$/i });
    const learningDesign = screen.getByRole('tab', { name: /Learning Design/i });

    expect(myClass.compareDocumentPosition(classManagement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(classManagement.compareDocumentPosition(learningDesign) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does NOT render a Classwork or Course Materials top-level tab anymore', async () => {
    await renderCoursePage();

    await screen.findByRole('tab', { name: /Class Management/i });

    expect(screen.queryByRole('tab', { name: /^Classwork$/i })).not.toBeInTheDocument();
    // The only "Course Materials" tab should be the sub-tab inside Class Management.
    const courseMaterialsTabs = screen.queryAllByRole('tab', { name: /Course Materials/i });
    expect(courseMaterialsTabs).toHaveLength(1);
  });

  it('renders Class Management for a student with Course Materials as a sub-tab', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'student',
      isAdmin: false,
      isInstructor: false,
      isStudent: true,
      refetch: vi.fn(),
    };

    await renderCoursePage();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Class Management/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: /Course Materials/i })).toBeInTheDocument();

    // Students do not get the management-only sub-tabs.
    expect(screen.queryByRole('tab', { name: /Section Progress/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Announcements/i })).not.toBeInTheDocument();
  });

  it('renders Course Materials, Section Progress, and Announcements sub-tabs for an instructor', async () => {
    await renderCoursePage();

    await screen.findByRole('tab', { name: /Class Management/i });

    expect(screen.getByRole('tab', { name: /Course Materials/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Section Progress/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Announcements/i })).toBeInTheDocument();
  });
});

describe('CoursePage — Question Bank is unified (#621)', () => {
  it('does NOT render the 5 per-type sub-tabs inside Question Bank', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    const learningDesign = await screen.findByRole('tab', { name: /Learning Design/i });
    await user.click(learningDesign);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Question Bank/i })).toBeInTheDocument();
    });

    // The 5 legacy sub-tab triggers must be gone — they were:
    // Multiple Choice Questions, Open Questions, Fill the Gaps, Ordering, Classification.
    expect(
      screen.queryByRole('tab', { name: /Multiple Choice Questions/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /^Open Questions$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /^Fill the Gaps$/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Ordering$/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: /^Classification$/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the UnifiedQuestionBank inside the Question Bank tab', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    const learningDesign = await screen.findByRole('tab', { name: /Learning Design/i });
    await user.click(learningDesign);

    await waitFor(() => {
      expect(screen.getByTestId('unified-question-bank')).toBeInTheDocument();
    });
  });
});

describe('CoursePage — Learning Design AI Chatbots sub-tab (#618, #660)', () => {
  it('renders the AI Interactive Questions sub-tab inside the AI Chatbots group', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    const learningDesign = await screen.findByRole('tab', { name: /Learning Design/i });
    await user.click(learningDesign);

    const aiChatbots = await screen.findByRole('tab', { name: /^AI Chatbots$/i });
    await user.click(aiChatbots);

    await waitFor(() => {
      expect(
        screen.getByRole('tab', { name: /^AI Interactive Questions$/i }),
      ).toBeInTheDocument();
    });
  });

  it('positions the AI Interactive Questions sub-tab after Tutoring Sessions inside AI Chatbots', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    const learningDesign = await screen.findByRole('tab', { name: /Learning Design/i });
    await user.click(learningDesign);

    const aiChatbots = await screen.findByRole('tab', { name: /^AI Chatbots$/i });
    await user.click(aiChatbots);

    const studySessions = await screen.findByRole('tab', { name: /^Tutoring Sessions$/i });
    const aiInteractive = screen.getByRole('tab', { name: /^AI Interactive Questions$/i });

    expect(
      studySessions.compareDocumentPosition(aiInteractive) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders the AIInteractiveQuestions component when the sub-tab is selected', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    const learningDesign = await screen.findByRole('tab', { name: /Learning Design/i });
    await user.click(learningDesign);

    const aiChatbots = await screen.findByRole('tab', { name: /^AI Chatbots$/i });
    await user.click(aiChatbots);

    const aiInteractive = await screen.findByRole('tab', {
      name: /^AI Interactive Questions$/i,
    });
    await user.click(aiInteractive);

    await waitFor(() => {
      expect(screen.getByTestId('ai-interactive-questions')).toBeInTheDocument();
    });
  });
});

/**
 * Where a material comes from, and what it is.
 *
 * Two rules about the materials surface, both about a material's *type* being
 * a property of what it is rather than a label put on afterwards:
 *
 *  - All three ways in ("Upload PDF", "Add Image", "From a link") sit
 *    together in the card header; what a material becomes is decided by the
 *    control used, not where it sits. A link import is still filed under
 *    "Other" (`UrlImportDialog` writes `WHOLE_DOCUMENT_MATERIAL_TYPE`), and
 *    the group headers themselves carry no controls.
 *  - The type decides how a material is prepared, not merely how it is filed:
 *    a textbook is split into chapters and synced chapter by chapter, while
 *    "Images" and "Other" are attached whole. Retyping one after the fact
 *    leaves it prepared for the kind it no longer is, so the edit dialog shows
 *    the type and does not offer to change it.
 */
describe('CoursePage — course materials', () => {
  const material = {
    id: 'mat-1',
    file_name: 'rise-and-fall.md',
    title: 'The Rise and Fall of Agent Civilizations',
    file_path: 'course-1/rise-and-fall.md',
    file_size: 26_800,
    material_type: 'other',
    author: null,
    year: null,
    description: null,
    page_count: null,
    openai_file_id: null,
    source_url: 'https://www.dwarkesh.com/p/openai-huggingface',
    moderation_status: 'approved',
    created_at: '2026-09-07T08:00:00Z',
  };

  const withMaterials = (rows: unknown[]) => {
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'courses') return createChainMock({ data: course, error: null });
      if (table === 'course_materials') return createChainMock({ data: rows, error: null });
      return createChainMock({ data: [], error: null });
    });
  };

  /** The group header row for a material type, e.g. the one labelled "Other". */
  const groupHeader = (label: string) =>
    screen.getByText(label, { selector: 'p' }).parentElement as HTMLElement;

  it('offers "Add Image" and "From a link" beside "Upload PDF" in the card header', async () => {
    withMaterials([material]);
    await renderCoursePage();

    const fromLink = await screen.findByRole('button', { name: /From a link/i });
    const addImage = screen.getByRole('button', { name: /Add Image/i });
    const uploadPdf = screen.getByRole('button', { name: /Upload PDF/i });

    expect(uploadPdf.parentElement).toContainElement(addImage);
    expect(uploadPdf.parentElement).toContainElement(fromLink);

    // The header speaks for the whole list; the group headers carry no
    // controls of their own.
    expect(
      within(groupHeader('Other')).queryByRole('button', { name: /From a link/i }),
    ).not.toBeInTheDocument();
    expect(
      within(groupHeader('Images')).queryByRole('button'),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /From a link/i })).toHaveLength(1);
  });

  it('offers "From a link" in the empty state, with no beta badge', async () => {
    withMaterials([]);
    await renderCoursePage();

    const emptyState = (await screen.findByText(/No materials uploaded yet/i))
      .parentElement as HTMLElement;
    // Exactly two: one in the card header, one in the empty-state call to
    // action.
    const fromLinks = screen.getAllByRole('button', { name: /^From a link$/i });
    expect(fromLinks).toHaveLength(2);
    expect(
      within(emptyState).getAllByRole('button', { name: /^From a link$/i }),
    ).toHaveLength(1);
    expect(fromLinks.filter(b => !emptyState.contains(b))).toHaveLength(1);
    expect(screen.queryByText(/^beta$/i)).not.toBeInTheDocument();
  });

  it('does not offer it on the Textbook group', async () => {
    withMaterials([material]);
    await renderCoursePage();

    await screen.findByRole('button', { name: /From a link/i });

    expect(
      within(groupHeader('Textbook')).queryByRole('button', { name: /From a link/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a material's type in the edit dialog without offering to change it", async () => {
    const user = userEvent.setup();
    withMaterials([material]);
    await renderCoursePage();

    await user.click(await screen.findByRole('button', { name: /^Edit$/i }));

    // The type is still worth reading — it is why the material behaves as it
    // does — but it is not a control.
    const shown = await screen.findByTestId('edit-material-type');
    expect(shown).toHaveTextContent('Other');
    expect(shown.tagName).not.toBe('BUTTON');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('leaves the type alone when the metadata is saved', async () => {
    const user = userEvent.setup();
    const chain = createChainMock({ data: [{ ...material, title: 'Renamed' }], error: null });
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'courses') return createChainMock({ data: course, error: null });
      if (table === 'course_materials') return chain;
      return createChainMock({ data: [], error: null });
    });
    await renderCoursePage();

    await user.click(await screen.findByRole('button', { name: /^Edit$/i }));
    await user.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => expect(chain.update).toHaveBeenCalled());
    // A write that named the type would put the reclassification this dialog
    // no longer offers back on the table.
    const written = (chain.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(written).not.toHaveProperty('material_type');
  });

  it('takes the type from the row it wrote, not from what it opened with', async () => {
    // Nothing here writes the type any more, so the database is its only
    // author — and someone else may have changed it (CourseDetail still
    // reclassifies) while this dialog sat open. Trusting the captured value
    // would file the material under the wrong group until a reload.
    const user = userEvent.setup();
    // The load sees "Other"; the row the update writes comes back as
    // "Textbook", as it would if someone had reclassified it in between.
    const reclassified = { ...material, title: 'Renamed', material_type: 'textbook' };
    let written = false;
    const chain = createChainMock({ data: [material], error: null });
    chain.update = vi.fn(() => {
      written = true;
      return chain;
    });
    chain.then = vi.fn((cb: (val: ChainResult) => void) =>
      Promise.resolve(cb({ data: written ? [reclassified] : [material], error: null })),
    );
    mockFromImpl.mockImplementation((table: string) => {
      if (table === 'courses') return createChainMock({ data: course, error: null });
      if (table === 'course_materials') return chain;
      return createChainMock({ data: [], error: null });
    });
    await renderCoursePage();

    await user.click(await screen.findByRole('button', { name: /^Edit$/i }));
    await user.click(await screen.findByRole('button', { name: /Save Changes/i }));

    // Filed under the type the row came back with.
    await waitFor(() =>
      expect(groupHeader('Textbook').parentElement).toHaveTextContent('Renamed'),
    );
  });
});

describe('CoursePage — My Class and Data Bank', () => {
  it('renders My Class as the leftmost top-level tab', async () => {
    await renderCoursePage();

    const myClass = await screen.findByRole('tab', { name: /^My Class$/i });
    const classManagement = screen.getByRole('tab', { name: /Class Management/i });

    // DOCUMENT_POSITION_FOLLOWING === 4
    expect(myClass.compareDocumentPosition(classManagement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does NOT render My Class or Data Bank for a student', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'student',
      isAdmin: false,
      isInstructor: false,
      isStudent: true,
      refetch: vi.fn(),
    };

    await renderCoursePage();

    await screen.findByRole('tab', { name: /Class Management/i });

    expect(screen.queryByRole('tab', { name: /^My Class$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Data Bank$/i })).not.toBeInTheDocument();
  });

  it('puts Student 360 and Class Performance under My Class', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    await user.click(await screen.findByRole('tab', { name: /^My Class$/i }));

    // Student 360 is the default sub-tab and mounts only the evaluations panel.
    await waitFor(() => {
      expect(screen.getByTestId('student-360')).toHaveAttribute('data-panels', 'evaluations');
    });

    // The former Class Competencies sub-tab is now Class Performance…
    expect(screen.queryByRole('tab', { name: /^Class Competencies$/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Class Performance$/i }));

    // …whose default nested tab, Competencies, keeps the old page.
    await waitFor(() => {
      expect(screen.getByTestId('student-360')).toHaveAttribute('data-panels', 'competencies');
    });

    // The other two nested tabs mount the read-only performance rosters.
    await user.click(screen.getByRole('tab', { name: /^Quizzes$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('quiz-performance-list')).toHaveTextContent('QuizPerformanceList:course-1');
    });

    await user.click(screen.getByRole('tab', { name: /^Study Guides$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('guide-performance-list')).toHaveTextContent('StudyGuidePerformanceList:course-1');
    });
  });

  it('leaves Interactions and Evaluations under Data Bank', async () => {
    const user = userEvent.setup();
    await renderCoursePage();

    await user.click(await screen.findByRole('tab', { name: /^Data Bank$/i }));

    // Interactions is the default sub-tab and mounts only the interactions panel.
    await waitFor(() => {
      expect(screen.getByTestId('student-360')).toHaveAttribute('data-panels', 'interactions');
    });
    expect(screen.getByRole('tab', { name: /^Evaluations$/i })).toBeInTheDocument();

    // Student 360 moved out of this tab entirely.
    expect(screen.queryByRole('tab', { name: /^Student 360$/i })).not.toBeInTheDocument();
  });

  it('no longer renders a top-level Analytics tab', async () => {
    await renderCoursePage();

    await screen.findByRole('tab', { name: /^Data Bank$/i });

    expect(screen.queryByRole('tab', { name: /^Analytics$/i })).not.toBeInTheDocument();
  });
});

describe('CoursePage — ?tab / ?sub deep links (instructor home)', () => {
  it('lands on Assessments → Quizzes without a click', async () => {
    await renderCoursePage('/course/course-1?tab=assessments&sub=quizzes');

    await waitFor(() => {
      expect(screen.getByTestId('quiz-manager')).toHaveTextContent('QuizManager:course-1');
    });
  });

  it('lands on Class Management → Competencies without a click', async () => {
    await renderCoursePage('/course/course-1?tab=classwork&sub=competencies');

    await waitFor(() => {
      expect(screen.getByTestId('course-competencies')).toBeInTheDocument();
    });
  });

  it('falls back to the default tab on an unknown ?tab value', async () => {
    await renderCoursePage('/course/course-1?tab=bogus&sub=nonsense');

    // Class Management is the default first tab; its sub-tabs are visible
    // only when it is the selected one.
    expect(
      await screen.findByRole('tab', { name: /Course Materials/i })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('quiz-manager')).not.toBeInTheDocument();
  });

  it('ignores a ?sub that does not belong to the ?tab', async () => {
    await renderCoursePage('/course/course-1?tab=assessments&sub=competencies');

    // Falls back to the Assessments group's own default sub-tab, Quizzes.
    await waitFor(() => {
      expect(screen.getByTestId('quiz-manager')).toBeInTheDocument();
    });
  });

  it('lands on Course Materials → Notes via ?sub2 without a click', async () => {
    await renderCoursePage('/course/course-1?tab=classwork&sub=course-materials&sub2=notes');

    await waitFor(() => {
      expect(screen.getByTestId('notes-tab')).toHaveTextContent('InstructorNotesTab:course-1');
    });
  });

  it('lands on My Class → Class Performance → Quiz via ?sub2 without a click', async () => {
    await renderCoursePage('/course/course-1?tab=my-unit&sub=class-performance&sub2=quizzes');

    await waitFor(() => {
      expect(screen.getByTestId('quiz-performance-list')).toHaveTextContent('QuizPerformanceList:course-1');
    });
  });

  it('falls back to Textbooks & Images on an unknown ?sub2 value', async () => {
    await renderCoursePage('/course/course-1?tab=classwork&sub=course-materials&sub2=bogus');

    const textbooks = await screen.findByRole('tab', { name: /Textbooks & Images/i });
    expect(textbooks).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('notes-tab')).not.toBeInTheDocument();
  });

  it('ignores a ?sub2 pointing at a manager-only tab for a student', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'student',
      isAdmin: false,
      isInstructor: false,
      isStudent: true,
      refetch: vi.fn(),
    };

    await renderCoursePage('/course/course-1?tab=classwork&sub=course-materials&sub2=notes');

    // The student has no Notes trigger, so honoring the link would select a
    // tab with no visible trigger. They get the normal default view instead.
    const textbooks = await screen.findByRole('tab', { name: /Textbooks & Images/i });
    expect(textbooks).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: /^Notes$/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('notes-tab')).not.toBeInTheDocument();
  });

  it('ignores deep links entirely for a student (no empty tab body)', async () => {
    userInstitutionResult.current = {
      membership: null,
      loading: false,
      institutionId: 'inst-123',
      role: 'student',
      isAdmin: false,
      isInstructor: false,
      isStudent: true,
      refetch: vi.fn(),
    };

    await renderCoursePage('/course/course-1?tab=assessments&sub=quizzes');

    // The student has no Assessments trigger, so honoring the link would
    // select a tab with no content. Instead they get the normal default view.
    expect(
      await screen.findByRole('tab', { name: /Course Materials/i })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('quiz-manager')).not.toBeInTheDocument();
  });
});

/**
 * The ?guide= / ?quiz= analytics deep links are consumed ONCE (#1357).
 *
 * The managers unmount on every tab switch, so their internal consumed flag
 * cannot survive a return to the tab — the page must strip the param from the
 * URL the moment the manager reports consumption, or the analytics dialog
 * pops again on every visit. This describe pins the page's half of that
 * contract: only the consumed param is removed, the tab params survive, and
 * the prop a remounted manager would receive is null afterwards.
 */
describe('CoursePage — analytics deep links are stripped once consumed', () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location-search">{location.search}</div>;
  }

  async function renderWithProbe(route: string) {
    const mod = await import('@/pages/CoursePage');
    const Component = mod.default;
    return render(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route
              path="/course/:courseId"
              element={
                <>
                  <Component />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('drops only ?guide= when the study guide manager consumes it', async () => {
    await renderWithProbe('/course/course-1?tab=ai-tutoring&sub=study-guides&guide=g-1');

    const manager = await screen.findByTestId('study-guide-manager');
    expect(manager).toHaveAttribute('data-guide', 'g-1');

    act(() => {
      sgManagerProps.current!.onInitialResultsConsumed!();
    });

    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).not.toContain('guide=');
    });
    const search = screen.getByTestId('location-search').textContent!;
    // The tab selection params survive — only the one-shot param goes.
    expect(search).toContain('tab=ai-tutoring');
    expect(search).toContain('sub=study-guides');
    // What a remounted manager would now receive: nothing to reopen.
    expect(screen.getByTestId('study-guide-manager')).toHaveAttribute('data-guide', '');
  });

  it('drops only ?quiz= when the quiz manager consumes it', async () => {
    await renderWithProbe('/course/course-1?tab=assessments&sub=quizzes&quiz=q-1');

    const manager = await screen.findByTestId('quiz-manager');
    expect(manager).toHaveAttribute('data-quiz', 'q-1');

    act(() => {
      quizManagerProps.current!.onInitialReportConsumed!();
    });

    await waitFor(() => {
      expect(screen.getByTestId('location-search').textContent).not.toContain('quiz=');
    });
    const search = screen.getByTestId('location-search').textContent!;
    expect(search).toContain('tab=assessments');
    expect(search).toContain('sub=quizzes');
    expect(screen.getByTestId('quiz-manager')).toHaveAttribute('data-quiz', '');
  });
});
