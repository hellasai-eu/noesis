/**
 * The dashboard's per-course quiz count comes from the student's *assignments*,
 * not from `quizzes.is_published`.
 *
 * `is_published` is course-wide: it says the quiz exists as a real quiz, not
 * that anyone was given it. Counting the quizzes table directly credited a
 * student with every published quiz in the course — an instructor's unassigned
 * set, a cluster set aimed at other students, a follow-up practice set still
 * waiting to be released. This file pins the source of the count to
 * `offering_quizzes`, where RLS applies published_at + offering + group.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
 * Every table the dashboard touches. `offering_quizzes` carries the one
 * assignment the student actually has; the `quizzes` table deliberately holds
 * a second, unassigned quiz in the same course — the row a published-flag read
 * would wrongly pick up.
 */
const ROWS: Record<string, unknown[]> = {
  user_institutions: [
    { institution_id: "inst-1", user_id: "student-user-id", role: "student" },
  ],
  institutions: [
    {
      id: "inst-1",
      name: "Test School",
      slug: "test-school",
      logo_url: null,
      allow_self_enrollment: false,
      is_public: false,
      default_language: "en",
    },
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
  offerings: [{ id: "off-1", class_id: "class-1", course_id: "course-1" }],
  courses: [
    { id: "course-1", title: "Mathematics", description: null, theme: null },
  ],
  // One assigned + published quiz. Nothing else reaches this student.
  offering_quizzes: [
    {
      quiz_id: "quiz-assigned",
      due_date: null,
      published_at: "2020-01-01T00:00:00Z",
      quizzes: {
        id: "quiz-assigned",
        course_id: "course-1",
        due_date: null,
        quiz_questions: [{ count: 5 }],
      },
    },
  ],
  // The trap: two published quizzes course-wide, only one of them assigned.
  quizzes: [
    {
      id: "quiz-assigned",
      course_id: "course-1",
      due_date: null,
      quiz_questions: [{ count: 5 }],
    },
    {
      id: "quiz-unassigned",
      course_id: "course-1",
      due_date: null,
      quiz_questions: [{ count: 5 }],
    },
  ],
  quiz_answers: [],
  course_materials: [],
  study_sessions: [],
  questions: [],
};

const tablesQueried: string[] = [];
/** Every filter applied per table, as `method(arg0,arg1,…)` strings. */
const filtersByTable: Record<string, string[]> = {};

function chain(table: string) {
  tablesQueried.push(table);
  const filters = (filtersByTable[table] ??= []);
  const rows = ROWS[table] ?? [];
  const result = { data: rows, error: null };
  const c: Record<string, unknown> = {};
  for (const m of [
    "select", "insert", "update", "delete", "eq", "neq", "in", "not", "is",
    "or", "gt", "gte", "lt", "lte", "like", "ilike", "order", "limit", "range",
  ]) {
    c[m] = vi.fn((...args: unknown[]) => {
      filters.push(`${m}(${args.map((a) => JSON.stringify(a)).join(",")})`);
      return c;
    });
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

vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useNavigate: () => vi.fn(),
}));

async function renderDashboard() {
  const { default: StudentDashboard } = await import("@/pages/StudentDashboard");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StudentDashboard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("StudentDashboard — quizzes are counted from assignments", () => {
  beforeEach(async () => {
    tablesQueried.length = 0;
    for (const k of Object.keys(filtersByTable)) delete filtersByTable[k];
    window.localStorage.clear();
    clearSelectedInstitutionId();
    await i18n.changeLanguage("en");
    setSelectedInstitutionId("inst-1");
  });

  afterEach(() => {
    window.localStorage.clear();
    clearSelectedInstitutionId();
  });

  it("reads offering_quizzes, never the quizzes table, for the available count", async () => {
    await renderDashboard();

    // The page has rendered its course card, so the count pass has run. (By
    // test id: "Mathematics" is also the kicker on the quiz tile above.)
    await waitFor(
      () => expect(screen.getByTestId("course-card-course-1")).toBeInTheDocument(),
      { timeout: 10_000 },
    );

    // The student's assignments are the source…
    expect(tablesQueried).toContain("offering_quizzes");
    // …and the course-wide quizzes table is never read. Reading it is the
    // regression: it would credit this student with `quiz-unassigned` too,
    // and with any follow-up practice set not yet published to them.
    expect(tablesQueried).not.toContain("quizzes");
  }, 20_000);

  it("scopes the assignment read to the student's offerings and to published rows", async () => {
    await renderDashboard();

    await waitFor(() => expect(filtersByTable.offering_quizzes?.length).toBeTruthy(), {
      timeout: 10_000,
    });

    const filters = filtersByTable.offering_quizzes.join(" ");
    // Only offerings this student is enrolled in.
    expect(filters).toContain('in("offering_id",["off-1"])');
    // Only assignments that have actually been released. RLS enforces this
    // too (plus group membership), but the client must not depend on that
    // alone — an instructor reading the same page would see the drafts.
    expect(filters).toContain('not("published_at","is",null)');
  }, 20_000);
});
