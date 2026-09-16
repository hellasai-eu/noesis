import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const questionInserts: Array<Record<string, unknown>> = [];
const junctionInserts: Array<{ table: string; rows: unknown }> = [];
const assignmentInserts: Array<Record<string, unknown>[]> = [];
/** Per-table insert error, so a test can fail exactly one write. */
let insertErrors: Record<string, { message: string } | null> = {};
// Quiz-mode chapter resolution (quiz_questions → question_chapters).
let quizQuestionRows: Array<{ question_id: string }> = [];
let questionChapterRows: Array<{ chapter_id: string }> = [];

vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => ({
    insert: (values: unknown) => {
      const error = insertErrors[table] ?? null;
      if (!error) {
        if (table === "questions") questionInserts.push(values as Record<string, unknown>);
        else if (table === "offering_questions")
          assignmentInserts.push(values as Record<string, unknown>[]);
        else junctionInserts.push({ table, rows: values });
      }
      return {
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ error })),
      };
    },
    select: () => {
      const chain: Record<string, (...a: unknown[]) => unknown> = {};
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => {
        const data =
          table === "quiz_questions"
            ? quizQuestionRows
            : table === "question_chapters"
              ? questionChapterRows
              : [];
        return Promise.resolve(resolve({ data, error: null }));
      };
      return chain;
    },
  });
  return {
    supabase: {
      from: vi.fn(from),
      auth: {
        getSession: vi.fn(async () => ({
          data: { session: { access_token: "tok" } },
        })),
        getUser: vi.fn(async () => ({ data: { user: { id: "instr-1" } } })),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { ClusterFollowupQuestionsDialog } from "@/components/analysis/ClusterFollowupQuestionsDialog";
import { toast } from "sonner";

const ITEM = {
  groupId: "grp-1",
  groupName: "Reversed subtraction — Numbers 1-10 follow ups",
  label: "Reversed subtraction",
  rationale: "Both reversed the difference.",
  summary: "Reteach on a number line.",
};

const GENERATED = {
  id: "q-1",
  question: "Why does 5 − 3 differ from 3 − 5?",
  model_answer: "Subtraction is not commutative.",
  difficulty: "medium",
  competency_ids: ["comp-1"],
  chapter_ids: ["ch-1"],
};

let fetchMock: ReturnType<typeof vi.fn>;

const renderDialog = (onOpenChange = vi.fn()) => {
  render(
    <ClusterFollowupQuestionsDialog
      open
      onOpenChange={onOpenChange}
      courseId="course-1"
      studyGuideId="guide-1"
      offeringId="off-1"
      items={[ITEM]}
    />,
  );
  return onOpenChange;
};

beforeEach(() => {
  questionInserts.length = 0;
  junctionInserts.length = 0;
  assignmentInserts.length = 0;
  insertErrors = {};
  quizQuestionRows = [];
  questionChapterRows = [];
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ questions: [GENERATED] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClusterFollowupQuestionsDialog", () => {
  it("generates a group-targeted interactive question from the guide and shows it", async () => {
    renderDialog();

    expect(await screen.findByText("Why does 5 − 3 differ from 3 − 5?")).toBeInTheDocument();

    // The request is study-guide-sourced and targeted at the created group,
    // so the model writes from the theory with the group as its audience.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      courseId: "course-1",
      numQuestions: 1,
      studyGuideId: "guide-1",
      group_id: "grp-1",
    });
    expect(body.specialInstructions).toContain("Reversed subtraction");
    expect(body.specialInstructions).toContain("Both reversed the difference.");

    // The row lands on the AI Chatbots surface: answering_mode "interactive",
    // with the group recorded as its provenance.
    await waitFor(() => expect(questionInserts.length).toBe(1));
    expect(questionInserts[0]).toMatchObject({
      id: "q-1",
      course_id: "course-1",
      generated_for_group_id: "grp-1",
      type: "open",
      payload: { answering_mode: "interactive" },
    });
    expect(junctionInserts).toContainEqual({
      table: "question_competencies",
      rows: [{ question_id: "q-1", competency_id: "comp-1" }],
    });
    expect(junctionInserts).toContainEqual({
      table: "question_chapters",
      rows: [{ question_id: "q-1", chapter_id: "ch-1" }],
    });

    // Nothing is assigned until the instructor says so.
    expect(assignmentInserts).toHaveLength(0);
  });

  it("assigns the question to the group on demand, then closes once all are done", async () => {
    const onOpenChange = renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("assign-followup-grp-1"));

    await waitFor(() => expect(assignmentInserts.length).toBe(1));
    expect(assignmentInserts[0][0]).toMatchObject({
      offering_id: "off-1",
      question_id: "q-1",
      group_id: "grp-1",
    });
    // Published immediately — the instructor just asked for exactly this.
    expect(assignmentInserts[0][0].published_at).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith(
      `Question assigned to ${ITEM.groupName}`,
    );
    // Every opted-in group is done, so the window closes itself.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("links to the AI Chatbots surface for the course", async () => {
    renderDialog();
    const link = await screen.findByRole("link", { name: /ai chatbots/i });
    expect(link).toHaveAttribute("href", "/course/course-1?tab=ai-tutoring&sub=ai-chatbots");
  });

  it("shows the failure and offers a retry when generation fails", async () => {
    fetchMock
      .mockImplementationOnce(async () => ({
        ok: false,
        json: async () => ({ error: "Theory not generated yet" }),
      }))
      .mockImplementation(async () => ({
        ok: true,
        json: async () => ({ questions: [GENERATED] }),
      }));

    renderDialog();
    const user = userEvent.setup();

    expect(await screen.findByText("Theory not generated yet")).toBeInTheDocument();
    expect(questionInserts).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Why does 5 − 3 differ from 3 − 5?")).toBeInTheDocument();
    await waitFor(() => expect(questionInserts.length).toBe(1));
  });

  it("warns when a provenance link fails, without failing the question", async () => {
    // The question row is committed first; a junction failure must not fail
    // the flow (a retry would duplicate the question) but must not pass
    // silently either — an unlinked question is invisible to filters.
    insertErrors = { question_competencies: { message: "RLS says no" } };
    renderDialog();

    expect(await screen.findByText("Why does 5 − 3 differ from 3 − 5?")).toBeInTheDocument();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringMatching(/linking it to its competencies failed/),
      ),
    );
    // Still assignable — the failure was bookkeeping, not the question.
    expect(screen.getByTestId("assign-followup-grp-1")).toBeEnabled();
  });

  it("quiz mode: generates from the quiz's chapters instead of a study guide", async () => {
    quizQuestionRows = [{ question_id: "qq-1" }, { question_id: "qq-2" }];
    questionChapterRows = [{ chapter_id: "ch-1" }, { chapter_id: "ch-2" }, { chapter_id: "ch-1" }];

    render(
      <ClusterFollowupQuestionsDialog
        open
        onOpenChange={vi.fn()}
        courseId="course-1"
        quizId="quiz-1"
        offeringId="off-1"
        items={[ITEM]}
      />,
    );

    expect(await screen.findByText("Why does 5 − 3 differ from 3 − 5?")).toBeInTheDocument();

    // The request is chapter-sourced (the quiz's distinct chapters), group-
    // targeted, and carries no study-guide id.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.studyGuideId).toBeUndefined();
    expect(body.chapterIds).toEqual(["ch-1", "ch-2"]);
    expect(body.group_id).toBe("grp-1");
  });

  it("quiz mode: fails cleanly when the quiz's questions have no chapters", async () => {
    quizQuestionRows = [{ question_id: "qq-1" }];
    questionChapterRows = [];

    render(
      <ClusterFollowupQuestionsDialog
        open
        onOpenChange={vi.fn()}
        courseId="course-1"
        quizId="quiz-1"
        offeringId="off-1"
        items={[ITEM]}
      />,
    );

    expect(
      await screen.findByText(/aren't linked to any course chapters/i),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(questionInserts).toHaveLength(0);
  });

  it("keeps the dialog open and the question assignable when the assign write fails", async () => {
    insertErrors = { offering_questions: { message: "RLS says no" } };
    const onOpenChange = renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("assign-followup-grp-1"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("RLS says no"));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Back to assignable — the failure is retryable, not terminal.
    expect(await screen.findByTestId("assign-followup-grp-1")).toBeEnabled();
  });
});
