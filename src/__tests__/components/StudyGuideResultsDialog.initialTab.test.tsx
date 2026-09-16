/**
 * #1228 — `initialTab`, and the re-seed that makes it mean anything.
 *
 * The AI class assessment got a row action of its own, which works by opening
 * this dialog straight onto its fourth tab. Making the tabs controlled to allow
 * that introduced a stale-state hazard that `defaultValue` did not have: the
 * dialog's state lives above the Radix `Dialog`, so it survives a close. Seed
 * the tab once, at mount, and the second press of the assessment button reopens
 * on whatever tab the instructor happened to leave selected — the button
 * silently stops doing what it says. Hence the effect on `[open, initialTab]`,
 * and hence the reopen cases below, which are the ones a mount-only
 * implementation passes everything else and still fails.
 *
 * The analytics themselves are out of scope: the reads are stubbed to an empty
 * class so the dialog reaches its tabs, and the assessment panel is mocked to a
 * marker. What is asserted is which panel is showing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const channel = vi.hoisted(() => ({
  on: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

  /**
   * One published target and an empty roster. With no pieces and no enrolled
   * students the loader short-circuits after three reads, which is all this
   * file needs — it has to get PAST loading, not produce numbers.
   */
  const rowsFor = (table: string) => {
    if (table === "offering_study_guides") {
      return [
        {
          offering_id: "off-1",
          group_id: null,
          published_at: "2026-01-20T00:00:00Z",
          offerings: { id: "off-1", classes: { id: "cls-1", name: "Math 101" } },
        },
      ];
    }
    return [];
  };

  const buildChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "is", "not", "order", "limit"]) {
      chain[method] = () => chain;
    }
    // `offerings` is read with `.single()` for the class id behind the roster.
    chain.single = async () => ({ data: { class_id: "cls-1" }, error: null });
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve({ data: rowsFor(table), error: null }));
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(),
      functions: { invoke: vi.fn(async () => ({ data: null, error: null })) },
    },
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

/**
 * The mock mirrors the two contract points the dialog owes the real panel:
 * it renders the `view` it was handed (a dropped `view={analysisView}` would
 * freeze `data-view`), and it holds local state (a dialog that remounted the
 * panel on a sub-tab flip — losing unsaved group edits and the in-flight save
 * guard — would reset the counter).
 */
vi.mock("@/components/study-guide/StudyGuideAnalysisPanel", async () => {
  const { useState } = await import("react");
  return {
    StudyGuideAnalysisPanel: ({ view = "assessment" }: { view?: string }) => {
      const [edits, setEdits] = useState(0);
      return (
        <div data-testid="analysis-panel" data-view={view}>
          <button onClick={() => setEdits((e) => e + 1)}>fake-edit</button>
          <span data-testid="panel-edits">{edits}</span>
        </div>
      );
    },
  };
});
vi.mock("@/components/study-guide/StudyGuideAnswerDrillDown", () => ({
  StudyGuideAnswerDrillDown: () => null,
}));

import { StudyGuideResultsDialog } from "@/components/study-guide/StudyGuideResultsDialog";

type Tab = "students" | "pieces" | "competencies" | "assessment";

function renderDialog(props: { open?: boolean; initialTab?: Tab } = {}) {
  const onOpenChange = vi.fn();
  const view = render(
    <StudyGuideResultsDialog
      open={props.open ?? true}
      onOpenChange={onOpenChange}
      studyGuideId="sg-1"
        courseId="course-1"
      studyGuideTitle="Chapter 1 guide"
      initialTab={props.initialTab}
    />,
  );
  const rerender = (next: { open?: boolean; initialTab?: Tab }) =>
    view.rerender(
      <StudyGuideResultsDialog
        open={next.open ?? true}
        onOpenChange={onOpenChange}
        studyGuideId="sg-1"
        courseId="course-1"
        studyGuideTitle="Chapter 1 guide"
        initialTab={next.initialTab}
      />,
    );
  return { rerender, onOpenChange };
}

/** Waits for the tabs to exist, then names the one that is showing. */
async function activeTab(): Promise<string | null> {
  const tabs = await screen.findAllByRole("tab");
  return tabs.find((t) => t.getAttribute("data-state") === "active")?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
});

describe("StudyGuideResultsDialog — which panel it opens on", () => {
  it("shows the students panel when no tab is asked for", async () => {
    renderDialog();

    expect(await activeTab()).toBe("Students");
  });

  it("opens straight on the assessment panel when the manager asks for it", async () => {
    renderDialog({ initialTab: "assessment" });

    expect(await activeTab()).toBe("AI Analysis & Follow up");
    // Not just the trigger — the panel behind it is the one that mounted.
    expect(screen.getByTestId("analysis-panel")).toBeInTheDocument();
    // Groups is a SUB-tab of Assessment (#1335 follow-up), not a sibling: the
    // top row must not offer it, and the nested Report/Follow up pair appears
    // only once Assessment is showing. (Text-content matching would trip on
    // the top tab's own "AI Analysis & Follow up" label, so match the exact
    // accessible name instead.)
    const topTabs = screen.getAllByRole("tablist")[0];
    expect(within(topTabs).queryByRole("tab", { name: "Follow up" })).toBeNull();
    // Report and Groups share one panel that is not a Radix TabsContent, so
    // the aria wiring is explicit: both sub-triggers point at the panel's id,
    // and the panel is a labelled tabpanel. This pins that the overrides
    // survive Radix's own attribute-setting.
    expect(screen.getByRole("tab", { name: "Report" })).toHaveAttribute(
      "aria-controls",
      "sg-results-analysis-tabpanel",
    );
    expect(screen.getByRole("tab", { name: "Follow up" })).toHaveAttribute(
      "aria-controls",
      "sg-results-analysis-tabpanel",
    );
    const panel = document.getElementById("sg-results-analysis-tabpanel")!;
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "sg-results-tab-assessment");
    expect(panel).toContainElement(screen.getByTestId("analysis-panel"));
  });

  it("flips the shared panel's view — without remounting it — on the Follow up sub-tab", async () => {
    const user = userEvent.setup();
    renderDialog({ initialTab: "assessment" });
    const mockPanel = await screen.findByTestId("analysis-panel");
    expect(mockPanel).toHaveAttribute("data-view", "assessment");
    // Give the mounted instance detectable local state — the stand-in for an
    // unsaved group edit that must survive the flip.
    await user.click(screen.getByRole("button", { name: "fake-edit" }));
    expect(screen.getByTestId("panel-edits")).toHaveTextContent("1");

    await user.click(screen.getByRole("tab", { name: "Follow up" }));

    const panel = document.getElementById("sg-results-analysis-tabpanel")!;
    expect(panel).toHaveAttribute("aria-labelledby", "sg-results-tab-groups");
    // The panel received the new view AND kept its state: the flip re-props
    // the one instance rather than mounting a second one, which is what
    // preserves unsaved group edits and the in-flight save guard.
    expect(screen.getByTestId("analysis-panel")).toHaveAttribute("data-view", "groups");
    expect(screen.getByTestId("panel-edits")).toHaveTextContent("1");
  });

  it("leaves the tabs switchable once open", async () => {
    const user = userEvent.setup();
    renderDialog({ initialTab: "assessment" });
    await screen.findByTestId("analysis-panel");

    await user.click(screen.getByRole("tab", { name: "Pieces" }));

    expect(await activeTab()).toBe("Pieces");
    expect(screen.queryByTestId("analysis-panel")).not.toBeInTheDocument();
  });

  it("does not yank a hand-picked tab back on an unrelated re-render", async () => {
    // The re-seed is keyed to opening. A dialog that re-seeded on every render
    // would fight the instructor every time the realtime refetch lands.
    const user = userEvent.setup();
    const { rerender } = renderDialog({ initialTab: "assessment" });
    await screen.findByTestId("analysis-panel");
    await user.click(screen.getByRole("tab", { name: "Competencies" }));

    rerender({ open: true, initialTab: "assessment" });

    expect(await activeTab()).toBe("Competencies");
  });
});

describe("StudyGuideResultsDialog — reopening re-seeds the tab", () => {
  it("follows the button pressed this time, not the tab left showing last time", async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog({ initialTab: "students" });
    await screen.findAllByRole("tab");
    await user.click(screen.getByRole("tab", { name: "AI Analysis & Follow up" }));
    expect(await activeTab()).toBe("AI Analysis & Follow up");

    rerender({ open: false, initialTab: "students" });
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
    rerender({ open: true, initialTab: "students" });

    expect(await activeTab()).toBe("Students");
  });

  it("re-seeds even when the SAME panel is asked for twice", async () => {
    // The case a mount-only `useState(initialTab)` gets wrong: `initialTab`
    // never changes, so only the reopen itself can put the tab back.
    const user = userEvent.setup();
    const { rerender } = renderDialog({ initialTab: "assessment" });
    await screen.findByTestId("analysis-panel");
    await user.click(screen.getByRole("tab", { name: "Students" }));
    expect(await activeTab()).toBe("Students");

    rerender({ open: false, initialTab: "assessment" });
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
    rerender({ open: true, initialTab: "assessment" });

    expect(await activeTab()).toBe("AI Analysis & Follow up");
  });

  it("re-seeds the Follow up sub-tab back to the report on reopen", async () => {
    // The sub-view is state above the Radix Dialog too, so it would otherwise
    // survive a close exactly like the tab itself (#1228's hazard).
    const user = userEvent.setup();
    const { rerender } = renderDialog({ initialTab: "assessment" });
    await screen.findByTestId("analysis-panel");
    await user.click(screen.getByRole("tab", { name: "Follow up" }));
    expect(document.getElementById("sg-results-analysis-tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "sg-results-tab-groups",
    );

    rerender({ open: false, initialTab: "assessment" });
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
    rerender({ open: true, initialTab: "assessment" });

    expect(await screen.findByTestId("analysis-panel")).toHaveAttribute(
      "data-view",
      "assessment",
    );
    expect(document.getElementById("sg-results-analysis-tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "sg-results-tab-assessment",
    );
  });

  it("switches panels when the other row action opens the already-mounted dialog", async () => {
    const { rerender } = renderDialog({ initialTab: "students" });
    expect(await activeTab()).toBe("Students");

    rerender({ open: false, initialTab: "students" });
    await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
    rerender({ open: true, initialTab: "assessment" });

    expect(await activeTab()).toBe("AI Analysis & Follow up");
  });
});
