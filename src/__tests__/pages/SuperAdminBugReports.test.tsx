/**
 * #1100 — SuperAdminBugReports: the inbox's gate, and its two destructive
 * actions. The page is also E2E-quarantined (#1068), so until that lifts these
 * are the only tests it has.
 *
 * What is worth pinning:
 *
 *  - the ACCESS GATE. `is_super_admin` is asked once and everything hangs off
 *    it: a non-super-admin must see Access Denied *and* must never have caused
 *    a `bug_reports` read. Reports carry other institutions' page URLs, user
 *    agents and screenshots, so "fetch then hide" is not equivalent to "do not
 *    fetch". An RPC that errors has to fail closed the same way.
 *  - the STATUS WRITE, which updates two places from one response — the row in
 *    the table behind the dialog and the dialog's own select. Updating only one
 *    leaves the admin looking at a value the list contradicts.
 *  - the DELETE ORDER. Screenshots are removed from storage BEFORE the row,
 *    because the row is the only record of where those files live; deleting it
 *    first orphans them in the bucket forever. Storage failure is deliberately
 *    non-fatal — losing the report to a stuck file would be worse — while a
 *    failed row delete must leave the list untouched.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Filter = { op: string; col: string; val: unknown };

const db = vi.hoisted(() => ({
  isSuperAdmin: true,
  rpcError: null as { message: string } | null,
  reports: [] as Array<Record<string, unknown>>,
  selectError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  storageRemoveError: null as { message: string } | null,
  signedUrlError: null as { message: string } | null,
  updates: [] as Array<{ values: Record<string, unknown>; filters: Filter[] }>,
  deletes: [] as Array<{ filters: Filter[] }>,
  /** Ordered log of the destructive calls, so their sequence is assertable. */
  calls: [] as string[],
  storageRemoved: [] as string[][],
  signedFor: [] as Array<{ paths: string[]; expiresIn: number }>,
  selects: [] as Array<{ table: string; order: Array<{ col: string; opts: unknown }> }>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const filters: Filter[] = [];
    const order: Array<{ col: string; opts: unknown }> = [];
    const chain: Record<string, unknown> = {};
    let mode: "select" | "update" | "delete" = "select";
    let values: Record<string, unknown> = {};

    chain.select = () => {
      mode = "select";
      return chain;
    };
    chain.update = (v: Record<string, unknown>) => {
      mode = "update";
      values = v;
      return chain;
    };
    chain.delete = () => {
      mode = "delete";
      return chain;
    };
    chain.order = (col: string, opts: unknown) => {
      order.push({ col, opts });
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters.push({ op: "eq", col, val });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "update") {
        db.calls.push(`update:${table}`);
        db.updates.push({ values, filters });
        return Promise.resolve(resolve({ data: null, error: db.updateError }));
      }
      if (mode === "delete") {
        db.calls.push(`delete:${table}`);
        db.deletes.push({ filters });
        return Promise.resolve(resolve({ data: null, error: db.deleteError }));
      }
      db.calls.push(`select:${table}`);
      db.selects.push({ table, order });
      return Promise.resolve(
        resolve(
          db.selectError
            ? { data: null, error: db.selectError }
            : { data: db.reports.map((r) => ({ ...r })), error: null },
        ),
      );
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      rpc: vi.fn(async () => ({
        data: db.isSuperAdmin,
        error: db.rpcError,
      })),
      storage: {
        from: vi.fn(() => ({
          createSignedUrls: vi.fn(async (paths: string[], expiresIn: number) => {
            db.signedFor.push({ paths, expiresIn });
            if (db.signedUrlError) return { data: null, error: db.signedUrlError };
            return {
              data: paths.map((p) => ({ signedUrl: `https://signed.test/${p}` })),
              error: null,
            };
          }),
          remove: vi.fn(async (paths: string[]) => {
            db.calls.push("storage:remove");
            db.storageRemoved.push(paths);
            return { data: null, error: db.storageRemoveError };
          }),
        })),
      },
    },
  };
});

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

const auth = vi.hoisted(() => ({
  user: { id: "sa-1" } as { id: string } | null,
  loading: false,
  signOut: vi.fn(async () => {}),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));

import SuperAdminBugReports from "@/pages/SuperAdminBugReports";

function report(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "bug-1",
    reporter_id: "u-1",
    reporter_email: "teacher@school.test",
    reporter_role: "instructor",
    institution_id: "inst-1",
    title: "Quiz will not submit",
    description: "It spins forever.",
    page_url: "https://app.test/quiz/1",
    user_agent: "Mozilla/5.0",
    viewport: "1440x900",
    os: "macOS",
    screenshot_paths: [] as string[],
    status: "new",
    created_at: "2026-05-01T10:00:00.000Z",
    updated_at: "2026-05-01T10:00:00.000Z",
    ...overrides,
  };
}

beforeAll(() => {
  // Radix Select needs the same pointer shims used elsewhere in the suite.
  if (!Element.prototype.hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture =
      () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    (
      Element.prototype as unknown as { releasePointerCapture: () => void }
    ).releasePointerCapture = () => {};
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: "sa-1" };
  auth.loading = false;
  db.isSuperAdmin = true;
  db.rpcError = null;
  db.reports = [];
  db.selectError = null;
  db.updateError = null;
  db.deleteError = null;
  db.storageRemoveError = null;
  db.signedUrlError = null;
  db.updates = [];
  db.deletes = [];
  db.calls = [];
  db.storageRemoved = [];
  db.signedFor = [];
  db.selects = [];
});

/** Renders and waits for the inbox (or the denial) to settle. */
async function renderPage() {
  render(<SuperAdminBugReports />);
  await waitFor(() =>
    expect(document.querySelector(".animate-spin")).not.toBeInTheDocument(),
  );
}

async function openReport(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole("cell", { name: title }));
  return await screen.findByRole("dialog");
}

/**
 * The table row for a report. `hidden: true` because an open dialog marks the
 * rest of the page aria-hidden, and several assertions here are precisely about
 * what the list looks like *behind* the dialog.
 */
function rowFor(title: string) {
  const row = screen.getByRole("cell", { name: title, hidden: true }).closest("tr");
  if (!row) throw new Error(`no row for "${title}"`);
  return row;
}

/** The count shown on a status tile — the tile's two <p>s are count, then label. */
function statusTileCount(label: string) {
  const labelEl = screen
    .getAllByText(label)
    .find((n) => n.tagName === "P" && n.previousElementSibling?.tagName === "P");
  if (!labelEl) throw new Error(`no status tile labelled "${label}"`);
  return labelEl.previousElementSibling!;
}

describe("SuperAdminBugReports — who gets in", () => {
  it("sends a signed-out visitor to the auth page", async () => {
    auth.user = null;

    render(<SuperAdminBugReports />);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/auth"));
  });

  it("waits for auth to resolve before redirecting", async () => {
    auth.user = null;
    auth.loading = true;

    render(<SuperAdminBugReports />);

    await waitFor(() => expect(document.querySelector(".animate-spin")).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("denies a non-super-admin and never reads a single report", async () => {
    db.isSuperAdmin = false;
    db.reports = [report()];

    await renderPage();

    expect(screen.getByText("Access Denied")).toBeInTheDocument();
    expect(db.calls).not.toContain("select:bug_reports");
    expect(screen.queryByText("Quiz will not submit")).not.toBeInTheDocument();
  });

  it("fails closed when the super-admin check itself errors", async () => {
    db.rpcError = { message: "rpc down" };
    db.reports = [report()];

    await renderPage();

    expect(screen.getByText("Access Denied")).toBeInTheDocument();
    expect(db.calls).not.toContain("select:bug_reports");
  });
});

describe("SuperAdminBugReports — the inbox", () => {
  it("lists reports newest first and counts them by status", async () => {
    db.reports = [
      report({ id: "b1", title: "Newest", status: "new" }),
      report({ id: "b2", title: "Older", status: "resolved" }),
      report({ id: "b3", title: "Oldest", status: "resolved" }),
    ];

    await renderPage();

    expect(screen.getByText("All Reports (3)")).toBeInTheDocument();
    expect(db.selects[0].order).toEqual([
      { col: "created_at", opts: { ascending: false } },
    ]);
    expect(statusTileCount("Resolved")).toHaveTextContent("2");
    expect(statusTileCount("New")).toHaveTextContent("1");
    expect(statusTileCount("In progress")).toHaveTextContent("0");
  });

  it("shows an empty inbox as empty, not as a failure", async () => {
    await renderPage();

    expect(screen.getByText("No bug reports yet")).toBeInTheDocument();
    expect(screen.getByText("All Reports (0)")).toBeInTheDocument();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("reports a failed read", async () => {
    db.selectError = { message: "permission denied" };

    await renderPage();

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("permission denied"));
  });

  it("shows the attachment count only for reports that have one", async () => {
    db.reports = [
      report({ id: "b1", title: "With shots", screenshot_paths: ["a.png", "b.png"] }),
      report({ id: "b2", title: "Without" }),
    ];

    await renderPage();

    const withShots = screen.getByRole("cell", { name: "With shots" }).closest("tr")!;
    expect(within(withShots).getByText("2")).toBeInTheDocument();
    const without = screen.getByRole("cell", { name: "Without" }).closest("tr")!;
    expect(within(without).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("opens the environment detail a triage needs", async () => {
    db.reports = [report()];
    await renderPage();
    const user = userEvent.setup();

    const dialog = await openReport(user, "Quiz will not submit");

    expect(within(dialog).getByText("It spins forever.")).toBeInTheDocument();
    expect(within(dialog).getByText("https://app.test/quiz/1")).toBeInTheDocument();
    expect(within(dialog).getByText("Mozilla/5.0")).toBeInTheDocument();
    expect(within(dialog).getByText("1440x900")).toBeInTheDocument();
    expect(within(dialog).getByText("macOS")).toBeInTheDocument();
  });

  it("signs screenshot URLs for an hour, and only for the open report", async () => {
    db.reports = [
      report({ id: "b1", title: "With shots", screenshot_paths: ["shot-1.png"] }),
      report({ id: "b2", title: "Without" }),
    ];
    await renderPage();
    const user = userEvent.setup();

    // The plain report signs nothing.
    await openReport(user, "Without");
    expect(db.signedFor).toHaveLength(0);
    await user.keyboard("{Escape}");

    const dialog = await openReport(user, "With shots");
    await waitFor(() => expect(db.signedFor).toHaveLength(1));
    expect(db.signedFor[0]).toEqual({ paths: ["shot-1.png"], expiresIn: 3600 });
    expect(within(dialog).getByRole("img", { name: "shot-1.png" })).toHaveAttribute(
      "src",
      "https://signed.test/shot-1.png",
    );
  });
});

describe("SuperAdminBugReports — changing status", () => {
  it("writes the new status against that report and updates both views of it", async () => {
    db.reports = [report({ status: "new" })];
    await renderPage();
    const user = userEvent.setup();

    const dialog = await openReport(user, "Quiz will not submit");
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "In progress" }));

    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0]).toEqual({
      values: { status: "in_progress" },
      filters: [{ op: "eq", col: "id", val: "bug-1" }],
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Status updated");
    // The dialog's own select reflects it...
    expect(within(dialog).getByRole("combobox")).toHaveTextContent("In progress");
    // ...and so does the row behind it.
    const row = rowFor("Quiz will not submit");
    expect(within(row).getByText("In progress")).toBeInTheDocument();
  });

  it("leaves the displayed status alone when the write fails", async () => {
    db.reports = [report({ status: "new" })];
    db.updateError = { message: "update denied" };
    await renderPage();
    const user = userEvent.setup();

    const dialog = await openReport(user, "Quiz will not submit");
    await user.click(within(dialog).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Resolved" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("update denied"));
    const row = rowFor("Quiz will not submit");
    expect(within(row).getByText("New")).toBeInTheDocument();
  });
});

describe("SuperAdminBugReports — deleting", () => {
  async function openDeleteConfirm(user: ReturnType<typeof userEvent.setup>) {
    const dialog = await openReport(user, "Quiz will not submit");
    await user.click(within(dialog).getByRole("button", { name: /Delete/ }));
    return await screen.findByRole("alertdialog");
  }

  it("clears the screenshots out of storage before dropping the row that names them", async () => {
    db.reports = [report({ screenshot_paths: ["shot-1.png", "shot-2.png"] })];
    await renderPage();
    const user = userEvent.setup();

    const confirm = await openDeleteConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(db.deletes).toHaveLength(1));
    expect(db.storageRemoved).toEqual([["shot-1.png", "shot-2.png"]]);
    expect(db.calls.indexOf("storage:remove")).toBeLessThan(
      db.calls.indexOf("delete:bug_reports"),
    );
    expect(db.deletes[0].filters).toEqual([{ op: "eq", col: "id", val: "bug-1" }]);
  });

  it("touches storage at all only when there is something to remove", async () => {
    db.reports = [report({ screenshot_paths: [] })];
    await renderPage();
    const user = userEvent.setup();

    const confirm = await openDeleteConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(db.deletes).toHaveLength(1));
    expect(db.storageRemoved).toHaveLength(0);
  });

  it("still deletes the report when its screenshots cannot be removed", async () => {
    db.reports = [report({ screenshot_paths: ["stuck.png"] })];
    db.storageRemoveError = { message: "storage offline" };
    await renderPage();
    const user = userEvent.setup();

    const confirm = await openDeleteConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith("Bug report deleted"));
    expect(db.deletes).toHaveLength(1);
  });

  it("drops the row and closes the detail it was showing", async () => {
    db.reports = [report({ id: "b1", title: "Doomed" }), report({ id: "b2", title: "Survivor" })];
    await renderPage();
    const user = userEvent.setup();

    const dialog = await openReport(user, "Doomed");
    await user.click(within(dialog).getByRole("button", { name: /Delete/ }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.queryByRole("cell", { name: "Doomed" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("cell", { name: "Survivor" })).toBeInTheDocument();
    expect(screen.getByText("All Reports (1)")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the report listed when the delete fails", async () => {
    db.reports = [report()];
    db.deleteError = { message: "delete denied" };
    await renderPage();
    const user = userEvent.setup();

    const confirm = await openDeleteConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("delete denied"));
    expect(rowFor("Quiz will not submit")).toBeInTheDocument();
    expect(screen.getByText("All Reports (1)")).toBeInTheDocument();
  });

  it("asks before deleting, and does nothing if the admin backs out", async () => {
    db.reports = [report()];
    await renderPage();
    const user = userEvent.setup();

    const confirm = await openDeleteConfirm(user);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

    expect(db.deletes).toHaveLength(0);
    expect(rowFor("Quiz will not submit")).toBeInTheDocument();
  });
});

describe("SuperAdminBugReports — signing out", () => {
  it("signs out and leaves the admin area", async () => {
    await renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /Sign Out/ }));

    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(navigate).toHaveBeenCalledWith("/");
  });
});
