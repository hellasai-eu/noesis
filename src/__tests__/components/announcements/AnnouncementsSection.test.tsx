import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

type QueryResult = { data: unknown[] | null; error: unknown };

const upsertMock = vi.fn().mockResolvedValue({ data: null, error: null });
const deleteMock = vi.fn().mockResolvedValue({ data: null, error: null });

type TableHandler = (builder: QueryBuilder) => Promise<QueryResult>;

class QueryBuilder implements PromiseLike<QueryResult> {
  filters: Record<string, unknown> = {};
  ordering: { column: string; ascending: boolean } | null = null;
  ins: Record<string, unknown[]> = {};
  constructor(private handler: TableHandler) {}
  select() {
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters[col] = value;
    return this;
  }
  in(col: string, values: unknown[]) {
    this.ins[col] = values;
    return this;
  }
  order(column: string, opts: { ascending?: boolean } = {}) {
    this.ordering = { column, ascending: opts.ascending ?? true };
    return this;
  }
  then<TResult1 = QueryResult, TResult2 = never>(
    onFulfilled?: ((v: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.handler(this).then(onFulfilled ?? undefined, onRejected ?? undefined);
  }
}

interface AnnouncementRow {
  id: string;
  course_id: string;
  author_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  announcement_offerings: { offering_id: string }[];
}

const ANNOUNCEMENTS: AnnouncementRow[] = [
  {
    id: "a1",
    course_id: "course-1",
    author_id: "user-author",
    title: "Welcome all",
    body: "Hello class",
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    expires_at: null,
    announcement_offerings: [],
  },
  {
    id: "a2",
    course_id: "course-1",
    author_id: "user-author",
    title: "Section A only",
    body: "Quiz tomorrow",
    created_at: "2026-04-15T10:00:00.000Z",
    updated_at: "2026-04-15T10:00:00.000Z",
    expires_at: null,
    announcement_offerings: [{ offering_id: "off-a" }],
  },
  {
    id: "a3",
    course_id: "course-1",
    author_id: "user-author",
    title: "Section B only",
    body: "Only for B",
    created_at: "2026-04-16T10:00:00.000Z",
    updated_at: "2026-04-16T10:00:00.000Z",
    expires_at: null,
    announcement_offerings: [{ offering_id: "off-b" }],
  },
  {
    id: "a4",
    course_id: "course-1",
    author_id: "user-author",
    title: "Old news",
    body: "Long expired",
    created_at: "2026-03-10T10:00:00.000Z",
    updated_at: "2026-03-10T10:00:00.000Z",
    expires_at: "2026-03-20T23:59:59.000Z",
    announcement_offerings: [{ offering_id: "off-a" }],
  },
];

const PROFILES = [{ user_id: "user-author", full_name: "Prof. Smith" }];

let readsData: { announcement_id: string }[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "class_announcements") {
        return new QueryBuilder(async (builder) => {
          const sorted = [...ANNOUNCEMENTS].sort((a, b) => {
            const aVal = a[builder.ordering?.column as keyof typeof a] ?? "";
            const bVal = b[builder.ordering?.column as keyof typeof b] ?? "";
            // eslint-disable-next-line no-restricted-syntax -- fixture ordering; nothing here is read by a user.
            const cmp = String(aVal).localeCompare(String(bVal));
            return builder.ordering?.ascending ? cmp : -cmp;
          });
          return { data: sorted, error: null };
        });
      }
      if (table === "announcement_reads") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: readsData, error: null }),
            }),
          }),
          upsert: upsertMock,
          // Un-marking deletes the receipt: .delete().eq(announcement).eq(user)
          delete: () => ({
            eq: (_c1: string, announcementId: string) => ({
              eq: (_c2: string, userId: string) =>
                deleteMock({ announcementId, userId }),
            }),
          }),
        } as unknown as QueryBuilder;
      }
      if (table === "profiles") {
        return new QueryBuilder(async () => ({ data: PROFILES, error: null }));
      }
      return new QueryBuilder(async () => ({ data: [], error: null }));
    },
  },
}));

import { AnnouncementsSection } from "@/components/announcements/AnnouncementsSection";

function renderWithClient(allOfferingIds: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AnnouncementsSection
        courseId="course-1"
        allOfferingIds={allOfferingIds}
        userId="student-1"
      />
    </QueryClientProvider>,
  );
}

/**
 * Renders with one scope and lets a test swap in another, sharing a client.
 *
 * `settled` resolves when the query for a given scope has actually produced
 * data. An empty scope renders nothing at all, so there is no DOM to wait on —
 * and without waiting, a test would swap scopes before the first query ever
 * resolved and would therefore never exercise what it claims to.
 */
function renderWithScope(allOfferingIds: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const ui = (ids: string[]) => (
    <QueryClientProvider client={client}>
      <AnnouncementsSection courseId="course-1" allOfferingIds={ids} userId="student-1" />
    </QueryClientProvider>
  );
  const view = render(ui(allOfferingIds));
  const keyFor = (ids: string[]) => [
    "student-class-announcements",
    "course-1",
    [...ids].sort().join(","),
    "student-1",
  ];
  return {
    ...view,
    setScope: (ids: string[]) => view.rerender(ui(ids)),
    settled: (ids: string[]) =>
      waitFor(() => expect(client.getQueryData(keyFor(ids))).toBeDefined()),
  };
}

describe("AnnouncementsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMock.mockResolvedValue({ data: null, error: null });
    deleteMock.mockResolvedValue({ data: null, error: null });
    readsData = [];
  });

  it("hides announcements with no targeted offerings from students", async () => {
    renderWithClient(["off-a"]);
    await waitFor(() => {
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
    expect(screen.queryByText("Welcome all")).not.toBeInTheDocument();
  });

  it("includes announcements targeted at the student's enrolled offering", async () => {
    renderWithClient(["off-a"]);
    await waitFor(() => {
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
    expect(screen.queryByText("Section B only")).not.toBeInTheDocument();
  });

  it("omits announcements targeted only at sections the student is not in", async () => {
    renderWithClient(["off-b"]);
    await waitFor(() => {
      expect(screen.getByText("Section B only")).toBeInTheDocument();
    });
    expect(screen.queryByText("Section A only")).not.toBeInTheDocument();
    expect(screen.queryByText("Welcome all")).not.toBeInTheDocument();
  });

  it("omits unread badge when all visible announcements are already read", async () => {
    readsData = [{ announcement_id: "a2" }];
    renderWithClient(["off-a"]);
    await waitFor(() => {
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
    expect(screen.queryByText(/ new$/)).not.toBeInTheDocument();
  });

  it("does not mark anything read just because the section rendered", async () => {
    // This used to be the behaviour: an effect marked everything the section
    // displayed as read on mount. "Unread" then meant "you have never loaded
    // this course page", which told nobody anything — the student did not have
    // to look at the announcement, or even expand the section.
    renderWithClient(["off-a"]);
    await waitFor(() => {
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(await screen.findByText("1 new")).toBeInTheDocument();
  });

  it("records a read receipt when the student ticks the box", async () => {
    const user = userEvent.setup();
    renderWithClient(["off-a"]);
    await screen.findByText("Section A only");

    await user.click(await screen.findByLabelText("Mark as read"));

    await waitFor(() => expect(upsertMock).toHaveBeenCalled());
    expect(upsertMock.mock.calls[0][0]).toEqual([
      { announcement_id: "a2", user_id: "student-1" },
    ]);
  });

  it("withdraws the receipt when the student unticks it", async () => {
    // The DELETE policy on announcement_reads has existed since the table did,
    // for exactly this. A student who ticks the wrong row can put it back.
    const user = userEvent.setup();
    readsData = [{ announcement_id: "a2" }];
    renderWithClient(["off-a"]);

    // Everything is read, so the section arrives folded — expand it to reach
    // the control.
    await user.click(await screen.findByLabelText("Expand announcements"));
    await screen.findByText("Section A only");

    await user.click(await screen.findByLabelText("Read"));

    await waitFor(() => expect(deleteMock).toHaveBeenCalled());
    expect(deleteMock).toHaveBeenCalledWith({
      announcementId: "a2",
      userId: "student-1",
    });
  });

  it("hides expired announcements from the active list and shows them behind the Archived toggle", async () => {
    const user = userEvent.setup();
    renderWithClient(["off-a"]);
    await waitFor(() => {
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
    expect(screen.queryByText("Old news")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Archived/i }));
    expect(await screen.findByText("Old news")).toBeInTheDocument();
  });

  it("excludes archived announcements from the unread count", async () => {
    renderWithClient(["off-a"]);
    await waitFor(() => {
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
    // Only a2 is active and unread; a4 is expired and must not bump the count.
    expect(screen.getByText(/^1 new$/)).toBeInTheDocument();
  });
  // The heading used to carry two badges: an unread count, and — always — the
  // number of active announcements. The second read as a notification count
  // that never cleared, because it counted announcements rather than unread
  // ones. Only the one that can clear survives.
  describe("the heading badge", () => {
    it("shows the unread count while something is unread", async () => {
      renderWithClient(["off-a"]);
      expect(await screen.findByText("1 new")).toBeInTheDocument();
    });

    it("shows no badge at all once everything is read", async () => {
      readsData = [{ announcement_id: "a2" }, { announcement_id: "a4" }];
      renderWithClient(["off-a"]);

      await waitFor(() => {
        expect(screen.getByText("Section A only")).toBeInTheDocument();
      });
      // Scoped to the heading: the Archived control carries a count of its
      // own, and that one is a real total the student asked to see.
      expect(screen.getByTestId("announcements-heading").textContent?.trim()).toBe(
        "Announcements",
      );
    });

    it("clears once the student marks the announcement read", async () => {
      const user = userEvent.setup();
      renderWithClient(["off-a"]);
      await screen.findByText("1 new");

      // The refetch after the write is what the badge follows, so the mock has
      // to start reporting the receipt the component just recorded.
      upsertMock.mockImplementationOnce(async () => {
        readsData = [{ announcement_id: "a2" }];
        return { data: null, error: null };
      });
      await user.click(await screen.findByLabelText("Mark as read"));

      await waitFor(() => {
        expect(screen.getByTestId("announcements-heading").textContent?.trim()).toBe(
          "Announcements",
        );
      });
      // The announcement itself is still on screen — only the badge went.
      expect(screen.getByText("Section A only")).toBeInTheDocument();
    });
  });
  // Folded on arrival when there is nothing to act on. The section sits at the
  // top of the course page, so a student who has read everything should not
  // have to scroll past it every visit.
  describe("initial fold", () => {
    it("arrives folded when everything is already read", async () => {
      readsData = [{ announcement_id: "a2" }, { announcement_id: "a4" }];
      renderWithClient(["off-a"]);

      // The header is present...
      expect(await screen.findByTestId("announcements-heading")).toBeInTheDocument();
      // ...and the control offers to expand, meaning it is collapsed.
      expect(screen.getByLabelText("Expand announcements")).toBeInTheDocument();
      expect(screen.queryByText("Section A only")).not.toBeInTheDocument();
    });

    it("arrives open when something is unread", async () => {
      renderWithClient(["off-a"]);

      expect(await screen.findByText("Section A only")).toBeInTheDocument();
      expect(screen.getByLabelText("Collapse announcements")).toBeInTheDocument();
    });

    it("does not fold under the student when they mark the last one read", async () => {
      // Marking read triggers a refetch, and re-deriving the fold from every
      // result would make the section vanish from under the click that caused
      // it. The fold is applied once, on first load.
      const user = userEvent.setup();
      renderWithClient(["off-a"]);
      await screen.findByText("Section A only");

      upsertMock.mockImplementationOnce(async () => {
        readsData = [{ announcement_id: "a2" }];
        return { data: null, error: null };
      });
      await user.click(await screen.findByLabelText("Mark as read"));

      // Badge cleared, so the refetch landed...
      await waitFor(() => {
        expect(screen.getByTestId("announcements-heading").textContent?.trim()).toBe(
          "Announcements",
        );
      });
      // ...and the section is still open.
      expect(screen.getByText("Section A only")).toBeInTheDocument();
      expect(screen.getByLabelText("Collapse announcements")).toBeInTheDocument();
    });

    it("does not fold on the empty scope the page renders first", async () => {
      // `allOfferingIds` is populated asynchronously and `course` lands first,
      // so the section's first query runs with no offerings. Every
      // announcement is filtered out as untargeted, producing a truthy but
      // empty result. Folding on that decided the question before the real
      // scope had been asked — and since the fold is one-shot, the unread
      // announcements arriving a moment later could not undo it.
      const { setScope, settled } = renderWithScope([]);

      // The empty-scope query must genuinely RESOLVE before the scope widens.
      // That result is what the fold used to latch on; swapping earlier would
      // test nothing.
      await settled([]);
      expect(screen.queryByTestId("announcements-heading")).not.toBeInTheDocument();

      setScope(["off-a"]);

      // The real scope has an unread announcement, so the section arrives open.
      expect(await screen.findByText("Section A only")).toBeInTheDocument();
      expect(screen.getByLabelText("Collapse announcements")).toBeInTheDocument();
      expect(screen.getByText("1 new")).toBeInTheDocument();
    });

    it("stays where the student put it across a refetch", async () => {
      // The query refetches on an interval; springing the section shut under
      // someone who had just opened it would be worse than never folding.
      //
      // Unticking is a real refetch — the mutation invalidates the query — so
      // this exercises the reconciliation rather than just toggling the
      // control twice, which would prove nothing.
      const user = userEvent.setup();
      readsData = [{ announcement_id: "a2" }, { announcement_id: "a4" }];
      renderWithClient(["off-a"]);

      await user.click(await screen.findByLabelText("Expand announcements"));
      expect(await screen.findByText("Section A only")).toBeInTheDocument();

      deleteMock.mockImplementationOnce(async () => {
        readsData = [{ announcement_id: "a4" }];
        return { data: null, error: null };
      });
      await user.click(screen.getByLabelText("Read"));

      // The refetch landed — the announcement is unread again...
      expect(await screen.findByText("1 new")).toBeInTheDocument();
      // ...and the section the student opened is still open.
      expect(screen.getByText("Section A only")).toBeInTheDocument();
      expect(screen.getByLabelText("Collapse announcements")).toBeInTheDocument();
    });
  });
});
