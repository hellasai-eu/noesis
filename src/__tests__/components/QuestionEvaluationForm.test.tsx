/**
 * #668 — QuestionEvaluationForm tests.
 *
 * Verifies the per-question rubric form:
 *   - The conditional problem block is hidden by default and appears only
 *     when the verdict is `needs_fixing` or `reject`.
 *   - The sampling block follows the `showSampling` prop.
 *   - Submitting writes the right shape to `question_evaluations.upsert(…)`.
 *   - When an existing row is passed, the form pre-fills (verdict picked).
 */
import { createRef } from "react";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  QuestionEvaluationForm,
  type QuestionEvaluationFormHandle,
  type QuestionEvaluationRow,
} from "@/components/evaluator/QuestionEvaluationForm";
import type { UnifiedQuestion } from "@/lib/unified-question";

// Radix portals + sliders need pointer-capture + scrollIntoView shims in jsdom.
beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
});

const upsertMock = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => {
  return {
    supabase: {
      from: vi.fn(() => ({
        upsert: upsertMock,
      })),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// The form embeds `QuestionExpandedPanel` to render the question itself —
// stub it out so we don't have to mock LaTeX, diagrams, and per-type payloads.
vi.mock("@/components/question-bank/expanded", () => ({
  QuestionExpandedPanel: ({ question }: { question: UnifiedQuestion }) => (
    <div data-testid="expanded-panel-stub">{question.preview}</div>
  ),
}));

const baseQuestion: UnifiedQuestion = {
  id: "q-1",
  type: "mcq",
  preview: "What is 2+2?",
  searchText: "What is 2+2?",
  difficulty: "easy",
  authorName: null,
  createdBy: null,
  createdAt: "2026-06-01T00:00:00Z",
  hidden: false,
  upvotes: 0,
  downvotes: 0,
  competencies: [],
  chapters: [],
  raw: {
    question: "What is 2+2?",
    payload: null,
    answer_key: null,
    explanation: null,
    generation_rationale: null,
  },
};

function setupUpsertResolve(row: Partial<QuestionEvaluationRow>) {
  upsertMock.mockImplementation(() => ({
    select: () => ({
      single: () =>
        Promise.resolve({
          data: {
            id: "row-1",
            session_id: "sess-1",
            question_id: "q-1",
            evaluator_id: "u-1",
            verdict: "good",
            difficulty_confirmation: "correct",
            question_good: true,
            answer_good: true,
            clarity: 3,
            distractor_quality: 3,
            curriculum_alignment: 3,
            question_bank_alignment: 3,
            pedagogical_value: 3,
            language_appropriateness: 3,
            problem_categories: [],
            comment: null,
            was_sampled: false,
            cognitive_level: null,
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
            ...row,
          } as QuestionEvaluationRow,
          error: null,
        }),
    }),
  }));
}

beforeEach(() => {
  upsertMock.mockReset();
  window.localStorage.clear();
});

async function pickAllRequiredYesNoAnswers(user: ReturnType<typeof userEvent.setup>) {
  // 2 Ναι/Όχι questions (#690) — pick "Ναι" for each.
  await user.click(screen.getByLabelText("Ναι", { selector: "#question_good-yes" }));
  await user.click(screen.getByLabelText("Ναι", { selector: "#answer_good-yes" }));
}

describe("QuestionEvaluationForm", () => {
  it("hides the problem block until the verdict requires correction", async () => {
    const user = userEvent.setup();
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );

    expect(screen.queryByTestId("problem-block")).toBeNull();

    await user.click(screen.getByLabelText("Χρειάζεται διόρθωση"));

    expect(screen.getByTestId("problem-block")).toBeInTheDocument();
    expect(screen.getByText("Άλλο")).toBeInTheDocument();
  });

  it("renders the sampling block only when showSampling is true", () => {
    const { rerender } = render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );
    expect(screen.queryByTestId("sampling-block")).toBeNull();
    // Specialist ratings (#678) live inside the sampling block — hidden too.
    expect(screen.queryByTestId("rating-curriculum_alignment")).toBeNull();

    rerender(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={true}
        existing={null}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByTestId("sampling-block")).toBeInTheDocument();
    expect(screen.getByText("Ανάκληση")).toBeInTheDocument();
    // Specialist ratings are now visible alongside cognitive_level.
    expect(screen.getByTestId("rating-curriculum_alignment")).toBeInTheDocument();
    expect(screen.getByTestId("rating-distractor_quality")).toBeInTheDocument();
  });

  it("always shows the two core ratings (clarity + pedagogical_value) outside the sampling block", () => {
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );
    expect(screen.getByTestId("rating-clarity")).toBeInTheDocument();
    expect(screen.getByTestId("rating-pedagogical_value")).toBeInTheDocument();
  });

  it("submits the full payload with was_sampled=false when the block is hidden", async () => {
    const user = userEvent.setup();
    setupUpsertResolve({});
    const onSaved = vi.fn();
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={onSaved}
      />,
    );

    await user.click(screen.getByLabelText("Καλή"));
    await user.click(screen.getByLabelText("Σωστή"));
    await pickAllRequiredYesNoAnswers(user);
    await user.click(screen.getByTestId("submit-evaluation"));

    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    const [payload, opts] = upsertMock.mock.calls[0];
    expect(opts).toEqual({ onConflict: "evaluator_id,question_id" });
    expect(payload).toMatchObject({
      session_id: "sess-1",
      question_id: "q-1",
      evaluator_id: "u-1",
      verdict: "good",
      difficulty_confirmation: "correct",
      question_good: true,
      answer_good: true,
      // Core ratings always carry a number (slider default 3).
      clarity: 3,
      pedagogical_value: 3,
      // Specialist ratings are NULL when the sampling block is hidden (#678).
      distractor_quality: null,
      curriculum_alignment: null,
      question_bank_alignment: null,
      language_appropriateness: null,
      problem_categories: [],
      comment: null,
      was_sampled: false,
      cognitive_level: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("submits the specialist ratings (defaulting to 3) when the sampling block is shown", async () => {
    const user = userEvent.setup();
    setupUpsertResolve({ was_sampled: true, cognitive_level: "recall" });
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={true}
        existing={null}
        onSaved={() => {}}
      />,
    );

    await user.click(screen.getByLabelText("Καλή"));
    await user.click(screen.getByLabelText("Σωστή"));
    await pickAllRequiredYesNoAnswers(user);
    await user.click(screen.getByLabelText("Ανάκληση"));
    await user.click(screen.getByTestId("submit-evaluation"));

    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    const [payload] = upsertMock.mock.calls[0];
    expect(payload).toMatchObject({
      was_sampled: true,
      cognitive_level: "recall",
      clarity: 3,
      pedagogical_value: 3,
      distractor_quality: 3,
      curriculum_alignment: 3,
      question_bank_alignment: 3,
      language_appropriateness: 3,
    });
  });

  it("renders the always-on sections as labelled fieldsets (#679)", () => {
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );
    // Each visible group is a <fieldset> with its legend as the heading.
    const verdictSection = screen.getByTestId("section-verdict-difficulty");
    const correctness = screen.getByTestId("section-correctness");
    const quality = screen.getByTestId("section-quality");
    expect(verdictSection.tagName).toBe("FIELDSET");
    expect(correctness.tagName).toBe("FIELDSET");
    expect(quality.tagName).toBe("FIELDSET");
    expect(verdictSection).toHaveAccessibleName("Συνολική κρίση & δυσκολία");
    expect(correctness).toHaveAccessibleName("Έλεγχοι ορθότητας");
    expect(quality).toHaveAccessibleName("Αξιολόγηση ποιότητας");
  });

  it("submits the chosen rating value via the segmented control (#679)", async () => {
    const user = userEvent.setup();
    setupUpsertResolve({ clarity: 5 });
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );

    await user.click(screen.getByLabelText("Καλή"));
    await user.click(screen.getByLabelText("Σωστή"));
    await pickAllRequiredYesNoAnswers(user);
    // Tap the "5" segment on the clarity rating.
    await user.click(screen.getByTestId("rating-clarity-option-5"));
    expect(screen.getByTestId("rating-clarity-value")).toHaveTextContent("5");
    await user.click(screen.getByTestId("submit-evaluation"));

    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    expect(upsertMock.mock.calls[0][0]).toMatchObject({ clarity: 5 });
  });

  it("renders rating segments without a hard width cap on mobile (#681)", () => {
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );
    // Pre-#681 the toggle group was `max-w-md` (28rem) at every breakpoint,
    // which capped it wider than 375px viewports. Now `max-w-md` only applies
    // at sm+; mobile uses the full container width.
    const ratingGroup = screen.getByTestId("rating-clarity");
    expect(ratingGroup.className).toContain("w-full");
    expect(ratingGroup.className).toContain("sm:max-w-md");
    expect(ratingGroup.className).not.toMatch(/(?<!sm:)max-w-md/);
    // Each segment is touch-sized on mobile (h-11) and shrinks on sm+ (h-10).
    const segment = screen.getByTestId("rating-clarity-option-3");
    expect(segment.className).toContain("h-11");
    expect(segment.className).toContain("sm:h-10");
  });

  it("toggles a problem chip on and off (#679)", async () => {
    const user = userEvent.setup();
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );
    // Open the conditional block.
    await user.click(screen.getByLabelText("Χρειάζεται διόρθωση"));
    const chip = screen.getByTestId("problem-chip-content_error");
    expect(chip).toHaveAttribute("data-state", "off");
    await user.click(chip);
    expect(chip).toHaveAttribute("data-state", "on");
    await user.click(chip);
    expect(chip).toHaveAttribute("data-state", "off");
  });

  it("surfaces inline errors on submit-while-incomplete and clears them as fields fill (#679)", async () => {
    const user = userEvent.setup();
    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );

    // Submit with nothing filled — no upsert, but inline alerts appear and
    // the summary line reports the count.
    await user.click(screen.getByTestId("submit-evaluation"));
    expect(upsertMock).not.toHaveBeenCalled();
    const alerts = await screen.findAllByRole("alert");
    // 1 verdict + 1 difficulty + 2 yes/no = 4 required-field errors (#690).
    expect(alerts.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId("missing-summary")).toHaveTextContent("πεδία λείπουν");

    // Fill verdict — that field's error clears, the rest remain.
    await user.click(screen.getByLabelText("Καλή"));
    const verdictGroup = screen.getByTestId("verdict-group");
    expect(verdictGroup).not.toHaveAttribute("aria-invalid", "true");

    // Fill the remaining required fields → submit goes through.
    setupUpsertResolve({});
    await user.click(screen.getByLabelText("Σωστή"));
    await pickAllRequiredYesNoAnswers(user);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    await user.click(screen.getByTestId("submit-evaluation"));
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
  });

  // #680 — imperative handle for keyboard shortcuts: setVerdict() flips the
  // verdict the same way clicking the radio would, and submit() runs the
  // existing validation+upsert path without going through the button.
  it("exposes an imperative handle that sets the verdict and submits the form (#680)", async () => {
    const user = userEvent.setup();
    setupUpsertResolve({ verdict: "needs_fixing" });
    const ref = createRef<QuestionEvaluationFormHandle>();
    render(
      <QuestionEvaluationForm
        ref={ref}
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={null}
        onSaved={() => {}}
      />,
    );

    // setVerdict("needs_fixing") should flip the verdict — and side-effect:
    // the problem block becomes visible because that's the verdict-conditional
    // branch the form already had.
    ref.current!.setVerdict("needs_fixing");
    await waitFor(() => {
      expect(screen.getByTestId("problem-block")).toBeInTheDocument();
    });

    // Fill the remaining required fields, then submit via the handle.
    await user.click(screen.getByLabelText("Σωστή"));
    await pickAllRequiredYesNoAnswers(user);
    ref.current!.submit();
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    expect(upsertMock.mock.calls[0][0]).toMatchObject({ verdict: "needs_fixing" });
  });

  it("pre-fills from an existing row so the form shows the prior selections", () => {
    const existing: QuestionEvaluationRow = {
      id: "row-1",
      session_id: "sess-old",
      question_id: "q-1",
      evaluator_id: "u-1",
      verdict: "reject",
      difficulty_confirmation: "harder",
      question_good: false,
      answer_good: false,
      clarity: 2,
      distractor_quality: 2,
      curriculum_alignment: 2,
      question_bank_alignment: 2,
      pedagogical_value: 2,
      language_appropriateness: 2,
      problem_categories: ["content_error"],
      comment: "needs work",
      was_sampled: false,
      cognitive_level: null,
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    };

    render(
      <QuestionEvaluationForm
        question={baseQuestion}
        sessionId="sess-1"
        evaluatorId="u-1"
        showSampling={false}
        existing={existing}
        onSaved={() => {}}
      />,
    );

    // Verdict "reject" pre-selected → conditional block visible immediately.
    expect(screen.getByTestId("problem-block")).toBeInTheDocument();
    // Comment pre-fills.
    expect(screen.getByTestId("comment-input")).toHaveValue("needs work");
    // Rating sliders pre-fill — at least one shows "2".
    expect(screen.getByTestId("rating-clarity-value")).toHaveTextContent("2");
    // Submit button reads "Ενημέρωση" (update) instead of "Αποθήκευση".
    expect(screen.getByTestId("submit-evaluation")).toHaveTextContent("Ενημέρωση");
  });

  // #682 — draft autosave & optimistic save.
  describe("draft autosave + optimistic save (#682)", () => {
    it("persists in-progress input to localStorage and restores it on remount", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={() => {}}
        />,
      );

      // Touch a few fields without submitting — the form should treat
      // itself as dirty and stash the draft.
      await user.click(screen.getByLabelText("Καλή"));
      await user.click(screen.getByTestId("rating-clarity-option-5"));
      // Debounce is 250ms — wait for the write.
      await waitFor(() => {
        expect(
          window.localStorage.getItem("evaluator:draft:u-1:q-1"),
        ).not.toBeNull();
      });
      const draft = JSON.parse(
        window.localStorage.getItem("evaluator:draft:u-1:q-1") ?? "{}",
      );
      expect(draft.verdict).toBe("good");
      expect(draft.ratings.clarity).toBe(5);

      // Remount the form — the draft should win over the blank baseline.
      unmount();
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={() => {}}
        />,
      );
      // Verdict pre-selected from the draft → the conditional problem
      // block stays hidden (verdict is "good"), but the rating value is
      // 5 (not the default 3).
      expect(screen.getByTestId("rating-clarity-value")).toHaveTextContent("5");
      // Submit button still reads "Αποθήκευση" — no server-side existing row.
      expect(screen.getByTestId("submit-evaluation")).toHaveTextContent(
        "Αποθήκευση",
      );
    });

    it("renders an unsaved-changes indicator while the form is dirty and clears it after save", async () => {
      const user = userEvent.setup();
      setupUpsertResolve({});
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={() => {}}
        />,
      );

      // Clean on mount — no indicator.
      expect(screen.queryByTestId("unsaved-indicator")).toBeNull();

      await user.click(screen.getByLabelText("Καλή"));
      expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();

      // Fill the rest and submit; the indicator clears once the form is
      // optimistically saved (no longer dirty).
      await user.click(screen.getByLabelText("Σωστή"));
      await pickAllRequiredYesNoAnswers(user);
      await user.click(screen.getByTestId("submit-evaluation"));
      await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        expect(screen.queryByTestId("unsaved-indicator")).toBeNull();
      });
    });

    it("notifies the parent on dirty transitions via onDirtyChange", async () => {
      const user = userEvent.setup();
      const onDirtyChange = vi.fn();
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      );
      // Initial transition: clean (false). After picking verdict: dirty (true).
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      await user.click(screen.getByLabelText("Καλή"));
      await waitFor(() => {
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      });
    });

    it("calls onSaved optimistically before the upsert resolves", async () => {
      const user = userEvent.setup();
      // Long-tail promise — never resolves during the test, so onSaved can
      // only have fired from the optimistic path.
      let resolveUpsert: ((v: unknown) => void) | null = null;
      upsertMock.mockImplementation(() => ({
        select: () => ({
          single: () =>
            new Promise((resolve) => {
              resolveUpsert = resolve;
            }),
        }),
      }));
      const onSaved = vi.fn();
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={onSaved}
        />,
      );

      await user.click(screen.getByLabelText("Καλή"));
      await user.click(screen.getByLabelText("Σωστή"));
      await pickAllRequiredYesNoAnswers(user);
      await user.click(screen.getByTestId("submit-evaluation"));

      // Network promise is still pending; onSaved already fired with a
      // predicted row that mirrors the payload.
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const optimisticRow = onSaved.mock.calls[0][0];
      expect(optimisticRow).toMatchObject({
        question_id: "q-1",
        verdict: "good",
        difficulty_confirmation: "correct",
      });
      // Caller may still resolve the promise afterwards; flush so vitest
      // doesn't complain about unsettled work.
      resolveUpsert?.({ data: optimisticRow, error: null });
    });

    it("clears the local draft after a successful save", async () => {
      const user = userEvent.setup();
      setupUpsertResolve({});
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={() => {}}
        />,
      );
      await user.click(screen.getByLabelText("Καλή"));
      // Wait for the debounced draft write so we know it existed.
      await waitFor(() => {
        expect(
          window.localStorage.getItem("evaluator:draft:u-1:q-1"),
        ).not.toBeNull();
      });

      await user.click(screen.getByLabelText("Σωστή"));
      await pickAllRequiredYesNoAnswers(user);
      await user.click(screen.getByTestId("submit-evaluation"));

      await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
      await waitFor(() => {
        expect(
          window.localStorage.getItem("evaluator:draft:u-1:q-1"),
        ).toBeNull();
      });
    });

    it("rolls back via onSaveFailed and restores the draft when the upsert errors", async () => {
      const user = userEvent.setup();
      upsertMock.mockImplementation(() => ({
        select: () => ({
          single: () =>
            Promise.resolve({ data: null, error: { message: "boom" } }),
        }),
      }));
      const onSaved = vi.fn();
      const onSaveFailed = vi.fn();
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={onSaved}
          onSaveFailed={onSaveFailed}
        />,
      );

      await user.click(screen.getByLabelText("Καλή"));
      await user.click(screen.getByLabelText("Σωστή"));
      await pickAllRequiredYesNoAnswers(user);
      await user.click(screen.getByTestId("submit-evaluation"));

      // Optimistic onSaved still fires…
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      // …then onSaveFailed runs with `null` (no prior existing row).
      await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1));
      expect(onSaveFailed).toHaveBeenLastCalledWith(null);
      // The draft is restored so the user doesn't lose their input.
      await waitFor(() => {
        expect(
          window.localStorage.getItem("evaluator:draft:u-1:q-1"),
        ).not.toBeNull();
      });
      // Indicator returns once the save settles back to dirty.
      await waitFor(() => {
        expect(screen.getByTestId("unsaved-indicator")).toBeInTheDocument();
      });
    });

    it("reconciles the server row via onSaveConfirmed once the upsert resolves", async () => {
      const user = userEvent.setup();
      setupUpsertResolve({ id: "server-id", updated_at: "2026-06-02T00:00:00Z" });
      const onSaved = vi.fn();
      const onSaveConfirmed = vi.fn();
      render(
        <QuestionEvaluationForm
          question={baseQuestion}
          sessionId="sess-1"
          evaluatorId="u-1"
          showSampling={false}
          existing={null}
          onSaved={onSaved}
          onSaveConfirmed={onSaveConfirmed}
        />,
      );

      await user.click(screen.getByLabelText("Καλή"));
      await user.click(screen.getByLabelText("Σωστή"));
      await pickAllRequiredYesNoAnswers(user);
      await user.click(screen.getByTestId("submit-evaluation"));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onSaveConfirmed).toHaveBeenCalledTimes(1));
      expect(onSaveConfirmed.mock.calls[0][0]).toMatchObject({
        id: "server-id",
      });
    });
  });
});
