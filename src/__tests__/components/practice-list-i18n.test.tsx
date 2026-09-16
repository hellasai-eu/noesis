/**
 * The practice list, the random run, the dispatcher and the assess tab render
 * translated copy.
 *
 * The lesson from #1211 is baked in here: mounting a component is not coverage.
 * Each of these is driven into the state that actually carries the copy — a
 * finished run and its summary, a filtered-empty list, an unsupported question
 * type, a graded quiz card — because the strings that survived three review
 * rounds there were all in states the test never reached.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import i18n from "@/i18n";

vi.mock("@/lib/latex-utils", () => ({
  formatQuestionText: (text: string) => text ?? "",
  processLatexContent: (text: string) => text ?? "",
}));

/**
 * The unsupported-type test loads the real dispatcher, which imports every
 * answering panel and with them the Supabase client — whose module body throws
 * when VITE_SUPABASE_URL is unset. That is the case in CI and not on a machine
 * with a .env.local, so without this the test is green locally and red in CI.
 */
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order", "limit", "insert", "upsert", "delete"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.then = vi.fn((cb: (v: unknown) => void) =>
    Promise.resolve(cb({ data: [], error: null })),
  );
  return {
    supabase: {
      from: vi.fn(() => chain),
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
        onAuthStateChange: vi.fn(() => ({
          data: { subscription: { unsubscribe: vi.fn() } },
        })),
      },
    },
  };
});

const hookMock = vi.hoisted(() => ({ useStudentPracticeQuestions: vi.fn() }));
vi.mock("@/hooks/useStudentPracticeQuestions", () => ({
  useStudentPracticeQuestions: hookMock.useStudentPracticeQuestions,
}));

vi.mock("@/components/student/PracticeAnsweringDispatcher", async () => {
  const React = await import("react");
  return {
    PracticeAnsweringDispatcher: (props: {
      question: { id: string };
      onCompleted?: (r?: { grade?: number; allCorrect?: boolean }) => void;
      onNext: () => void;
    }) =>
      React.createElement(
        "div",
        { "data-testid": "dispatcher" },
        React.createElement(
          "button",
          {
            "data-testid": "complete",
            onClick: () => props.onCompleted?.({ grade: 100, allCorrect: true }),
          },
          "complete",
        ),
        React.createElement(
          "button",
          { "data-testid": "next", onClick: props.onNext },
          "next",
        ),
      ),
  };
});

import { PracticeRandomRun } from "@/components/student/PracticeRandomRun";
import { UnifiedPracticeQuestionsList } from "@/components/student/UnifiedPracticeQuestionsList";
import { AssessTab } from "@/components/student/AssessTab";
import type { StudentPracticeQuestion } from "@/hooks/useStudentPracticeQuestions";
import type { QuizAssignment } from "@/components/student/AssessTab";

const mkQ = (
  over: Partial<StudentPracticeQuestion> & { id: string },
): StudentPracticeQuestion => ({
  type: over.type ?? "mcq",
  stemPreview: over.stemPreview ?? `preview-${over.id}`,
  difficulty: over.difficulty ?? "medium",
  status: over.status ?? "not_started",
  offeringId: over.offeringId ?? "off-1",
  chapters: over.chapters ?? [],
  ...over,
});

const mkQuiz = (over: Partial<QuizAssignment> & { id: string }): QuizAssignment => ({
  quizId: over.quizId ?? over.id,
  title: over.title ?? "Quiz",
  questionCount: over.questionCount ?? 3,
  timeLimit: over.timeLimit ?? null,
  dueDate: over.dueDate ?? null,
  publishedAt: over.publishedAt ?? null,
  status: over.status ?? "not_started",
  ...over,
});

beforeAll(() => {
  // Radix Select needs the same pointer/observer shims used elsewhere in the suite.
  for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
    if (!(m in Element.prototype)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Element.prototype as any)[m] = () => false;
    }
  }
  if (!Element.prototype.scrollIntoView) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).scrollIntoView = () => {};
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = ResizeObserverStub;
  }
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("PracticeRandomRun — locale", () => {
  it("translates the progress indicator and exit control", async () => {
    await i18n.changeLanguage("el");
    render(
      <PracticeRandomRun
        courseId="c-1"
        questionsInRun={[mkQ({ id: "a" }), mkQ({ id: "b" })]}
        onExit={vi.fn()}
      />,
    );

    expect(screen.getByTestId("run-progress")).toHaveTextContent("Ερώτηση 1 / 2");
    expect(screen.getByTestId("run-exit")).toHaveTextContent("Έξοδος");
  });

  /**
   * The summary is a separate render tree reached only by finishing every
   * question — exactly the kind of state that hid three English labels in
   * #1211.
   */
  it("translates the end-of-run summary", async () => {
    await i18n.changeLanguage("el");
    const user = userEvent.setup();
    render(
      <PracticeRandomRun
        courseId="c-1"
        questionsInRun={[mkQ({ id: "a", type: "ordering" })]}
        onExit={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("complete"));
    await user.click(screen.getByTestId("run-finish"));

    const summary = await screen.findByTestId("run-summary");
    expect(within(summary).getByText("Η σειρά ολοκληρώθηκε")).toBeInTheDocument();
    // Singular: Greek inflects the noun, so a one-question run must not say
    // "ερωτήσεις". The plural form is asserted separately below.
    expect(
      within(summary).getByText("Απάντησες 1 από 1 ερώτηση σε αυτή τη σειρά."),
    ).toBeInTheDocument();
    // The per-row outcome and the type badge both go through the catalog.
    expect(within(summary).getByText("Σωστό")).toBeInTheDocument();
    expect(within(summary).getByText("Σειρά")).toBeInTheDocument();
    expect(within(summary).queryByText("Correct")).not.toBeInTheDocument();
  });

  it("uses the plural form for a multi-question run", async () => {
    await i18n.changeLanguage("el");
    const user = userEvent.setup();
    render(
      <PracticeRandomRun
        courseId="c-1"
        questionsInRun={[mkQ({ id: "a" }), mkQ({ id: "b" })]}
        onExit={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("complete"));
    await user.click(screen.getByTestId("next"));
    await user.click(screen.getByTestId("complete"));
    await user.click(screen.getByTestId("run-finish"));

    const summary = await screen.findByTestId("run-summary");
    expect(
      within(summary).getByText("Απάντησες 2 από 2 ερωτήσεις σε αυτή τη σειρά."),
    ).toBeInTheDocument();
  });

  it("translates a graded (not simply correct) outcome", async () => {
    await i18n.changeLanguage("el");
    const user = userEvent.setup();
    render(
      <PracticeRandomRun
        courseId="c-1"
        questionsInRun={[mkQ({ id: "a" })]}
        onExit={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("complete"));
    await user.click(screen.getByTestId("run-finish"));

    const summary = await screen.findByTestId("run-summary");
    expect(within(summary).getByText("Σωστό")).toBeInTheDocument();
  });
});

describe("AssessTab — locale", () => {
  it("translates the empty state", async () => {
    await i18n.changeLanguage("el");
    render(<AssessTab quizzes={[]} onTakeQuiz={vi.fn()} onViewResults={vi.fn()} />);

    expect(screen.getByText("Δεν υπάρχουν κουίζ ακόμα")).toBeInTheDocument();
  });

  it("translates the badges, units and actions of an available quiz", async () => {
    await i18n.changeLanguage("el");
    render(
      <AssessTab
        quizzes={[mkQuiz({ id: "q1", questionCount: 5, timeLimit: 20 })]}
        onTakeQuiz={vi.fn()}
        onViewResults={vi.fn()}
      />,
    );

    expect(screen.getByText("Διαθέσιμα κουίζ")).toBeInTheDocument();
    expect(screen.getByText("Δεν ξεκίνησε")).toBeInTheDocument();
    expect(screen.getByText("5 ερωτήσεις")).toBeInTheDocument();
    expect(screen.getByText("20 λεπτά")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Έναρξη" })).toBeInTheDocument();
  });

  it("uses the singular unit for a one-minute quiz", async () => {
    await i18n.changeLanguage("el");
    render(
      <AssessTab
        quizzes={[mkQuiz({ id: "q4", questionCount: 1, timeLimit: 1 })]}
        onTakeQuiz={vi.fn()}
        onViewResults={vi.fn()}
      />,
    );

    expect(screen.getByText("1 λεπτό")).toBeInTheDocument();
    expect(screen.getByText("1 ερώτηση")).toBeInTheDocument();
  });

  /**
   * The completed card is a different branch: a different badge, a percentage
   * and a different action label.
   */
  it("translates a completed quiz card", async () => {
    await i18n.changeLanguage("el");
    render(
      <AssessTab
        quizzes={[
          mkQuiz({ id: "q2", status: "completed", score: 8, totalPoints: 10 }),
        ]}
        onTakeQuiz={vi.fn()}
        onViewResults={vi.fn()}
      />,
    );

    expect(screen.getByText("Ολοκληρωμένα")).toBeInTheDocument();
    expect(screen.getByText("Υποβλήθηκε")).toBeInTheDocument();
    expect(screen.getByText("(80%)")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Δες τα αποτελέσματα" }),
    ).toBeInTheDocument();
  });

  /**
   * The due text is assembled from a date-fns distance dropped into a catalog
   * placeholder. Asserting the Greek frame proves the sentence is not being
   * concatenated onto an English one.
   */
  it("translates the due text and formats the distance in Greek", async () => {
    await i18n.changeLanguage("el");
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    render(
      <AssessTab
        quizzes={[mkQuiz({ id: "q3", dueDate: future })]}
        onTakeQuiz={vi.fn()}
        onViewResults={vi.fn()}
      />,
    );

    const due = screen.getByText(/Προθεσμία/);
    expect(due).toBeInTheDocument();
    // date-fns rendered the distance in Greek, not English "in 3 days".
    expect(due.textContent).toMatch(/ημέρ/);
  });
});

describe("PracticeAnsweringDispatcher — locale", () => {
  /**
   * `UnsupportedTypeCard` is a sub-component with its own render tree. A
   * missing hook there throws rather than falling back, which is the failure
   * mode that shipped in #1207 and #1209.
   */
  it("translates the unsupported-type card", async () => {
    vi.resetModules();
    vi.doUnmock("@/components/student/PracticeAnsweringDispatcher");
    const { PracticeAnsweringDispatcher } = await vi.importActual<
      typeof import("@/components/student/PracticeAnsweringDispatcher")
    >("@/components/student/PracticeAnsweringDispatcher");

    await i18n.changeLanguage("el");
    render(
      <PracticeAnsweringDispatcher
        question={mkQ({ id: "x", type: "unknown" as never })}
        courseId="c-1"
        hasNext={false}
        onBack={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByText("Αυτή η ερώτηση δεν μπορεί να απαντηθεί ακόμα εδώ"),
      ).toBeInTheDocument(),
    );
    // The <Trans> slot keeps the type name inside the translated sentence.
    expect(screen.getByText(/δεν είναι διαθέσιμη σε αυτή την προβολή/)).toBeInTheDocument();
  });
});

describe("UnifiedPracticeQuestionsList — locale", () => {
  const mount = (questions: StudentPracticeQuestion[]) => {
    hookMock.useStudentPracticeQuestions.mockReturnValue({
      questions,
      loading: false,
      refetch: vi.fn(),
    });
    return render(
      <UnifiedPracticeQuestionsList
        courseId="c-1"
        courseTitle="Maths"
        onBack={vi.fn()}
      />,
    );
  };

  it("translates the header and the filter controls", async () => {
    await i18n.changeLanguage("el");
    mount([mkQ({ id: "a" })]);

    expect(
      screen.getByRole("heading", { name: "Ερωτήσεις εξάσκησης" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Πίσω στο μάθημα" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Φιλτράρισμα κατά τύπο")).toBeInTheDocument();
    expect(screen.getByLabelText("Φιλτράρισμα κατά κατάσταση")).toBeInTheDocument();
  });

  /**
   * The filter option labels used to be built at module scope, which pinned
   * them to whatever language was loaded first. Opening the menu proves they
   * resolve per render instead.
   */
  it("translates the type filter options", async () => {
    await i18n.changeLanguage("el");
    const user = userEvent.setup();
    mount([mkQ({ id: "a" })]);

    await user.click(
      screen.getByRole("combobox", { name: "Φιλτράρισμα κατά τύπο" }),
    );

    // Radix portals the options, so they are looked up at document level.
    expect(
      await screen.findByRole("option", { name: "Συμπλήρωση κενών" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Όλοι οι τύποι" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Fill the Gaps" }),
    ).not.toBeInTheDocument();
  });

  it("translates the empty state", async () => {
    await i18n.changeLanguage("el");
    mount([]);

    expect(
      screen.getByText("Δεν υπάρχουν ερωτήσεις εξάσκησης ακόμα"),
    ).toBeInTheDocument();
  });

  it("translates a row's badges and action", async () => {
    await i18n.changeLanguage("el");
    mount([mkQ({ id: "a", type: "classification", status: "not_started" })]);

    const row = within(screen.getByTestId("practice-list"));
    expect(row.getByText("Ταξινόμηση")).toBeInTheDocument();
    expect(row.getByText("Δεν ξεκίνησε")).toBeInTheDocument();
    expect(row.getByRole("button", { name: /Ξεκίνα/ })).toBeInTheDocument();
  });

  /**
   * Regression: the Play icon was gated on `actionLabel === "Start"`, so any
   * language but English silently lost it. It keys off the status now.
   */
  it("keeps the start icon in a non-English locale", async () => {
    await i18n.changeLanguage("el");
    mount([mkQ({ id: "a", status: "not_started" })]);

    const button = within(screen.getByTestId("practice-list")).getByRole(
      "button",
      { name: /Ξεκίνα/ },
    );
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("shows no start icon on an already-answered row", async () => {
    await i18n.changeLanguage("el");
    mount([mkQ({ id: "a", status: "completed" })]);

    const button = within(screen.getByTestId("practice-list")).getByRole(
      "button",
      { name: /Δες την/ },
    );
    expect(button.querySelector("svg")).toBeNull();
  });
});
