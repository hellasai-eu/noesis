/**
 * #1100 — SpacedRepetitionReview: the session builder and the review write.
 *
 * `processReview`, `isDue` and `sortForReview` have their own lib tests. What
 * had none is everything this component decides around them, and that is where
 * a student's day actually goes wrong:
 *
 *  - the DAILY QUOTAS. New and due cards have separate budgets, and the counts
 *    that spend them are derived — `repetitions === 1` means "first review, and
 *    it happened today", `> 1` means a repeat. Getting that split wrong either
 *    hands out a second session or locks a student out of a first one.
 *  - the "today" window. The spend is read with a `gte` on `last_reviewed`;
 *    without it every review ever made counts against today and the student is
 *    permanently done.
 *  - session COMPOSITION: due before new, only genuinely due cards, and when a
 *    quota truncates the due list it must keep the most overdue — the whole
 *    point of running `sortForReview` before `slice`.
 *  - the keyboard map, which is INVERTED against the enum: "1" is Easy
 *    (`Rating.EASY === 3`), "4" is Again (`Rating.AGAIN === 0`). A "fix" that
 *    made the digits line up with the enum would silently record the opposite
 *    of what every student pressed.
 *  - the upsert payload and its conflict target, which is what makes a review
 *    idempotent per (user, chapter, card) rather than appending rows.
 *
 * Time is left real: fixtures use dates far enough from now that the machine's
 * clock and timezone cannot flip them. The "reviewed today" window is modelled
 * by which filters the query carries rather than by a simulated clock, so that
 * dropping the filter is a visible behaviour change (see the quota tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Filter = { op: string; col: string; val: unknown };

const db = vi.hoisted(() => ({
  /** Rows the `gte last_reviewed` query sees — i.e. reviewed since midnight. */
  reviewedToday: [] as Array<{ repetitions: number }>,
  /** Every review row for this user/course, whenever it happened. */
  reviews: [] as Array<Record<string, unknown>>,
  materials: [] as Array<{ id: string }>,
  chapters: [] as Array<{
    id: string;
    title: string;
    chapter_number: number;
    material_id: string;
    flashcards_visible: boolean;
    flashcards: Array<{ front: string; back: string }>;
  }>,
  errors: {} as Record<string, { message: string } | undefined>,
  upsertError: null as { message: string } | null,
  upserts: [] as Array<{ row: Record<string, unknown>; opts: unknown }>,
  queries: [] as Array<{ table: string; filters: Array<{ op: string; col: string; val: unknown }> }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const resolveQuery = (table: string, filters: Filter[]) => {
    db.queries.push({ table, filters });
    const failure = db.errors[table];
    if (failure) return { data: null, error: failure };

    const find = (op: string, col: string) =>
      filters.find((f) => f.op === op && f.col === col);

    if (table === "flashcard_reviews") {
      // The only thing separating "reviewed today" from "every review" is the
      // `gte` on last_reviewed. Modelling it this way means deleting the filter
      // makes the today-count see the whole history — which is exactly the bug.
      return {
        data: find("gte", "last_reviewed") ? db.reviewedToday : db.reviews,
        error: null,
      };
    }

    if (table === "course_materials") {
      return { data: db.materials.map((m) => ({ ...m })), error: null };
    }

    if (table === "material_chapters") {
      const byId = find("in", "id");
      const byMaterial = find("in", "material_id");
      const visibleOnly = find("eq", "flashcards_visible");
      const rows = db.chapters.filter((c) => {
        if (byId && !(byId.val as string[]).includes(c.id)) return false;
        if (byMaterial && !(byMaterial.val as string[]).includes(c.material_id)) return false;
        if (visibleOnly && c.flashcards_visible !== visibleOnly.val) return false;
        return true;
      });
      return { data: rows.map((c) => ({ ...c })), error: null };
    }

    return { data: [], error: null };
  };

  const buildChain = (table: string) => {
    const filters: Filter[] = [];
    const chain: Record<string, unknown> = {};
    const push = (op: string) => (col: string, val: unknown) => {
      filters.push({ op, col, val });
      return chain;
    };
    chain.select = () => chain;
    chain.order = () => chain;
    chain.eq = push("eq");
    chain.in = push("in");
    chain.gte = push("gte");
    chain.upsert = (row: Record<string, unknown>, opts: unknown) => {
      db.upserts.push({ row, opts });
      return Promise.resolve({ data: null, error: db.upsertError });
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(resolveQuery(table, filters)));
    return chain;
  };

  return { supabase: { from: vi.fn((table: string) => buildChain(table)) } };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

// The identity of `user` is an effect dependency, so it has to be stable —
// a fresh object per render re-runs the loader forever.
const auth = vi.hoisted(() => ({ user: { id: "student-1" } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));

/** The calendar is a sibling component with its own concerns; stub it out. */
vi.mock("@/components/FlashcardCalendarView", () => ({
  default: () => <div data-testid="calendar" />,
}));

import SpacedRepetitionReview from "@/components/SpacedRepetitionReview";

const COURSE = "course-1";
const PAST = "2020-01-01T00:00:00.000Z";
const VERY_PAST = "2019-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

/** A chapter carrying `cards.length` flashcards, all visible by default. */
function seedChapter(
  id: string,
  flashcards: Array<{ front: string; back: string }>,
  opts: { visible?: boolean; number?: number; title?: string } = {},
) {
  db.materials.push({ id: `mat-${id}` });
  db.chapters.push({
    id,
    title: opts.title ?? `Chapter ${id}`,
    chapter_number: opts.number ?? db.chapters.length + 1,
    material_id: `mat-${id}`,
    flashcards_visible: opts.visible ?? true,
    flashcards,
  });
}

/** An existing review state for one card — this is what makes it a "due" card. */
function seedReview(chapterId: string, index: number, dueDate: string, repetitions = 2) {
  db.reviews.push({
    chapter_id: chapterId,
    flashcard_index: index,
    repetitions,
    interval_days: 1,
    ease_factor: 2.5,
    due_date: dueDate,
    last_reviewed: PAST,
  });
}

/** `n` cards named `<prefix> front|back 1..n`, so a test can name an exact card. */
function cards(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    front: `${prefix} front ${i + 1}`,
    back: `${prefix} back ${i + 1}`,
  }));
}

function renderReview(props: { chapterIds?: string[] } = {}) {
  const onClose = vi.fn();
  render(<SpacedRepetitionReview courseId={COURSE} onClose={onClose} {...props} />);
  return { onClose };
}

/** The card surface is a clickable div, not a <button>. */
async function flashcardSurface(frontText: string) {
  const el = (await screen.findByText(frontText)).closest('[role="button"]');
  if (!el) throw new Error(`no flashcard surface around "${frontText}"`);
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reviewedToday = [];
  db.reviews = [];
  db.materials = [];
  db.chapters = [];
  db.errors = {};
  db.upsertError = null;
  db.upserts = [];
  db.queries = [];
});

describe("SpacedRepetitionReview — session composition", () => {
  it("puts due cards before new ones", async () => {
    seedChapter("ch-1", cards("A", 2));
    // Only A-2 has ever been reviewed, and it is overdue.
    seedReview("ch-1", 1, PAST);

    renderReview();

    await screen.findByText("A front 2");
    expect(screen.getByText("1 due cards")).toBeInTheDocument();
    expect(screen.getByText("1 new cards")).toBeInTheDocument();
    // The due card is first: the new one is not on screen yet.
    expect(screen.queryByText("A front 1")).not.toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("leaves out a reviewed card whose next review is still in the future", async () => {
    seedChapter("ch-1", cards("A", 2));
    seedReview("ch-1", 0, FUTURE);
    seedReview("ch-1", 1, FUTURE);

    renderReview();

    // Both cards are known, neither is due, and there are no new cards left.
    expect(await screen.findByText("All Done for Today!")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // total cards learned
  });

  it("keeps the most overdue card when the due quota truncates the list", async () => {
    seedChapter("ch-1", cards("A", 2));
    seedReview("ch-1", 0, PAST); // overdue
    seedReview("ch-1", 1, VERY_PAST); // MORE overdue
    // 14 repeats already today leaves room for exactly one more due card.
    db.reviewedToday = Array.from({ length: 14 }, () => ({ repetitions: 2 }));

    renderReview();

    expect(await screen.findByText("A front 2")).toBeInTheDocument();
    expect(screen.queryByText("A front 1")).not.toBeInTheDocument();
    expect(screen.getByText("1 left")).toBeInTheDocument();
  });

  it("hands out only the new cards today's quota still allows", async () => {
    seedChapter("ch-1", cards("A", 5));
    // 8 first-ever reviews today: 2 of the 10 new-card budget remain.
    db.reviewedToday = Array.from({ length: 8 }, () => ({ repetitions: 1 }));

    renderReview();

    await screen.findByText("A front 1");
    expect(screen.getByText("2 left")).toBeInTheDocument();
    expect(screen.getByText("2 new cards")).toBeInTheDocument();
  });

  it("counts repeats against the due budget and firsts against the new one", async () => {
    seedChapter("ch-1", cards("A", 5));
    // 10 repeats: the DUE budget is spent, the NEW one is untouched.
    db.reviewedToday = Array.from({ length: 10 }, () => ({ repetitions: 4 }));

    renderReview();

    // All five cards are new, so a spent due budget must not block them.
    await screen.findByText("A front 1");
    expect(screen.getByText("5 new cards")).toBeInTheDocument();
  });

  it("stops the session — without even loading chapters — once both budgets are spent", async () => {
    seedChapter("ch-1", cards("A", 5));
    db.reviewedToday = [
      ...Array.from({ length: 10 }, () => ({ repetitions: 1 })),
      ...Array.from({ length: 15 }, () => ({ repetitions: 3 })),
    ];

    renderReview();

    expect(await screen.findByText("All Done for Today!")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    // Nothing further is fetched — the early return happens before the chapters.
    expect(db.queries.some((q) => q.table === "material_chapters")).toBe(false);
    expect(db.queries.some((q) => q.table === "course_materials")).toBe(false);
  });

  it("does not spend today's quota on reviews from previous days", async () => {
    seedChapter("ch-1", cards("A", 3));
    // A full history of first reviews, none of them today.
    db.reviews = Array.from({ length: 12 }, (_, i) => ({
      chapter_id: "ch-other",
      flashcard_index: i,
      repetitions: 1,
      interval_days: 1,
      ease_factor: 2.5,
      due_date: FUTURE,
      last_reviewed: PAST,
    }));
    db.reviewedToday = [];

    renderReview();

    // The three cards of ch-1 are untouched and still new, so the full new
    // budget is available: nothing here was reviewed *today*.
    await screen.findByText("A front 1");
    expect(screen.getByText("3 new cards")).toBeInTheDocument();
    const todayQuery = db.queries.find(
      (q) => q.table === "flashcard_reviews" && q.filters.some((f) => f.op === "gte"),
    );
    expect(todayQuery).toBeDefined();
    expect(todayQuery!.filters.find((f) => f.op === "gte")!.col).toBe("last_reviewed");
  });

  it("scopes the fetch to this student and course", async () => {
    seedChapter("ch-1", cards("A", 1));

    renderReview();

    await screen.findByText("A front 1");
    const reviewQuery = db.queries.find((q) => q.table === "flashcard_reviews")!;
    expect(reviewQuery.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", col: "user_id", val: "student-1" },
        { op: "eq", col: "course_id", val: COURSE },
      ]),
    );
  });

  it("restricts the session to the requested chapters, and only visible decks", async () => {
    seedChapter("ch-1", cards("A", 1));
    seedChapter("ch-2", cards("B", 1));
    seedChapter("ch-3", cards("C", 1), { visible: false });

    renderReview({ chapterIds: ["ch-2", "ch-3"] });

    expect(await screen.findByText("B front 1")).toBeInTheDocument();
    expect(screen.getByText("1 new cards")).toBeInTheDocument();
    // Chapter-scoped sessions skip the course-wide material lookup entirely.
    expect(db.queries.some((q) => q.table === "course_materials")).toBe(false);
  });

  it("reports a failed load instead of showing an empty deck as success", async () => {
    seedChapter("ch-1", cards("A", 1));
    db.errors.flashcard_reviews = { message: "boom" };

    renderReview();

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to load flashcards"),
    );
  });
});

describe("SpacedRepetitionReview — rating a card", () => {
  it("writes one row per (user, chapter, card) rather than appending reviews", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 1));

    renderReview();
    await user.click(await flashcardSurface("A front 1"));
    await user.click(await screen.findByRole("button", { name: /Good/ }));

    await waitFor(() => expect(db.upserts).toHaveLength(1));
    expect(db.upserts[0].row).toMatchObject({
      user_id: "student-1",
      course_id: COURSE,
      chapter_id: "ch-1",
      flashcard_index: 0,
      repetitions: 1,
    });
    expect(db.upserts[0].opts).toEqual({
      onConflict: "user_id,chapter_id,flashcard_index",
    });
  });

  it("carries the existing repetition count forward for a card seen before", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 1));
    seedReview("ch-1", 0, PAST, 4);

    renderReview();
    await user.click(await flashcardSurface("A front 1"));
    await user.click(await screen.findByRole("button", { name: /Good/ }));

    await waitFor(() => expect(db.upserts).toHaveLength(1));
    expect(db.upserts[0].row.repetitions).toBe(5);
  });

  it('maps the "1" key to Easy, not to Again', async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 1));

    renderReview();
    await screen.findByText("A front 1");
    await user.keyboard(" ");
    await user.keyboard("1");

    // A first Easy review is a full day out; a first Again is ten minutes.
    await waitFor(() => expect(db.upserts).toHaveLength(1));
    expect(db.upserts[0].row.interval_days).toBe(1);
  });

  it('maps the "4" key to Again, not to Easy', async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 1));

    renderReview();
    await screen.findByText("A front 1");
    await user.keyboard(" ");
    await user.keyboard("4");

    await waitFor(() => expect(db.upserts).toHaveLength(1));
    expect(db.upserts[0].row.interval_days as number).toBeCloseTo(10 / 1440, 6);
  });

  it("ignores rating keys while the card is still face down", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 1));

    renderReview();
    await screen.findByText("A front 1");
    await user.keyboard("1");

    expect(screen.getByText("A front 1")).toBeInTheDocument();
    expect(db.upserts).toHaveLength(0);
  });

  it("leaves typing in a text field alone", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 1));

    renderReview();
    await screen.findByText("A front 1");

    const input = document.createElement("input");
    document.body.appendChild(input);
    await user.click(input);
    await user.keyboard(" 1");

    // Space did not flip the card, so the rating buttons never appeared.
    expect(screen.queryByRole("button", { name: /Easy/ })).not.toBeInTheDocument();
    expect(db.upserts).toHaveLength(0);
    input.remove();
  });

  it("advances to the next card and shows it face down", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 2));

    renderReview();
    await user.click(await flashcardSurface("A front 1"));
    await user.click(await screen.findByRole("button", { name: /Good/ }));

    expect(await screen.findByText("A front 2")).toBeInTheDocument();
    expect(screen.getByText("1 left")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Good/ })).not.toBeInTheDocument();
  });

  it("scores Again as a miss and everything else as a hit", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 2));

    renderReview();
    await user.click(await flashcardSurface("A front 1"));
    await user.click(await screen.findByRole("button", { name: /Again/ }));
    await user.click(await flashcardSurface("A front 2"));
    await user.click(await screen.findByRole("button", { name: /Hard/ }));

    expect(await screen.findByText("Session Complete!")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("To Relearn").previousElementSibling).toHaveTextContent("1");
  });

  it("keeps the student on the card when the review fails to save", async () => {
    const user = userEvent.setup();
    seedChapter("ch-1", cards("A", 2));
    db.upsertError = { message: "nope" };

    renderReview();
    await user.click(await flashcardSurface("A front 1"));
    await user.click(await screen.findByRole("button", { name: /Good/ }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Failed to save review"),
    );
    expect(screen.getByText("A front 1")).toBeInTheDocument();
    expect(screen.queryByText("A front 2")).not.toBeInTheDocument();
  });
});
