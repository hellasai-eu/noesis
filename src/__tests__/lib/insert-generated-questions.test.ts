/**
 * #630 — verifies the shared writer behind `UnifiedGenerateDialog` (and
 * any future caller) actually inserts the generated rows + junctions.
 * Before this helper existed, the unified dialog called the edge function
 * and toasted "success" without persisting anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface RecordedInsert {
  table: string;
  values: unknown;
}

const recorded: RecordedInsert[] = [];
const nextFromResult: Record<string, { data: unknown; error: unknown }> = {};
let insertedQuestionsReturn: { data: unknown[]; error: unknown } = {
  data: [],
  error: null,
};

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.eq = passThrough;
    chain.in = passThrough;
    chain.order = passThrough;
    chain.insert = (values: unknown) => {
      recorded.push({ table, values });
      if (table === "questions") {
        return {
          select: () => Promise.resolve(insertedQuestionsReturn),
        };
      }
      return Promise.resolve(
        nextFromResult[table] ?? { data: null, error: null },
      );
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        resolve(nextFromResult[table] ?? { data: [], error: null }),
      );
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((t: string) => buildChain(t)),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-42" } } })),
      },
    },
  };
});

import { insertGeneratedQuestions } from "@/lib/insert-generated-questions";

beforeEach(() => {
  recorded.length = 0;
  insertedQuestionsReturn = { data: [], error: null };
  for (const key of Object.keys(nextFromResult)) delete nextFromResult[key];
});

const findInsert = (table: string): RecordedInsert | undefined =>
  recorded.find((r) => r.table === table);

describe("insertGeneratedQuestions", () => {
  it("inserts fill-gaps rows verbatim (strips chapter_ids/competency_ids)", async () => {
    insertedQuestionsReturn = {
      data: [{ id: "q1" }, { id: "q2" }],
      error: null,
    };

    const result = await insertGeneratedQuestions({
      type: "fill_gaps",
      courseId: "course-1",
      generated: [
        {
          id: "q1",
          course_id: "course-1",
          question: "The ___ is ___.",
          type: "fill_gaps",
          payload: { stem: "The ___ is ___." },
          answer_key: {
            gaps: [
              { ordinal: 1, acceptable: ["sky"] },
              { ordinal: 2, acceptable: ["blue"] },
            ],
          },
          difficulty: "easy",
          hidden: false,
          chapter_ids: ["ch-a"],
          competency_ids: ["comp-1"],
        },
        {
          id: "q2",
          course_id: "course-1",
          question: "Water is ___.",
          type: "fill_gaps",
          payload: { stem: "Water is ___." },
          answer_key: { gaps: [{ ordinal: 1, acceptable: ["wet"] }] },
          difficulty: "easy",
          hidden: false,
          chapter_ids: ["ch-a", "ch-b"],
          competency_ids: [],
        },
      ],
      audience: { kind: "none" },
    });

    const qInsert = findInsert("questions");
    expect(qInsert).toBeDefined();
    const rows = qInsert!.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty("chapter_ids");
      expect(row).not.toHaveProperty("competency_ids");
      expect(row.created_by).toBe("user-42");
      expect(row.is_user_generated).toBe(false);
      expect(row.type).toBe("fill_gaps");
    }
    expect(rows[0].payload).toEqual({ stem: "The ___ is ___." });

    const chapterInsert = findInsert("question_chapters");
    expect(chapterInsert).toBeDefined();
    expect(chapterInsert!.values).toEqual([
      { question_id: "q1", chapter_id: "ch-a" },
      { question_id: "q2", chapter_id: "ch-a" },
      { question_id: "q2", chapter_id: "ch-b" },
    ]);

    const competencyInsert = findInsert("question_competencies");
    expect(competencyInsert).toBeDefined();
    expect(competencyInsert!.values).toEqual([
      { question_id: "q1", competency_id: "comp-1" },
    ]);

    expect(result.insertedCount).toBe(2);
    expect(result.autoAssignedLabel).toBeNull();
    expect(result.warning).toBeNull();
  });

  it("forces answering_mode='single' for open questions (#618)", async () => {
    insertedQuestionsReturn = { data: [{ id: "q-open" }], error: null };

    await insertGeneratedQuestions({
      type: "open",
      courseId: "course-1",
      generated: [
        {
          id: "q-open",
          course_id: "course-1",
          question: "Explain photosynthesis.",
          type: "open",
          // The edge function returns an empty payload because
          // `toOpenUnified` was called server-side without a mode.
          payload: {},
          answer_key: {
            model_answer: "Plants convert sunlight…",
            rubric: null,
            explanation: "Key idea.",
          },
          model_answer: "Plants convert sunlight…",
          explanation: "Key idea.",
          difficulty: "medium",
          hidden: false,
          chapter_ids: ["ch-bio"],
        },
      ],
      audience: { kind: "none" },
    });

    const qInsert = findInsert("questions");
    expect(qInsert).toBeDefined();
    const rows = qInsert!.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // The dialog MUST override the server's empty payload — otherwise the
    // reader falls back to "interactive" and the row never appears in the
    // bank (#630).
    expect(rows[0].payload).toEqual({ answering_mode: "single" });
    expect(rows[0].answer_key).toEqual({
      model_answer: "Plants convert sunlight…",
      rubric: null,
      explanation: "Key idea.",
    });
    expect(rows[0].type).toBe("open");
  });

  it("preserves the diagram for open questions (#627/#636)", async () => {
    insertedQuestionsReturn = { data: [{ id: "q-open" }], error: null };

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><line x1="0" y1="0" x2="10" y2="10" stroke="#222"/></svg>';

    await insertGeneratedQuestions({
      type: "open",
      courseId: "course-1",
      generated: [
        {
          id: "q-open",
          course_id: "course-1",
          question: "Read the velocity-time graph.",
          type: "open",
          // The edge function validated the diagram into the returned payload.
          payload: { diagram: { format: "svg", source: svg, alt: "v-t graph" } },
          answer_key: { model_answer: "…", rubric: null, explanation: "…" },
          model_answer: "…",
          explanation: "…",
          difficulty: "medium",
          hidden: false,
        },
      ],
      audience: { kind: "none" },
    });

    const qInsert = findInsert("questions");
    const rows = qInsert!.values as Array<Record<string, unknown>>;
    // Rebuilding the payload for answering_mode MUST NOT drop the diagram.
    expect(rows[0].payload).toEqual({
      answering_mode: "single",
      diagram: { format: "svg", source: svg, alt: "v-t graph" },
    });
  });

  it("does not auto-assign a group audience — it steers the prompt, not publication", async () => {
    insertedQuestionsReturn = { data: [{ id: "q1" }], error: null };

    const result = await insertGeneratedQuestions({
      type: "ordering",
      courseId: "course-1",
      generated: [
        {
          id: "q1",
          course_id: "course-1",
          question: "Order events",
          type: "ordering",
          payload: { prompt: "Order events", items: ["A", "B"] },
          answer_key: {},
          difficulty: "easy",
          hidden: false,
          chapter_ids: [],
        },
      ],
      audience: {
        kind: "group",
        groupId: "grp-9",
        offeringId: "off-9",
        label: "A1 → Group Alpha",
        description: null,
      },
    });

    expect(findInsert("offering_questions")).toBeUndefined();
    expect(result.autoAssignedLabel).toBeNull();
    expect(result.warning).toBeNull();
  });

  it("auto-assigns a student to the backend-resolved individual group", async () => {
    insertedQuestionsReturn = { data: [{ id: "q1" }], error: null };

    const result = await insertGeneratedQuestions({
      type: "classification",
      courseId: "course-1",
      generated: [
        {
          id: "q1",
          course_id: "course-1",
          question: "Sort animals",
          type: "classification",
          payload: { prompt: "Sort", categories: [], items: [] },
          answer_key: { assignments: {} },
          difficulty: "easy",
          hidden: false,
        },
      ],
      target: {
        kind: "student",
        offering_id: "off-2",
        group_id: "grp-individual-1",
        student_full_name: "Bob",
      },
      audience: {
        kind: "student",
        studentUserId: "stu-1",
        label: "Bob",
        offeringId: "off-2",
        hasAdminNotes: false,
      },
    });

    const assignInsert = findInsert("offering_questions");
    expect(assignInsert).toBeDefined();
    const rows = assignInsert!.values as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].offering_id).toBe("off-2");
    expect(rows[0].group_id).toBe("grp-individual-1");
    expect(result.autoAssignedLabel).toBe("Bob");
  });

  it("does not write offering_questions when audience is none", async () => {
    insertedQuestionsReturn = { data: [{ id: "q1" }], error: null };

    await insertGeneratedQuestions({
      type: "fill_gaps",
      courseId: "course-1",
      generated: [
        {
          id: "q1",
          course_id: "course-1",
          question: "x",
          type: "fill_gaps",
          payload: { stem: "x" },
          answer_key: { gaps: [] },
          difficulty: "easy",
          hidden: false,
        },
      ],
      audience: { kind: "none" },
    });

    expect(findInsert("offering_questions")).toBeUndefined();
  });

  it("writes question_materials links and keeps generated_for_group_id on the row", async () => {
    insertedQuestionsReturn = { data: [{ id: "q1" }], error: null };

    await insertGeneratedQuestions({
      type: "ordering",
      courseId: "course-1",
      generated: [
        {
          id: "q1",
          course_id: "course-1",
          question: "Order the steps.",
          type: "ordering",
          payload: { prompt: "Order the steps.", items: ["a", "b"] },
          answer_key: {},
          difficulty: "easy",
          hidden: false,
          chapter_ids: [],
          competency_ids: [],
          material_ids: ["mat-1", "mat-2"],
          generated_for_group_id: "group-7",
        },
      ],
      audience: { kind: "none" },
    });

    const qInsert = findInsert("questions");
    expect(qInsert).toBeDefined();
    const rows = qInsert!.values as Array<Record<string, unknown>>;
    // The junction-only field is stripped; the provenance COLUMN survives.
    expect(rows[0]).not.toHaveProperty("material_ids");
    expect(rows[0].generated_for_group_id).toBe("group-7");

    const materialInsert = findInsert("question_materials");
    expect(materialInsert).toBeDefined();
    expect(materialInsert!.values).toEqual([
      { question_id: "q1", material_id: "mat-1" },
      { question_id: "q1", material_id: "mat-2" },
    ]);
    // No chapter/competency junction writes for empty arrays.
    expect(findInsert("question_chapters")).toBeUndefined();
    expect(findInsert("question_competencies")).toBeUndefined();
  });

  it("reports a material-link failure as a warning, not a thrown error", async () => {
    // The questions are already committed by that point; throwing would
    // invite a retry that duplicates them (PR #1299 review).
    insertedQuestionsReturn = { data: [{ id: "q1" }], error: null };
    nextFromResult["question_materials"] = {
      data: null,
      error: { message: "foreign key violation" },
    };

    const result = await insertGeneratedQuestions({
      type: "ordering",
      courseId: "course-1",
      generated: [
        {
          id: "q1",
          course_id: "course-1",
          question: "Order the steps.",
          type: "ordering",
          payload: { prompt: "Order the steps.", items: ["a", "b"] },
          answer_key: {},
          difficulty: "easy",
          hidden: false,
          material_ids: ["mat-1"],
        },
      ],
      audience: { kind: "none" },
    });

    expect(result.insertedCount).toBe(1);
    expect(result.warning).toContain("foreign key violation");
  });

  it("throws when the questions insert fails", async () => {
    insertedQuestionsReturn = {
      data: null as unknown as unknown[],
      error: { message: "permission denied" },
    };

    await expect(
      insertGeneratedQuestions({
        type: "open",
        courseId: "course-1",
        generated: [
          {
            id: "q1",
            course_id: "course-1",
            question: "x",
            type: "open",
            payload: {},
            answer_key: { model_answer: "y" },
            model_answer: "y",
            difficulty: "easy",
            hidden: false,
          },
        ],
        audience: { kind: "none" },
      }),
    ).rejects.toMatchObject({ message: "permission denied" });
  });
});
