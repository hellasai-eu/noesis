/**
 * StudentDashboard renders from the catalogs, in both locales.
 *
 * Guards the two things string extraction alone does not: that the *institution
 * default* actually reaches the student surface without the student choosing
 * anything, and that an explicit choice then outranks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Trans } from "react-i18next";
import React from "react";

import i18n from "@/i18n";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { LocaleProvider } from "@/i18n/LocaleProvider";
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
    institutionId: "inst-greek",
    role: "student",
    isAdmin: false,
    isInstructor: false,
    isStudent: true,
    isEvaluator: false,
    refetch: vi.fn(),
  }),
}));

// The institution the student belongs to publishes Greek as its default.
vi.mock("@/hooks/useInstitutionConfig", () => ({
  useInstitutionConfig: (institutionId: string | null) => ({
    institutionType: "generic",
    schoolLevels: [],
    defaultLanguage: institutionId === "inst-greek" ? "el" : "en",
    academicPeriod: null,
    loading: false,
  }),
}));

/**
 * Table-aware rows.
 *
 * The dashboard only clears its loading spinner once `currentInstitution`
 * resolves, and that needs a membership *and* an institution row — returning `[]`
 * for everything leaves the page on its spinner forever and every assertion
 * fails for the wrong reason. Courses stay empty on purpose: the empty state is
 * the copy these tests read.
 */
const ROWS: Record<string, unknown[]> = {
  user_institutions: [
    { institution_id: "inst-greek", user_id: "student-user-id", role: "student" },
  ],
  institutions: [
    {
      id: "inst-greek",
      name: "Test School",
      slug: "test-school",
      logo_url: null,
      allow_self_enrollment: false,
      is_public: false,
      default_language: "el",
    },
  ],
};

function chain(table: string) {
  const rows = ROWS[table] ?? [];
  const result = { data: rows, error: null };
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
        <LocaleProvider>
          <StudentDashboard />
        </LocaleProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("StudentDashboard — locale", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    clearSelectedInstitutionId();
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    window.localStorage.clear();
    clearSelectedInstitutionId();
    await i18n.changeLanguage("en");
  });

  it("renders in Greek for a student who has chosen nothing, from the institution default", async () => {
    setSelectedInstitutionId("inst-greek");
    await renderDashboard();

    // The surface's summary line. Read rather than the greeting above it,
    // which is chosen by the hour of day and would assert something different
    // depending on when the suite runs.
    // The empty state waits on the enrolment query, so it is the one to wait
    // for; the summary line above it is already on screen by then.
    await waitFor(() =>
      expect(screen.getByText("Δεν υπάρχουν διαθέσιμα μαθήματα ακόμα")).toBeInTheDocument()
    );
    expect(
      screen.getByText("Δεν εκκρεμεί τίποτα — καλή ευκαιρία να προχωρήσεις.")
    ).toBeInTheDocument();
  });

  it("renders in English when the student has explicitly chosen it", async () => {
    // Same Greek institution — but the student's own choice outranks it.
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    setSelectedInstitutionId("inst-greek");

    await renderDashboard();

    await waitFor(() =>
      expect(screen.getByText("No courses available yet")).toBeInTheDocument()
    );
    expect(
      screen.getByText("Nothing is due — a good evening to get ahead.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Δεν εκκρεμεί τίποτα — καλή ευκαιρία να προχωρήσεις.")
    ).not.toBeInTheDocument();
  });

  it("offers the language switcher in the student nav", async () => {
    setSelectedInstitutionId("inst-greek");
    await renderDashboard();

    await waitFor(() =>
      expect(screen.getByTestId("language-switcher")).toBeInTheDocument()
    );
  });
});

describe("the welcome line's <Trans> markup", () => {
  // The dashboard only renders this line for a student with enrolled classes,
  // which the mocks above deliberately do not set up. Exercised directly instead
  // because it is the one string carrying component markup: if a catalog loses
  // its `<1>` the tag renders as literal text, and if it loses `{{name}}` the
  // student is greeted by nobody.
  function Welcome({ name }: { name: string }) {
    return (
      <Trans
        i18nKey="student:dashboard.welcome"
        values={{ name }}
        components={{ 1: <span data-testid="welcome-name" /> }}
      />
    );
  }

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("puts the name inside the styled slot, in English", async () => {
    await i18n.changeLanguage("en");
    render(<Welcome name="Test Student" />);

    expect(screen.getByTestId("welcome-name")).toHaveTextContent("Test Student");
    expect(screen.getByText(/Welcome,/)).toBeInTheDocument();
    expect(screen.queryByText(/<1>/)).not.toBeInTheDocument();
  });

  it("puts the name inside the styled slot, in Greek", async () => {
    await i18n.changeLanguage("el");
    render(<Welcome name="Test Student" />);

    expect(screen.getByTestId("welcome-name")).toHaveTextContent("Test Student");
    expect(screen.getByText(/Καλώς ήρθες,/)).toBeInTheDocument();
    expect(screen.queryByText(/<1>/)).not.toBeInTheDocument();
  });
});
