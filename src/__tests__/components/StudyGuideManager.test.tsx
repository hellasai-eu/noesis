/**
 * #1100 — StudyGuideManager: the WIRING around the study-guide assignment gate.
 *
 * `guideIsAssignable` and `disallowedNewTargets` (#1085/#1087) already have
 * their own lib tests. What had none is everything this component does around
 * them, which is where the gate can actually fail:
 *
 *  - the blocked cell must give the RIGHT reason of the two — a guide with no
 *    pieces needs an outline, a guide with pieces needs questions — because a
 *    wrong reason sends the instructor to the wrong screen;
 *  - `handleSaveAssign` must read completeness and current assignments from the
 *    DATABASE before the write, refuse additions and still let removals
 *    through. That asymmetry is the whole point of #1087: an already-assigned
 *    incomplete guide must stay retractable without becoming assignable;
 *  - `selectionToTargets` must collapse all three `AssignSelection` variants
 *    the same way `useContentAssignments.normalizeSelection` does. The two live
 *    in different files and neither references the other, so a drift is silent:
 *    the gate would compare a shape the writer never produces and let a target
 *    through, or refuse one it should not. Every variant is exercised through
 *    the gate here for that reason.
 *
 * `useContentAssignments` is mocked: this file is about the decision the
 * component makes BEFORE handing over to the hook, so the hook's own write path
 * (covered in its own test) is deliberately not in scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  AssignSelection,
  AssignmentTarget,
  CourseClass,
} from "@/types/content-assignments";

type PieceRow = {
  id: string;
  study_guide_id: string;
  theory_updated_at: string | null;
  questions_generated_at: string | null;
};

const db = vi.hoisted(() => ({
  guides: [] as Array<{
    id: string;
    title: string;
    material_id: string | null;
    created_by: string | null;
  }>,
  pieces: [] as Array<{
    id: string;
    study_guide_id: string;
    theory_updated_at: string | null;
    questions_generated_at: string | null;
  }>,
  pieceQuestions: [] as Array<{ piece_id: string }>,
  offeringStudyGuides: [] as Array<{
    id: string;
    study_guide_id: string;
    offering_id: string;
    group_id: string | null;
    /** NULL means "not published to this target" — a row, but not an assignment. */
    published_at: string | null;
    due_date: string | null;
    closed_at: string | null;
  }>,
  /** Per-table read failure, injected mid-test to hit the catch arms. */
  errors: {} as Record<string, { message: string } | undefined>,
  /** Every update the component issued, in order — payload plus its filters. */
  writes: [] as Array<{
    table: string;
    values: Record<string, unknown>;
    filters: Array<{ op: string; col: string; val: unknown }>;
  }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  type Filter = { op: string; col: string; val: unknown };

  const resolveQuery = (table: string, filters: Filter[]) => {
    const failure = db.errors[table];
    if (failure) return { data: null, error: failure };

    const find = (op: string, col: string) =>
      filters.find((f) => f.op === op && f.col === col);

    if (table === "study_guides") {
      return { data: db.guides.map((g) => ({ ...g })), error: null };
    }

    if (table === "study_guide_pieces") {
      const one = find("eq", "study_guide_id");
      const many = find("in", "study_guide_id");
      const rows = db.pieces.filter((p) => {
        if (one) return p.study_guide_id === one.val;
        if (many) return (many.val as string[]).includes(p.study_guide_id);
        return true;
      });
      return { data: rows.map((r) => ({ ...r })), error: null };
    }

    if (table === "study_guide_piece_questions") {
      const many = find("in", "piece_id");
      const ids = many ? (many.val as string[]) : null;
      const rows = db.pieceQuestions.filter((l) => !ids || ids.includes(l.piece_id));
      return { data: rows.map((l) => ({ piece_id: l.piece_id })), error: null };
    }

    if (table === "offering_study_guides") {
      const one = find("eq", "study_guide_id");
      const many = find("in", "study_guide_id");
      // `.not("published_at", "is", null)` is applied for real. Treating it as
      // a no-op would let the component drop the filter and stay green, and an
      // unpublished row counted as an existing target is exactly how an
      // addition slips past the gate.
      const publishedOnly = !!find("not_is", "published_at");
      const rows = db.offeringStudyGuides.filter((r) => {
        if (one && r.study_guide_id !== one.val) return false;
        if (many && !(many.val as string[]).includes(r.study_guide_id)) return false;
        if (publishedOnly && r.published_at === null) return false;
        return true;
      });
      return { data: rows.map((r) => ({ ...r })), error: null };
    }

    return { data: [], error: null };
  };

  const buildChain = (table: string) => {
    const filters: Filter[] = [];
    // Writes resolve to a bare success against the in-memory rows, but the
    // payload and its filters are RECORDED — the per-section due date and
    // reopen tests assert on exactly which rows each update aimed at.
    let writeValues: Record<string, unknown> | null = null;
    // Only `then` is terminal — every filter is chainable, as in the real
    // builder, so the component's `.eq().not()` and `.eq().order()` both work.
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.order = () => chain;
    chain.is = () => chain;
    chain.lt = (col: string, val: unknown) => {
      filters.push({ op: "lt", col, val });
      return chain;
    };
    chain.update = (values: Record<string, unknown>) => {
      writeValues = values;
      return chain;
    };
    chain.not = (col: string, op: string, val: unknown) => {
      filters.push({ op: `not_${op}`, col, val });
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters.push({ op: "eq", col, val });
      return chain;
    };
    chain.in = (col: string, val: unknown) => {
      filters.push({ op: "in", col, val });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (writeValues) {
        db.writes.push({ table, values: writeValues, filters });
        return Promise.resolve(resolve({ data: null, error: null }));
      }
      return Promise.resolve(resolve(resolveQuery(table, filters)));
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      rpc: vi.fn(async () => ({ data: null, error: null })),
      functions: { invoke: vi.fn(async () => ({ data: { pieces: [] }, error: null })) },
    },
  };
});

vi.mock("@/i18n/formatters", () => ({
  useFormatters: () => ({
    compareText: (a: string, b: string) => a.localeCompare(b),
    formatDate: (iso: string) => new Date(iso).toLocaleDateString(),
    formatTime: (iso: string) => new Date(iso).toLocaleTimeString(),
  }),
}));

/**
 * Resolves the two ids the seeds use; everything else stays unresolved, which
 * is exactly what an RLS-hidden profile looks like to the component.
 */
vi.mock("@/lib/author-names", () => ({
  fetchAuthorNames: async (ids: (string | null | undefined)[]) => {
    const known: Record<string, string> = {
      "user-alice": "Alice Instructor",
      "user-bob": "Bob Instructor",
    };
    const out: Record<string, string> = {};
    for (const id of ids) if (id && known[id]) out[id] = known[id];
    return out;
  },
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

const hookState = vi.hoisted(() => ({
  assignedTargets: {} as Record<
    string,
    Array<{ offering_id: string; group_id: string | null }>
  >,
  saveAssignments: vi.fn(async () => {}),
  loading: false,
  error: null as string | null,
}));

vi.mock("@/hooks/useContentAssignments", () => ({
  useContentAssignments: () => ({
    assignments: {},
    groupsByOffering: {},
    loading: hookState.loading,
    error: hookState.error,
    saving: false,
    getAssignedOfferingIds: (id: string) =>
      (hookState.assignedTargets[id] ?? [])
        .filter((t) => t.group_id === null)
        .map((t) => t.offering_id),
    getAssignedTargets: (id: string) => hookState.assignedTargets[id] ?? [],
    isAssigned: (id: string) => (hookState.assignedTargets[id] ?? []).length > 0,
    saveAssignments: hookState.saveAssignments,
    refetch: vi.fn(),
    refetchGroups: vi.fn(),
  }),
}));

/**
 * The assign dialog is captured rather than driven: its own selection UI has a
 * test of its own, and what matters here is which selection shape reaches
 * `handleSaveAssign`. Rendering only while `open` also makes "the dialog
 * closed" an assertion rather than an inference.
 */
const dialogProps = vi.hoisted(() => ({
  current: null as null | {
    onSave: (s: Set<string> | AssignSelection) => Promise<void>;
    currentAssignedTargets?: AssignmentTarget[];
  },
}));

vi.mock("@/components/ContentAssignDialog", () => ({
  ContentAssignDialog: (props: {
    open: boolean;
    classes?: CourseClass[];
    onSave: (s: Set<string> | AssignSelection) => Promise<void>;
    currentAssignedTargets?: AssignmentTarget[];
    perOfferingControls?: (cls: CourseClass, selected: boolean) => ReactNode;
  }) => {
    dialogProps.current = props;
    if (!props.open) return null;
    return (
      <div data-testid="assign-dialog">
        {/* Every class rendered as selected, so the per-section due inputs
            are reachable without re-testing the real dialog's checkboxes. */}
        {(props.classes ?? []).map((c) => (
          <div key={c.id}>{props.perOfferingControls?.(c, true)}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/study-guide/CreateStudyGuideDialog", () => ({
  CreateStudyGuideDialog: () => null,
}));
vi.mock("@/components/study-guide/StudyGuidePieceEditor", () => ({
  StudyGuidePieceEditor: () => null,
}));
/**
 * Captured rather than rendered: the real dialog loads analytics of its own and
 * has a test file for that. What this file needs is which guide, and which
 * panel, the pressed row action asks for.
 */
const resultsProps = vi.hoisted(() => ({
  current: null as null | {
    open: boolean;
    studyGuideId: string | null;
    studyGuideTitle: string;
    initialTab?: string;
    onOpenChange: (open: boolean) => void;
  },
}));

vi.mock("@/components/study-guide/StudyGuideResultsDialog", () => ({
  StudyGuideResultsDialog: (props: {
    open: boolean;
    studyGuideId: string | null;
    studyGuideTitle: string;
    initialTab?: string;
    onOpenChange: (open: boolean) => void;
  }) => {
    resultsProps.current = props;
    return props.open ? <div data-testid="results-dialog" /> : null;
  },
}));

import { StudyGuideManager } from "@/components/StudyGuideManager";
import { supabase } from "@/integrations/supabase/client";

const classes: CourseClass[] = [
  {
    id: "cls-1",
    name: "Math 101",
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: "off-1",
  },
  {
    id: "cls-2",
    name: "Math 102",
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: "off-2",
  },
];

const materials = [
  {
    id: "mat-1",
    title: "Algebra Textbook",
    file_name: "algebra.pdf",
    material_type: "textbook",
  },
];

const GUIDE = "guide-1";

/** Adds a guide plus `total` pieces, `withQuestions` of which have questions. */
function seedGuide(opts: {
  total: number;
  withQuestions: number;
  stale?: number;
  title?: string;
  id?: string;
  createdBy?: string | null;
}) {
  const id = opts.id ?? GUIDE;
  db.guides.push({
    id,
    title: opts.title ?? "Chapter 1 guide",
    material_id: "mat-1",
    created_by: opts.createdBy ?? null,
  });
  for (let i = 0; i < opts.total; i++) {
    const hasQuestions = i < opts.withQuestions;
    const isStale = hasQuestions && i < (opts.stale ?? 0);
    const piece: PieceRow = {
      id: `${id}-piece-${i}`,
      study_guide_id: id,
      theory_updated_at: isStale ? "2026-02-01T00:00:00Z" : "2026-01-01T00:00:00Z",
      questions_generated_at: hasQuestions ? "2026-01-15T00:00:00Z" : null,
    };
    db.pieces.push(piece);
    if (hasQuestions) db.pieceQuestions.push({ piece_id: piece.id });
  }
}

/**
 * Records the guide as assigned, in both the hook's view and the DB's.
 *
 * `published: false` writes the row but leaves `published_at` NULL — the "not
 * published to this target" state the column exists for. Such a row is NOT an
 * assignment: the hook filters it out and so must the component's own read.
 */
function seedAssignment(
  offeringId: string,
  groupId: string | null = null,
  published = true,
  guideId = GUIDE,
  meta: { due_date?: string | null; closed_at?: string | null } = {},
) {
  if (published) {
    hookState.assignedTargets[guideId] = [
      ...(hookState.assignedTargets[guideId] ?? []),
      { offering_id: offeringId, group_id: groupId },
    ];
  }
  db.offeringStudyGuides.push({
    id: `osg-${db.offeringStudyGuides.length}`,
    study_guide_id: guideId,
    offering_id: offeringId,
    group_id: groupId,
    published_at: published ? "2026-01-20T00:00:00Z" : null,
    due_date: meta.due_date ?? null,
    closed_at: meta.closed_at ?? null,
  });
}

function renderManager() {
  return render(
    <TooltipProvider>
      <StudyGuideManager courseId="course-1" materials={materials} classes={classes} />
    </TooltipProvider>,
  );
}

/**
 * Renders, waits for the list, then opens the assign dialog for the guide —
 * through whichever affordance the guide's state offers: the Assign link
 * (complete + unassigned), the assign-more button (complete + assigned),
 * or the badges themselves (the always-reachable retract path).
 */
async function openAssignDialog() {
  const user = userEvent.setup();
  renderManager();
  await screen.findByText("Chapter 1 guide");
  const trigger =
    screen.queryByTestId(`sg-needs-assign-${GUIDE}`) ??
    screen.queryByTestId(`sg-assign-more-${GUIDE}`) ??
    // Regex + AllBy: a group target renders its own "Math 101 → <group>"
    // badge next to the whole-class one, and either opens the dialog.
    screen.getAllByText(/Math 101/)[0];
  await user.click(trigger);
  await screen.findByTestId("assign-dialog");
  return user;
}

/** Fires the dialog's save with `selection` and settles the promises it starts. */
async function save(selection: Set<string> | AssignSelection) {
  await act(async () => {
    await dialogProps.current!.onSave(selection);
  });
}

beforeEach(() => {
  db.guides.length = 0;
  db.pieces.length = 0;
  db.pieceQuestions.length = 0;
  db.offeringStudyGuides.length = 0;
  db.errors = {};
  db.writes.length = 0;
  hookState.assignedTargets = {};
  hookState.saveAssignments.mockClear();
  hookState.loading = false;
  hookState.error = null;
  dialogProps.current = null;
  resultsProps.current = null;
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  toastMocks.warning.mockClear();
  toastMocks.info.mockClear();
});

describe("StudyGuideManager — the blocked assignment cell", () => {
  it("blocks a pieceless guide and asks for the outline", async () => {
    seedGuide({ total: 0, withQuestions: 0 });
    renderManager();

    const blocked = await screen.findByTestId(`sg-assign-blocked-${GUIDE}`);
    expect(blocked).toHaveTextContent(
      "This guide has no pieces yet — build the outline to complete it.",
    );
    expect(blocked).toHaveAttribute(
      "title",
      "Build the outline before assigning this guide",
    );
  });

  it("blocks a guide with question-less pieces and asks for the questions", async () => {
    seedGuide({ total: 3, withQuestions: 1 });
    renderManager();

    const blocked = await screen.findByTestId(`sg-assign-blocked-${GUIDE}`);
    expect(blocked).toHaveTextContent(
      "This guide is not complete — click edit to complete it.",
    );
    // The other reason, and the counts must be the real ones — an instructor
    // sent to "build the outline" for a guide that HAS an outline is stuck.
    expect(blocked).toHaveAttribute(
      "title",
      "2 of 3 pieces still have no questions — generate them before assigning this guide.",
    );
  });

  it("does not block a guide whose every piece has questions", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    renderManager();

    await screen.findByText("Chapter 1 guide");
    expect(screen.queryByTestId(`sg-assign-blocked-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`sg-needs-assign-${GUIDE}`)).toBeInTheDocument();
  });

  it("keeps the assignment UI reachable for an incomplete guide that is already out", async () => {
    // The #1085 escape hatch: every piece deleted after it went out. If this
    // cell blocked, the instructor could never take the guide back.
    seedGuide({ total: 0, withQuestions: 0 });
    seedAssignment("off-1");
    renderManager();

    await screen.findByText("Chapter 1 guide");
    expect(screen.queryByTestId(`sg-assign-blocked-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.getByText("Math 101")).toBeInTheDocument();
  });

  it("reports completeness and staleness in the pieces column", async () => {
    seedGuide({ total: 3, withQuestions: 2, stale: 1 });
    renderManager();

    expect(await screen.findByText(/2\/3 complete/)).toBeInTheDocument();
    expect(screen.getByText(/1 stale/)).toBeInTheDocument();
  });
});

describe("StudyGuideManager — handleSaveAssign refuses additions, allows removals", () => {
  it("refuses a NEW class while pieces are question-less", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("1 of 2 pieces still have no questions"),
    );
    // Refusing must leave the dialog open — the instructor's selection is not
    // discarded, and a removal is still available from here.
    expect(screen.getByTestId("assign-dialog")).toBeInTheDocument();
  });

  it("allows a pure removal from an incomplete guide", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    seedAssignment("off-2");
    await openAssignDialog();

    const selection = { kind: "offerings" as const, offeringIds: new Set(["off-1"]) };
    await save(selection);

    expect(hookState.saveAssignments).toHaveBeenCalledWith([GUIDE], selection, false);
    await waitFor(() =>
      expect(screen.queryByTestId("assign-dialog")).not.toBeInTheDocument(),
    );
  });

  it("allows an addition once every piece has questions", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(toastMocks.warning).not.toHaveBeenCalled();
  });

  it("warns after a removal that the guide is still incomplete", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    seedAssignment("off-2");
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1"]) });

    expect(hookState.saveAssignments).toHaveBeenCalledTimes(1);
    expect(toastMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("1 of 2 pieces have no questions yet"),
    );
  });

  it("warns when questions predate the theory they test", async () => {
    seedGuide({ total: 2, withQuestions: 2, stale: 1 });
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1"]) });

    expect(hookState.saveAssignments).toHaveBeenCalledTimes(1);
    expect(toastMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("1 piece have questions written before the theory"),
    );
  });

  it("reads completeness from the database, not the row rendered in the list", async () => {
    // The list says complete; the editor has since added a question-less piece.
    // Trusting the cached row here would assign a guide the gate should refuse.
    seedGuide({ total: 1, withQuestions: 1 });
    seedAssignment("off-1");
    await openAssignDialog();

    db.pieces.push({
      id: "piece-late",
      study_guide_id: GUIDE,
      theory_updated_at: "2026-03-01T00:00:00Z",
      questions_generated_at: null,
    });

    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("1 of 2 pieces still have no questions"),
    );
  });

  it("reads current assignments from the database, not the hook's cache", async () => {
    // The cache still remembers off-2; another session has since dropped it, so
    // re-selecting it is a genuine ADDITION and must be refused.
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    hookState.assignedTargets[GUIDE] = [
      ...hookState.assignedTargets[GUIDE],
      { offering_id: "off-2", group_id: null },
    ];
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("still have no questions"),
    );
  });

  it("does not count an unpublished row as an existing target", async () => {
    // `published_at` is nullable and NULL means "not published to this target"
    // — the row exists, the assignment does not. Without the `.not(...)` filter
    // on that read, off-2 would look like something the guide already had and
    // a genuine addition would be waved through.
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    seedAssignment("off-2", null, false);
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("1 of 2 pieces still have no questions"),
    );
  });

  it("does not write when the completeness read fails", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    await openAssignDialog();

    db.errors.study_guide_pieces = { message: "boom" };
    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      "Could not check this guide before assigning it",
    );
  });

  it("does not write when the current-assignments read fails", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    await openAssignDialog();

    db.errors.offering_study_guides = { message: "boom" };
    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    expect(hookState.saveAssignments).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(
      "Could not check this guide's current assignments",
    );
  });
});

describe("StudyGuideManager — selectionToTargets covers every selection shape", () => {
  /**
   * Each variant is run through the gate twice: once selecting only what the
   * guide already has (must pass) and once adding one target (must be refused).
   * A `selectionToTargets` that flattened a variant wrongly would fail one of
   * the two — either by refusing a keep-only save or by waving an addition
   * through — which is exactly how a drift from `normalizeSelection` would show.
   */

  it("treats a bare Set as whole-class targets", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await openAssignDialog();

    await save(new Set(["off-1"]));
    expect(hookState.saveAssignments).toHaveBeenCalledTimes(1);
  });

  it("refuses a bare Set that adds an offering", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await openAssignDialog();

    await save(new Set(["off-1", "off-2"]));
    expect(hookState.saveAssignments).not.toHaveBeenCalled();
  });

  it("treats the offerings variant as whole-class targets", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await openAssignDialog();

    await save({ kind: "offerings", offeringIds: new Set(["off-1"]) });
    expect(hookState.saveAssignments).toHaveBeenCalledTimes(1);
  });

  it("reads the targets variant's wholeClass flag and its group ids", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    seedAssignment("off-1", "group-a");
    await openAssignDialog();

    await save({
      kind: "targets",
      perOffering: new Map([
        ["off-1", { wholeClass: true, groupIds: new Set(["group-a"]) }],
      ]),
    });
    expect(hookState.saveAssignments).toHaveBeenCalledTimes(1);
  });

  it("refuses a group the targets variant adds, even to an assigned class", async () => {
    // The class itself is already assigned, so a gate that only compared
    // offering ids would let a brand-new group through.
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await openAssignDialog();

    await save({
      kind: "targets",
      perOffering: new Map([
        ["off-1", { wholeClass: true, groupIds: new Set(["group-a"]) }],
      ]),
    });
    expect(hookState.saveAssignments).not.toHaveBeenCalled();
  });

  it("refuses a whole-class target the targets variant adds to a group-only class", async () => {
    // Mirror image: only the group is assigned, so `wholeClass: true` is the
    // addition — a gate that ignored the flag would miss it.
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1", "group-a");
    await openAssignDialog();

    await save({
      kind: "targets",
      perOffering: new Map([
        ["off-1", { wholeClass: true, groupIds: new Set(["group-a"]) }],
      ]),
    });
    expect(hookState.saveAssignments).not.toHaveBeenCalled();
  });
});

/**
 * #1228 — the AI class assessment gets a row action of its own.
 *
 * Before this it was reachable only by opening results and finding the fourth
 * tab, so the two buttons now differ ONLY in the panel they ask for. That makes
 * the `initialTab` prop the whole feature: a manager that opened both buttons
 * on "students" would look identical in review and be the bug. The dialog's own
 * end of the contract — actually landing on the tab it is handed, and re-seeding
 * on each open — is pinned in StudyGuideResultsDialog.initialTab.test.tsx.
 */
describe("StudyGuideManager — the row actions that open the results dialog", () => {
  /** Renders and waits for the guide row to exist. */
  async function renderList() {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText("Chapter 1 guide");
    return user;
  }

  it("opens the results dialog on the students panel", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    const user = await renderList();

    await user.click(screen.getByTestId(`sg-results-${GUIDE}`));

    expect(await screen.findByTestId("results-dialog")).toBeInTheDocument();
    expect(resultsProps.current).toMatchObject({
      open: true,
      studyGuideId: GUIDE,
      studyGuideTitle: "Chapter 1 guide",
      initialTab: "students",
    });
  });

  it("opens the same dialog on the assessment panel from its own button", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    const user = await renderList();

    await user.click(screen.getByTestId(`sg-assessment-${GUIDE}`));

    expect(await screen.findByTestId("results-dialog")).toBeInTheDocument();
    expect(resultsProps.current).toMatchObject({
      open: true,
      studyGuideId: GUIDE,
      initialTab: "assessment",
    });
  });

  it("asks for the panel of the button pressed LAST, not the one pressed first", async () => {
    // The manager holds one piece of state for both buttons. Pressing results
    // after assessment must re-aim it, or the second press reopens the first
    // button's panel.
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    const user = await renderList();

    await user.click(screen.getByTestId(`sg-assessment-${GUIDE}`));
    await screen.findByTestId("results-dialog");
    await act(async () => {
      resultsProps.current!.onOpenChange(false);
    });
    await waitFor(() => expect(screen.queryByTestId("results-dialog")).not.toBeInTheDocument());

    await user.click(screen.getByTestId(`sg-results-${GUIDE}`));

    expect(resultsProps.current).toMatchObject({ open: true, initialTab: "students" });
  });

  it("closes the dialog and forgets the guide when dismissed", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    const user = await renderList();

    await user.click(screen.getByTestId(`sg-assessment-${GUIDE}`));
    await screen.findByTestId("results-dialog");

    await act(async () => {
      resultsProps.current!.onOpenChange(false);
    });

    await waitFor(() => expect(screen.queryByTestId("results-dialog")).not.toBeInTheDocument());
    expect(resultsProps.current).toMatchObject({ open: false, studyGuideId: null });
  });

  it("offers neither button on an unassigned guide — both read the same answers", async () => {
    // A complete guide, so the absence is about assignment and nothing else.
    seedGuide({ total: 2, withQuestions: 2 });
    await renderList();

    expect(screen.queryByTestId(`sg-results-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`sg-assessment-${GUIDE}`)).not.toBeInTheDocument();
  });

  it("offers both on a guide published only to a group", async () => {
    // A group assignment is an assignment: there are answers to report on.
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", "group-a");
    await renderList();

    expect(screen.getByTestId(`sg-results-${GUIDE}`)).toBeInTheDocument();
    expect(screen.getByTestId(`sg-assessment-${GUIDE}`)).toBeInTheDocument();
  });

  it("offers both on an assigned guide that is still incomplete", async () => {
    // The assignment gate blocks new targets on an incomplete guide, but the
    // students who already have it have answered — hiding the report from the
    // instructor is the wrong lever.
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await renderList();

    expect(screen.getByTestId(`sg-results-${GUIDE}`)).toBeInTheDocument();
    expect(screen.getByTestId(`sg-assessment-${GUIDE}`)).toBeInTheDocument();
  });

  it("names the guide in each button, so a screen reader can tell the rows apart", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    await renderList();

    expect(
      screen.getByRole("button", { name: "Results for Chapter 1 guide" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Assessment for Chapter 1 guide" }),
    ).toBeInTheDocument();
  });
});


/**
 * #1306 — the outline action is a FIRST build only.
 *
 * It used to double as "rebuild", which discarded every piece and its
 * questions from a single row click. Removing that is the whole change, and
 * the only thing standing between it and a silent return is this visibility
 * assertion: the button must be absent the moment a guide has pieces, and
 * still present on a pieceless one, which is the recovery path
 * CreateStudyGuideDialog leaves a failed creation on.
 */
describe("StudyGuideManager — the outline action is a first build, never a rebuild", () => {
  const buildLabel = "Build outline for Chapter 1 guide";

  async function renderList() {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText("Chapter 1 guide");
    return user;
  }

  it("offers the build action on a guide with no pieces", async () => {
    seedGuide({ total: 0, withQuestions: 0 });
    await renderList();

    const build = screen.getByRole("button", { name: buildLabel });
    // The tooltip may no longer promise a rebuild: the wording is what tells
    // the instructor whether pressing it is destructive.
    expect(build).toHaveAttribute("title", "Build the outline");
  });

  it("builds the outline for that guide when pressed", async () => {
    seedGuide({ total: 0, withQuestions: 0 });
    const user = await renderList();

    await user.click(screen.getByRole("button", { name: buildLabel }));

    await waitFor(() =>
      expect(supabase.functions.invoke).toHaveBeenCalledWith(
        "generate-study-guide-outline",
        { body: { studyGuideId: GUIDE } },
      ),
    );
  });

  it("withdraws the action once the guide has an outline", async () => {
    // One piece is enough: any outline at all makes a build a rebuild.
    seedGuide({ total: 1, withQuestions: 0 });
    await renderList();

    expect(screen.queryByRole("button", { name: buildLabel })).not.toBeInTheDocument();
  });

  it("withdraws it from a complete guide too", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    await renderList();

    expect(screen.queryByRole("button", { name: buildLabel })).not.toBeInTheDocument();
    // The rest of the row is untouched — the removal must be that one button.
    expect(screen.getByTestId(`sg-results-${GUIDE}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Chapter 1 guide" })).toBeInTheDocument();
  });
});

describe("StudyGuideManager — initialResultsGuideId deep link", () => {
  function renderWithDeepLink(guideId: string, onConsumed?: () => void) {
    return render(
      <TooltipProvider>
        <StudyGuideManager
          courseId="course-1"
          materials={materials}
          classes={classes}
          initialResultsGuideId={guideId}
          onInitialResultsConsumed={onConsumed}
        />
      </TooltipProvider>,
    );
  }

  it("opens the results dialog on the students panel once the guides load", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    renderWithDeepLink(GUIDE);

    await waitFor(() => {
      expect(screen.getByTestId("results-dialog")).toBeInTheDocument();
    });
    expect(resultsProps.current?.studyGuideId).toBe(GUIDE);
    expect(resultsProps.current?.initialTab).toBe("students");
  });

  it("opens nothing for a guide id the course does not contain", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    renderWithDeepLink("guide-that-was-deleted");

    await screen.findByText("Chapter 1 guide");
    expect(screen.queryByTestId("results-dialog")).not.toBeInTheDocument();
  });

  it("notifies the parent exactly once when the deep link is consumed", async () => {
    // The parent strips `?guide=` from the URL on this signal. Without it,
    // the manager remounts on every tab switch against the same param and
    // the dialog pops again each time the instructor comes back.
    seedGuide({ total: 2, withQuestions: 2 });
    const onConsumed = vi.fn();
    renderWithDeepLink(GUIDE, onConsumed);

    await waitFor(() => {
      expect(screen.getByTestId("results-dialog")).toBeInTheDocument();
    });
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it("does not notify while the deep link stays un-consumed", async () => {
    // A stale id never fires, so the URL keeps the param — a later load that
    // DOES contain the guide may still honor the link.
    seedGuide({ total: 2, withQuestions: 2 });
    const onConsumed = vi.fn();
    renderWithDeepLink("guide-that-was-deleted", onConsumed);

    await screen.findByText("Chapter 1 guide");
    expect(onConsumed).not.toHaveBeenCalled();
  });

  it("does not reopen the dialog after the parent clears the deep link", async () => {
    // The CoursePage contract end-to-end: consume → parent strips the param →
    // prop becomes null. Dismissing the dialog then leaves it closed.
    seedGuide({ total: 2, withQuestions: 2 });
    const view = renderWithDeepLink(GUIDE);
    await waitFor(() => {
      expect(screen.getByTestId("results-dialog")).toBeInTheDocument();
    });

    view.rerender(
      <TooltipProvider>
        <StudyGuideManager
          courseId="course-1"
          materials={materials}
          classes={classes}
          initialResultsGuideId={null}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      resultsProps.current!.onOpenChange(false);
    });

    await waitFor(() =>
      expect(screen.queryByTestId("results-dialog")).not.toBeInTheDocument(),
    );
  });
});

/**
 * Per-section due dates: each offering's rows carry their own deadline, edited
 * next to that class in the assign dialog. Two sections holding the same guide
 * with different deadlines is the whole point — the writes must stay scoped to
 * their offering, and reopening must not wipe a deadline that is still ahead.
 */
describe("StudyGuideManager — per-section due dates", () => {
  const PAST_DUE = "2020-01-01T10:00:00.000Z";
  const FUTURE_DUE = "2100-01-01T10:00:00.000Z";

  function dueWrites() {
    return db.writes.filter(
      (w) => w.table === "offering_study_guides" && "due_date" in w.values,
    );
  }

  it("prefills each section's inputs from that section's saved deadline", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", null, true, GUIDE, { due_date: FUTURE_DUE });
    seedAssignment("off-2");
    await openAssignDialog();

    const d = new Date(FUTURE_DUE);
    const pad = (n: number) => String(n).padStart(2, "0");
    const localDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    expect(screen.getByTestId("sg-assign-due-date-off-1")).toHaveValue(localDate);
    // The other section saved no deadline — its inputs must not inherit one.
    expect(screen.getByTestId("sg-assign-due-date-off-2")).toHaveValue("");
  });

  it("writes each selected section's own due date, scoped to that offering", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    seedAssignment("off-2");
    await openAssignDialog();

    fireEvent.change(screen.getByTestId("sg-assign-due-date-off-1"), {
      target: { value: "2100-09-15" },
    });
    fireEvent.change(screen.getByTestId("sg-assign-due-time-off-1"), {
      target: { value: "08:00" },
    });
    fireEvent.change(screen.getByTestId("sg-assign-due-date-off-2"), {
      target: { value: "2100-09-20" },
    });

    await save({ kind: "offerings", offeringIds: new Set(["off-1", "off-2"]) });

    const writes = dueWrites();
    expect(writes).toHaveLength(2);
    const byOffering = new Map(
      writes.map((w) => [
        w.filters.find((f) => f.op === "eq" && f.col === "offering_id")?.val,
        w,
      ]),
    );
    expect(byOffering.get("off-1")?.values.due_date).toBe(
      new Date("2100-09-15T08:00").toISOString(),
    );
    // No time picked → end of day, the QuizManager convention.
    expect(byOffering.get("off-2")?.values.due_date).toBe(
      new Date("2100-09-20T23:59").toISOString(),
    );
    // Both scoped to the guide as well as the offering.
    for (const w of writes) {
      expect(w.filters).toContainEqual({ op: "eq", col: "study_guide_id", val: GUIDE });
    }
  });

  it("clears a section's deadline when its input is emptied", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", null, true, GUIDE, { due_date: FUTURE_DUE });
    await openAssignDialog();

    fireEvent.change(screen.getByTestId("sg-assign-due-date-off-1"), {
      target: { value: "" },
    });

    await save({ kind: "offerings", offeringIds: new Set(["off-1"]) });

    const writes = dueWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0].values.due_date).toBeNull();
  });

  it("reopens through the atomic RPC, never through client-side updates", async () => {
    // off-1 is done via its passed deadline, off-2 via closed_at with a
    // deadline still ahead. `reopen_study_guide` clears both in ONE
    // statement — closure everywhere, due date only where passed — so a
    // partial commit can never reopen some sections while others still read
    // Done. Two client-side updates here would be that regression.
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", null, true, GUIDE, { due_date: PAST_DUE });
    seedAssignment("off-2", null, true, GUIDE, {
      due_date: FUTURE_DUE,
      closed_at: "2026-01-21T00:00:00Z",
    });
    const user = userEvent.setup();
    renderManager();
    await screen.findByText("Chapter 1 guide");

    await user.click(await screen.findByTestId(`sg-reopen-${GUIDE}`));

    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith("reopen_study_guide", {
        _study_guide_id: GUIDE,
      }),
    );
    expect(db.writes).toHaveLength(0);
    // The passed deadline was about to be cleared — the toast must say so.
    expect(toastMocks.success).toHaveBeenCalledWith(
      "Study guide reopened — passed due dates were cleared.",
    );
  });

  it("shows one line per section when their deadlines differ", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", null, true, GUIDE, { due_date: FUTURE_DUE });
    seedAssignment("off-2", null, true, GUIDE, {
      due_date: "2100-06-01T10:00:00.000Z",
    });
    renderManager();

    expect(await screen.findByTestId(`sg-due-${GUIDE}-off-1`)).toBeInTheDocument();
    expect(screen.getByTestId(`sg-due-${GUIDE}-off-2`)).toBeInTheDocument();
    // The compact single-value form is for agreeing sections only.
    expect(screen.queryByTestId(`sg-due-${GUIDE}`)).not.toBeInTheDocument();
  });

  it("keeps the compact single value while every section agrees", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", null, true, GUIDE, { due_date: FUTURE_DUE });
    seedAssignment("off-2", null, true, GUIDE, { due_date: FUTURE_DUE });
    renderManager();

    expect(await screen.findByTestId(`sg-due-${GUIDE}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`sg-due-${GUIDE}-off-1`)).not.toBeInTheDocument();
  });

  it("marks a section done on its own line while another is still open", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1", null, true, GUIDE, { due_date: PAST_DUE });
    seedAssignment("off-2", null, true, GUIDE, { due_date: FUTURE_DUE });
    renderManager();

    const doneLine = await screen.findByTestId(`sg-due-${GUIDE}-off-1`);
    expect(doneLine).toHaveTextContent("done");
    expect(screen.getByTestId(`sg-due-${GUIDE}-off-2`)).not.toHaveTextContent("done");
    // Guide-level Done stays reserved for ALL sections done.
    expect(screen.queryByTestId(`sg-done-badge-${GUIDE}`)).not.toBeInTheDocument();
  });
});

describe("StudyGuideManager — assigned rows are visibly marked", () => {
  it("shows the green assigned check on an assigned guide only", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedGuide({ id: "guide-2", title: "Chapter 2 guide", total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    renderManager();

    await screen.findByText("Chapter 1 guide");
    expect(screen.getByTestId(`sg-assigned-check-${GUIDE}`)).toBeInTheDocument();
    expect(screen.queryByTestId("sg-assigned-check-guide-2")).not.toBeInTheDocument();
  });

  it("withholds the check while the assignment state is unknown", async () => {
    // The badges branch still renders during load as the honest fallback —
    // but the green check is a CLAIM of assignment and must wait for data.
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    hookState.loading = true;
    renderManager();

    await screen.findByText("Chapter 1 guide");
    expect(screen.queryByTestId(`sg-assigned-check-${GUIDE}`)).not.toBeInTheDocument();
  });
});

/**
 * The unassigned-guide Assign link and the assign-more affordance.
 *
 * The Classes cell now distinguishes three assignable states, and each gets a
 * different affordance: complete + unassigned is finished work no student can
 * see (the ghost Assign link), complete + assigned can go further (the quiet
 * plus), and
 * incomplete + assigned may only retract (badges alone — the gate would refuse
 * every addition, so offering one is a dead end).
 */
describe("StudyGuideManager — unassigned Assign link and assign-more", () => {
  async function renderList() {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText("Chapter 1 guide");
    return user;
  }

  it("offers the Assign link on a complete, unassigned guide and opens the assign dialog from it", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    const user = await renderList();

    const cue = screen.getByTestId(`sg-needs-assign-${GUIDE}`);
    await user.click(cue);
    expect(await screen.findByTestId("assign-dialog")).toBeInTheDocument();
  });

  it("withholds the Assign link on an incomplete unassigned guide — that one is blocked, not ready", async () => {
    seedGuide({ total: 2, withQuestions: 1 });
    await renderList();

    expect(screen.queryByTestId(`sg-needs-assign-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`sg-assign-blocked-${GUIDE}`)).toBeInTheDocument();
  });

  it("withholds the Assign link on an assigned guide", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    await renderList();

    expect(screen.queryByTestId(`sg-needs-assign-${GUIDE}`)).not.toBeInTheDocument();
  });

  it("offers assign-more on a complete assigned guide and opens the dialog", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    seedAssignment("off-1");
    const user = await renderList();

    await user.click(screen.getByTestId(`sg-assign-more-${GUIDE}`));
    expect(await screen.findByTestId("assign-dialog")).toBeInTheDocument();
  });

  it("withholds assign-more while the guide is incomplete", async () => {
    // The gate refuses additions on an incomplete guide, so the button would be
    // a dead end. The badges stay — removal must remain reachable.
    seedGuide({ total: 2, withQuestions: 1 });
    seedAssignment("off-1");
    await renderList();

    expect(screen.queryByTestId(`sg-assign-more-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.getByText("Math 101")).toBeInTheDocument();
  });

  it("withholds the dedicated Assign link while the assignment state is still loading", async () => {
    // An empty target list during load is "unknown", not "unassigned" — a
    // guide that is in fact assigned must not present as needing assignment.
    // The badges' own ghost Assign link is the honest fallback.
    seedGuide({ total: 2, withQuestions: 2 });
    hookState.loading = true;
    await renderList();

    expect(screen.queryByTestId(`sg-needs-assign-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`sg-assign-more-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign" })).toBeInTheDocument();
  });

  it("withholds the dedicated Assign link and shows an alert when the assignment read failed", async () => {
    seedGuide({ total: 2, withQuestions: 2 });
    hookState.error = "boom";
    await renderList();

    expect(screen.queryByTestId(`sg-needs-assign-${GUIDE}`)).not.toBeInTheDocument();
    expect(screen.getByTestId("sg-assignments-error")).toBeInTheDocument();
  });
});

/**
 * The author + assignment filters (the AssessmentList pattern, #1316).
 *
 * Filtering is keyed by `created_by`, not the display name, and the status
 * split reads the same `isAssigned` the rest of the row does — so what a chip
 * hides is exactly what its badge marked.
 */
describe("StudyGuideManager — author and assignment filters", () => {
  const GUIDE_2 = "guide-2";

  /** Two complete guides by different authors; the first one assigned. */
  function seedTwoGuides() {
    seedGuide({ total: 1, withQuestions: 1, createdBy: "user-alice" });
    seedGuide({
      id: GUIDE_2,
      title: "Chapter 2 guide",
      total: 1,
      withQuestions: 1,
      createdBy: "user-bob",
    });
    seedAssignment("off-1");
  }

  async function renderList() {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText("Chapter 1 guide");
    return user;
  }

  it("shows the resolved author under the title", async () => {
    seedTwoGuides();
    await renderList();

    expect(screen.getByText("Alice Instructor")).toBeInTheDocument();
    expect(screen.getByText("Bob Instructor")).toBeInTheDocument();
  });

  it("hides guides whose status chip is toggled off", async () => {
    seedTwoGuides();
    const user = await renderList();

    await user.click(screen.getByTestId("sg-status-chip-assigned"));

    expect(screen.queryByText("Chapter 1 guide")).not.toBeInTheDocument();
    expect(screen.getByText("Chapter 2 guide")).toBeInTheDocument();

    // And the mirror image, so the chip filters by status rather than by row.
    await user.click(screen.getByTestId("sg-status-chip-assigned"));
    await user.click(screen.getByTestId("sg-status-chip-unassigned"));

    expect(screen.getByText("Chapter 1 guide")).toBeInTheDocument();
    expect(screen.queryByText("Chapter 2 guide")).not.toBeInTheDocument();
  });

  it("narrows to the selected author", async () => {
    seedTwoGuides();
    const user = await renderList();

    await user.click(screen.getByTestId("sg-author-filter"));
    await user.click(await screen.findByTestId("sg-author-filter-option-user-alice"));

    expect(screen.getByText("Chapter 1 guide")).toBeInTheDocument();
    expect(screen.queryByText("Chapter 2 guide")).not.toBeInTheDocument();
  });

  it("says so, rather than showing an empty table, when nothing matches", async () => {
    seedGuide({ total: 1, withQuestions: 1, createdBy: "user-alice" });
    seedAssignment("off-1");
    const user = await renderList();

    await user.click(screen.getByTestId("sg-status-chip-assigned"));

    expect(screen.getByText("No study guides match the current filters")).toBeInTheDocument();
  });

  it("hides the status chips and does not status-filter while assignments load", async () => {
    // Chips claiming "Unassigned 2" during load would be a lie, and a
    // remembered chip toggle must not hide rows on unknown data.
    seedTwoGuides();
    hookState.loading = true;
    await renderList();

    expect(screen.queryByTestId("sg-status-chip-assigned")).not.toBeInTheDocument();
    expect(screen.getByText("Chapter 1 guide")).toBeInTheDocument();
    expect(screen.getByText("Chapter 2 guide")).toBeInTheDocument();
  });

  it("clear filters restores every row", async () => {
    seedTwoGuides();
    const user = await renderList();

    await user.click(screen.getByTestId("sg-status-chip-assigned"));
    await user.click(screen.getByTestId("sg-author-filter"));
    await user.click(await screen.findByTestId("sg-author-filter-option-user-alice"));
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("sg-clear-filters"));

    expect(screen.getByText("Chapter 1 guide")).toBeInTheDocument();
    expect(screen.getByText("Chapter 2 guide")).toBeInTheDocument();
  });
});
