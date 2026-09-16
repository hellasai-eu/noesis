/**
 * The student dashboard answers one question — "what do I owe?" — and then
 * hands over to the course pages.
 *
 * That is the whole design, so it is what this file pins: an assigned quiz
 * reaches the Quizzes shelf from `offering_quizzes` across every course the
 * student is taking, finished work does not appear at all, a study guide gets
 * its own shelf, and the course cards below navigate to the course page
 * rather than filtering in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import React from "react";

import i18n from "@/i18n";
import {
  clearSelectedInstitutionId,
  setSelectedInstitutionId,
} from "@/lib/selected-institution";

const mockUser = vi.hoisted(() => ({
  id: "student-user-id",
  email: "student@test.local",
  user_metadata: { full_name: "Test Student" },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: mockUser,
    session: { user: mockUser, access_token: "t", refresh_token: "r" },
    profile: {
      id: "profile-id",
      user_id: "student-user-id",
      full_name: "Test Student",
      email: "student@test.local",
    },
    loading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    updatePassword: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useUserInstitution", () => ({
  useUserInstitution: () => ({
    membership: null,
    loading: false,
    institutionId: "inst-1",
    role: "student",
    isAdmin: false,
    isInstructor: false,
    isStudent: true,
    isEvaluator: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/useInstitutionConfig", () => ({
  useInstitutionConfig: () => ({
    institutionType: "generic",
    schoolLevels: [],
    defaultLanguage: "en",
    academicPeriod: null,
    loading: false,
  }),
}));

/**
 * Two courses; an open quiz and a study guide in Mathematics, a completed
 * quiz in Physics. This mock answers every query for a table with the same
 * rows, so each fixture row is shaped to survive whichever filter the loader
 * applies to that table.
 */
const ROWS: Record<string, unknown[]> = {
  user_institutions: [
    { institution_id: "inst-1", user_id: "student-user-id", role: "student" },
  ],
  institutions: [
    { id: "inst-1", name: "Test School", slug: "test-school", logo_url: null, is_public: false },
  ],
  class_enrollments: [
    {
      class_id: "class-1",
      role: "student",
      classes: {
        id: "class-1",
        name: "1A",
        grade_level_id: null,
        section_name: "A",
        category: null,
        academic_period: null,
        institution_id: "inst-1",
        is_active: true,
      },
    },
  ],
  offerings: [
    { id: "off-1", class_id: "class-1", course_id: "course-1" },
    { id: "off-2", class_id: "class-1", course_id: "course-2" },
  ],
  courses: [
    { id: "course-1", title: "Mathematics", description: null, theme: null },
    { id: "course-2", title: "Physics", description: null, theme: null },
  ],
  offering_quizzes: [
    {
      id: "oq-1",
      offering_id: "off-1",
      quiz_id: "quiz-assigned",
      due_date: null,
      time_limit_override: null,
      published_at: "2020-01-01T00:00:00Z",
      closed_at: null,
      quizzes: {
        id: "quiz-assigned",
        course_id: "course-1",
        title: "Quadratic Equations",
        time_limit_minutes: 20,
        quiz_questions: [{ count: 12 }],
      },
    },
    // Already finished: must not reach the dashboard, and must not count on
    // the Physics course card.
    {
      id: "oq-2",
      offering_id: "off-2",
      quiz_id: "quiz-done",
      due_date: null,
      time_limit_override: null,
      published_at: "2020-01-01T00:00:00Z",
      closed_at: null,
      quizzes: {
        id: "quiz-done",
        course_id: "course-2",
        title: "Kinematics Warmup",
        time_limit_minutes: null,
        quiz_questions: [{ count: 5 }],
      },
    },
  ],
  quiz_sessions: [{ quiz_id: "quiz-done", status: "completed" }],
  quiz_answers: [],
  offering_study_guides: [
    {
      study_guide_id: "sg-1",
      offering_id: "off-1",
      due_date: null,
      study_guides: { id: "sg-1", title: "Algebra, step by step", course_id: "course-1" },
    },
  ],
  study_guide_pieces: [{ study_guide_id: "sg-1" }, { study_guide_id: "sg-1" }],
  study_guide_progress: [],
};

const tablesQueried: string[] = [];

function chain(table: string) {
  tablesQueried.push(table);
  const rows = ROWS[table] ?? [];
  const result = { data: rows, error: null, count: rows.length };
  const c: Record<string, unknown> = {};
  for (const m of [
    "select", "insert", "update", "delete", "eq", "neq", "in", "not", "is",
    "or", "gt", "gte", "lt", "lte", "like", "ilike", "order", "limit", "range",
  ]) {
    c[m] = vi.fn(() => c);
  }
  const one = { data: rows[0] ?? null, error: null };
  c.single = vi.fn().mockResolvedValue(one);
  c.maybeSingle = vi.fn().mockResolvedValue(one);
  c.then = vi.fn((cb: (v: unknown) => void) => Promise.resolve(cb(result)));
  return c;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn((table: string) => chain(table)),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: mockUser }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
    })),
    removeChannel: vi.fn(),
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: "http://x/i.png" } })),
      })),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useNavigate: () => navigateSpy,
}));

async function renderSurface() {
  const { default: StudentDashboard } = await import("@/pages/StudentDashboard");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StudentDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StudentDashboard — assigned work, then the timetable", () => {
  beforeEach(async () => {
    tablesQueried.length = 0;
    navigateSpy.mockReset();
    window.localStorage.clear();
    clearSelectedInstitutionId();
    await i18n.changeLanguage("en");
    setSelectedInstitutionId("inst-1");
  });

  afterEach(() => {
    window.localStorage.clear();
    clearSelectedInstitutionId();
  });

  it("puts an assigned quiz on the Quizzes shelf, with its own course named on it", async () => {
    await renderSurface();

    await waitFor(() => expect(screen.getByTestId("due-tile-quiz-oq-1")).toBeInTheDocument(), {
      timeout: 10_000,
    });
    const tile = screen.getByTestId("due-tile-quiz-oq-1");
    expect(screen.getByTestId("shelf-quizzes")).toContainElement(tile);
    expect(tile).toHaveTextContent("Quadratic Equations");
    // The course name is on the tile, so the hue is never the only signal.
    expect(tile).toHaveTextContent("Mathematics");
    expect(tile).toHaveTextContent("12 questions");
    // No hero any more: the shelf is due-date-ordered, the first tile is the
    // recommendation.
    expect(tile).toHaveAttribute("data-tone", "plain");
  }, 20_000);

  it("keeps finished work off the dashboard entirely", async () => {
    await renderSurface();

    await waitFor(() => expect(screen.getByTestId("due-tile-quiz-oq-1")).toBeInTheDocument(), {
      timeout: 10_000,
    });
    // The completed Physics quiz has no tile on any shelf; results live on
    // the course page.
    expect(screen.queryByTestId("due-tile-quiz-oq-2")).not.toBeInTheDocument();
  }, 20_000);

  it("puts an assigned study guide on its own shelf, apart from the quizzes", async () => {
    await renderSurface();

    await waitFor(
      () => expect(screen.getByTestId("study-guide-card-sg-1")).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    const card = screen.getByTestId("study-guide-card-sg-1");
    expect(screen.getByTestId("shelf-guides")).toContainElement(card);
    expect(screen.getByTestId("shelf-quizzes")).not.toContainElement(card);
  }, 20_000);

  it("renders a card per course that navigates, carrying what is still due there", async () => {
    await renderSurface();

    await waitFor(
      () => expect(screen.getByTestId("course-card-course-1")).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    // Mathematics owes a quiz and a guide; Physics owes nothing, because its
    // one quiz is finished.
    const maths = screen.getByTestId("course-card-course-1");
    expect(maths).toHaveTextContent("Mathematics");
    expect(maths).toHaveTextContent("1 quiz due");
    expect(maths).toHaveTextContent("1 guide due");
    const physics = screen.getByTestId("course-card-course-2");
    expect(physics).toHaveTextContent("All clear");

    // A course card is a link to the course page, not a filter.
    await userEvent.click(physics);
    expect(navigateSpy).toHaveBeenCalledWith("/student/course/course-2");
  }, 20_000);

  it("deep-links a quiz tile into the runner, not the course overview", async () => {
    await renderSurface();

    await waitFor(() => expect(screen.getByTestId("due-tile-quiz-oq-1")).toBeInTheDocument(), {
      timeout: 10_000,
    });

    await userEvent.click(screen.getByTestId("due-tile-quiz-oq-1"));

    expect(navigateSpy).toHaveBeenCalledWith("/student/course/course-1?quiz=quiz-assigned");
  }, 20_000);

  it("reads assignments, never the course-wide quizzes table", async () => {
    await renderSurface();

    await waitFor(() => expect(screen.getByTestId("due-tile-quiz-oq-1")).toBeInTheDocument(), {
      timeout: 10_000,
    });

    expect(tablesQueried).toContain("offering_quizzes");
    // `quizzes.is_published` is course-wide: reading it would credit this
    // student with sets that were never assigned to them.
    expect(tablesQueried).not.toContain("quizzes");
  }, 20_000);
});
