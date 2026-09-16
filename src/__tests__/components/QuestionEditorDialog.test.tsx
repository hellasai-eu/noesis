import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Component test for the unified editor dialog (#1001). Pins the two behaviours
 * that matter beyond the per-type validation core (covered in
 * lib/question-editor.test.ts): an invalid edit is blocked *before* any write,
 * and a valid edit persists through the `update_question_content` RPC with the
 * built columns.
 */

type Result = { data: unknown; error: unknown };

// The row the dialog self-loads on open.
let questionRow: Record<string, unknown> = {};
// What the RPC resolves to, and a capture of its calls.
let rpcResult: Result = { data: null, error: null };
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = () => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.single = () => Promise.resolve({ data: questionRow, error: null });
    return chain;
  };
  return {
    supabase: {
      from: vi.fn(() => buildChain()),
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return rpcResult;
      }),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { QuestionEditorDialog } from "@/components/question-bank/editor";

function renderDialog(onSaved = vi.fn()) {
  render(
    <QuestionEditorDialog
      questionId="q1"
      open
      onOpenChange={() => {}}
      onSaved={onSaved}
    />,
  );
  return { onSaved };
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: null, error: null };
  questionRow = {
    id: "q1",
    type: "mcq",
    question: "2 + 2 = ?",
    payload: { options: ["3", "4", "5"] },
    answer_key: { correct_indices: [1], correct_index: 1 },
    explanation: null,
    difficulty: "easy",
  };
});

describe("QuestionEditorDialog", () => {
  it("saves a valid edit through the update_question_content RPC", async () => {
    const user = userEvent.setup();
    const { onSaved } = renderDialog();

    // Wait for the row to load into the MCQ form.
    const stem = await screen.findByDisplayValue("2 + 2 = ?");
    await user.clear(stem);
    await user.type(stem, "2 + 2 equals?");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(rpcCalls).toHaveLength(1));
    expect(rpcCalls[0].name).toBe("update_question_content");
    expect(rpcCalls[0].args).toMatchObject({
      _question_id: "q1",
      _question: "2 + 2 equals?",
      _difficulty: "easy",
    });
    expect(rpcCalls[0].args._payload).toMatchObject({ options: ["3", "4", "5"] });
    expect(rpcCalls[0].args._answer_key).toMatchObject({ correct_indices: [1] });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "q1", type: "mcq" }));
  });

  it("blocks an invalid edit and writes nothing", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Empty one of the options — buildAndValidate must reject before any RPC.
    const optionB = await screen.findByDisplayValue("4");
    await user.clear(optionB);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await screen.findByTestId("editor-errors");
    expect(rpcCalls).toHaveLength(0);
  });
});
