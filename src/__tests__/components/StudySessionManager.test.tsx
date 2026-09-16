import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/*
 * NOTE on scope: the issue body's acceptance criteria for StudySessionManager
 * (tutor chat init, mark complete, pause/resume per socratic-state) describes
 * the student-facing `StudentStudySession.tsx` component, which already has
 * its own test file. The 1521-line file the issue actually names —
 * `StudySessionManager.tsx` — is the *instructor*-facing session manager
 * (content authoring, draft/ready toggle, edit + assign dialogs). These tests
 * cover that instructor-side behavior, which is what the file under test
 * actually does.
 */

type Result = { data: unknown; error: unknown; count?: number | null };

const responses: Record<string, Result> = {
  study_sessions: { data: [], error: null },
  course_materials: { data: [], error: null },
  course_materials__images: { data: [], error: null },
  course_materials__other: { data: [], error: null, count: 0 },
  course_materials__whole_docs: { data: [], error: null },
  material_chapters: { data: [], error: null },
  courses: { data: { language: "English" }, error: null },
  profiles: { data: [], error: null },
};

/** Assignment targets per content id, as `useContentAssignments` would report them. */
let assignedTargets: Record<string, Array<{ offering_id: string; group_id: string | null }>> = {};
/** Load state of the assignment fetch, which gates the "Not assigned" warning. */
let assignmentsLoading = false;
let assignmentsError: string | null = null;

/**
 * What `suggest-tutoring-sessions` answers. Mutable so a test can make the AI
 * return nothing without rebuilding the client mock.
 */
let suggestResponse: unknown = {
  success: true,
  message: "Proposed.",
  sessions: [
    { title: "Suggested One", topic: "Objective one", instructions: "Teach one" },
    { title: "Suggested Two", topic: "Objective two", instructions: "Teach two" },
  ],
};

const eqCalls: Array<{ table: string; column: unknown; value: unknown }> = [];
const insertCalls: Array<{ table: string; values: unknown }> = [];
const updateCalls: Array<{ table: string; values: unknown; id?: unknown }> = [];
const deleteCalls: Array<{ table: string; id?: unknown }> = [];
const invokedFunctions: Array<{ name: string; body: unknown }> = [];
const signedUrlCalls: string[] = [];

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = (table: string) => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    // Each chain captures its own course_materials phase so parallel queries
    // (Promise.all in fetchData) don't race on shared state.
    let phase: "textbook" | "images" | "other" | "whole_docs" | "default" = "default";

    chain.select = (_cols?: unknown, opts?: { head?: boolean; count?: string }) => {
      if (table === "course_materials" && opts?.head) {
        phase = "other";
      }
      return chain;
    };
    chain.eq = (col: unknown, value: unknown) => {
      eqCalls.push({ table, column: col, value });
      if (table === "course_materials" && col === "material_type") {
        if (value === "textbook") phase = "textbook";
        else if (value === "images") phase = "images";
        // The whole-document picker (#1019) filters on the type directly; the
        // supplementary count reaches "other" through `select(head)` instead.
        else if (value === "other") phase = "whole_docs";
      }
      const pendingUpdate = (chain as any).__pendingUpdate;
      if (pendingUpdate) {
        updateCalls.push({ table, values: pendingUpdate, id: value });
        (chain as any).__pendingUpdate = undefined;
      }
      const pendingDelete = (chain as any).__pendingDelete;
      if (pendingDelete) {
        deleteCalls.push({ table, id: value });
        (chain as any).__pendingDelete = undefined;
      }
      return chain;
    };
    chain.neq = passThrough;
    chain.not = passThrough;
    chain.in = passThrough;
    chain.is = passThrough;
    chain.order = passThrough;
    chain.update = (values: unknown) => {
      (chain as any).__pendingUpdate = values;
      return chain;
    };
    chain.delete = () => {
      (chain as any).__pendingDelete = true;
      return chain;
    };
    chain.insert = (values: unknown) => {
      insertCalls.push({ table, values });
      return chain;
    };

    const resolveResponse = () => {
      if (table === "course_materials") {
        if (phase === "textbook") return responses.course_materials;
        if (phase === "images") return responses.course_materials__images;
        if (phase === "other") return responses.course_materials__other;
        if (phase === "whole_docs") return responses.course_materials__whole_docs;
      }
      return responses[table] || { data: [], error: null };
    };

    chain.single = () => Promise.resolve(resolveResponse());
    chain.maybeSingle = chain.single;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve(resolveResponse()));
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => buildChain(table)),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      },
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: vi.fn(async (path: string) => {
            signedUrlCalls.push(path);
            return { data: { signedUrl: `https://signed/${path}` }, error: null };
          }),
        })),
      },
      functions: {
        invoke: vi.fn(async (name: string, args: { body: unknown }) => {
          invokedFunctions.push({ name, body: args?.body });
          if (name === "suggest-tutoring-sessions") {
            return { data: suggestResponse, error: null };
          }
          return {
            data: {
              llmResponse: {
                status: "success",
                message: "Summary generated",
                summary: "Some summary text",
              },
            },
            error: null,
          };
        }),
      },
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/useContentAssignments", () => ({
  useContentAssignments: () => ({
    assignments: {},
    groupsByOffering: {},
    loading: assignmentsLoading,
    error: assignmentsError,
    saving: false,
    getAssignedTargets: vi.fn((id: string) => assignedTargets[id] ?? []),
    saveAssignments: vi.fn(async () => ({ ok: true })),
  }),
}));

vi.mock("@/components/RichTextEditor", () => ({
  RichTextEditor: ({
    content,
    onChange,
    placeholder,
  }: {
    content: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      data-testid="rich-text-editor"
      value={content || ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@/components/ContentAssignDialog", () => ({
  ContentAssignDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="assign-dialog" /> : null,
}));

vi.mock("@/components/AssignedClassesBadges", () => ({
  AssignedClassesBadges: () => <div data-testid="assigned-badges" />,
}));

import { StudySessionManager } from "@/components/StudySessionManager";
import { toast } from "sonner";

beforeEach(() => {
  responses.study_sessions = { data: [], error: null };
  responses.course_materials = { data: [], error: null };
  responses.course_materials__images = { data: [], error: null };
  responses.course_materials__other = { data: [], error: null, count: 0 };
  responses.course_materials__whole_docs = { data: [], error: null };
  responses.material_chapters = { data: [], error: null };
  responses.courses = { data: { language: "English" }, error: null };
  responses.profiles = { data: [], error: null };
  assignedTargets = {};
  assignmentsLoading = false;
  assignmentsError = null;
  eqCalls.length = 0;
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  invokedFunctions.length = 0;
  signedUrlCalls.length = 0;
  suggestResponse = {
    success: true,
    message: "Proposed.",
    sessions: [
      { title: "Suggested One", topic: "Objective one", instructions: "Teach one" },
      { title: "Suggested Two", topic: "Objective two", instructions: "Teach two" },
    ],
  };

  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();

  // Suppress confirm() prompts during delete-flow tests.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

const COURSE_CLASSES = [
  {
    id: "cls-1",
    name: "A1",
    grade_level_id: null,
    section_name: null,
    category: null,
    academic_period: null,
    offering_id: "off-1",
  },
];

describe("StudySessionManager", () => {
  /*
   * `is_moderated` only records that moderation RAN — it is set for a rejected
   * image just as much as an approved one, because the outcome used to live in
   * the `openai_file_id` sentinel instead. Selecting images by `is_moderated`
   * therefore offered rejected images to students. The outcome now has its own
   * column, and this pins the filter to it.
   */
  it("offers only approved images, filtering on moderation_status rather than is_moderated", async () => {
    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText(/No Tutoring Sessions/i)).toBeInTheDocument();
    });

    const imageFilters = eqCalls.filter(
      (c) => c.table === "course_materials" && c.column === "moderation_status",
    );
    expect(imageFilters).toEqual([
      { table: "course_materials", column: "moderation_status", value: "approved" },
    ]);
    expect(eqCalls.some((c) => c.column === "is_moderated")).toBe(false);
  });

  it("renders an empty state and disables Create Session when there is no source material", async () => {
    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText(/No Tutoring Sessions/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Source material is required to create tutoring sessions/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create Session/i })).toBeDisabled();
  });

  // ── Whole-document "Other" materials (#1019) ────────────────────────────
  //
  // An "Other" material is never split, so a session grounded in one takes the
  // whole document: no chapters to pick, and no chapter columns to fill in.

  const withWholeDocument = () => {
    responses.course_materials__whole_docs = {
      data: [{
        id: "mat-other",
        title: "Course syllabus",
        file_name: "syllabus.pdf",
        page_count: 12,
        file_size: 2048,
      }],
      error: null,
    };
  };

  it("enables Create Session when the only source is an 'Other' document", async () => {
    // The old gate demanded a split textbook, which locked a course whose only
    // AI-usable material is a standalone document out of tutoring entirely.
    withWholeDocument();
    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Create Session/i })).toBeEnabled();
    });
    expect(
      screen.queryByText(/Source material is required to create tutoring sessions/i),
    ).not.toBeInTheDocument();

    // "Suggest New Sessions with AI" is still chapter-based, so it stays shut.
    expect(screen.getByRole("button", { name: /Suggest New Sessions with AI/i })).toBeDisabled();
  });

  it("creates a session grounded in a whole document, with no chapter columns", async () => {
    withWholeDocument();
    const user = userEvent.setup();
    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Create Session/i })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: /Create Session/i }));

    await user.type(await screen.findByLabelText(/Session Title/i), "Syllabus walkthrough");
    await user.type(screen.getByLabelText(/Topic \/ Learning Objective/i), "Course expectations");
    await user.click(await screen.findByRole("checkbox", { name: /Course syllabus/i }));

    await user.click(screen.getByRole("button", { name: /^Create Session$/i, hidden: false }));

    await waitFor(() => expect(insertCalls.length).toBe(1));

    // The summary is grounded in the document, not in chapters it does not have.
    const summaryCall = invokedFunctions.find((f) => f.name === "generate-chapter-summary");
    expect(summaryCall?.body).toMatchObject({
      chapterIds: [],
      materialIds: ["mat-other"],
    });

    const row = insertCalls[0].values as Record<string, unknown>;
    expect(insertCalls[0].table).toBe("study_sessions");
    expect(row.material_id).toBe("mat-other");
    // Null, not an empty array or a fabricated chapter id: there is no chapter.
    expect(row.chapter_id).toBe(null);
    expect(row.chapter_ids).toBe(null);
  });

  it("renders existing sessions with status badges and chapter range", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Algebra Book",
          file_name: "algebra.pdf",
          file_size: 100000,
          page_count: 200,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "Polynomials",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-20",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "Intro to Polynomials",
          topic: "Polynomial basics",
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "sess-2",
          title: "Draft Session",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "draft",
          created_at: "2026-05-02T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("Intro to Polynomials")).toBeInTheDocument();
    });
    expect(screen.getByText("Draft Session")).toBeInTheDocument();
    // "Ready" names both the section heading and the per-card status badge.
    expect(screen.getAllByText("Ready")).toHaveLength(2);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    // Chapter range display — one per session card
    expect(screen.getAllByText("Ch 1")).toHaveLength(2);
  });

  /*
   * The list used to be one flat grid in whatever order the rows arrived, so a
   * draft sat between two available sessions and an instructor could not tell
   * at a glance what students could actually open. Sessions are now split by
   * status, and each half is ordered newest-first on its own.
   */
  it("splits sessions into Ready and Drafts sections, each newest-first", async () => {
    const session = (
      id: string,
      title: string,
      status: string,
      created_at: string,
    ) => ({
      id,
      title,
      topic: null,
      material_id: null,
      chapter_id: null,
      chapter_ids: null,
      page_start: null,
      page_end: null,
      extracted_content: null,
      llm_status: null,
      llm_message: null,
      instructions: null,
      student_notes: null,
      reference_images: null,
      created_by: null,
      status,
      created_at,
    });

    // Deliberately interleaved and out of date order.
    responses.study_sessions = {
      data: [
        session("s1", "Older Draft", "draft", "2026-01-01T00:00:00Z"),
        session("s2", "Newer Ready", "ready", "2026-03-01T00:00:00Z"),
        session("s3", "Newer Draft", "draft", "2026-04-01T00:00:00Z"),
        session("s4", "Older Ready", "ready", "2026-02-01T00:00:00Z"),
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("Newer Ready")).toBeInTheDocument();
    });

    const readySection = screen.getByTestId("session-group-ready");
    const draftSection = screen.getByTestId("session-group-draft");

    expect(within(readySection).getByText("Newer Ready")).toBeInTheDocument();
    expect(within(readySection).getByText("Older Ready")).toBeInTheDocument();
    expect(within(readySection).queryByText("Newer Draft")).toBeNull();

    expect(within(draftSection).getByText("Newer Draft")).toBeInTheDocument();
    expect(within(draftSection).getByText("Older Draft")).toBeInTheDocument();
    expect(within(draftSection).queryByText("Older Ready")).toBeNull();

    const titlesIn = (section: HTMLElement) =>
      [...section.querySelectorAll("span.truncate")].map(el => el.textContent);
    expect(titlesIn(readySection)).toEqual(["Newer Ready", "Older Ready"]);
    expect(titlesIn(draftSection)).toEqual(["Newer Draft", "Older Draft"]);
  });

  /*
   * Whether a session had reached any student was only legible from a small
   * class badge tucked into the metadata row — easy to miss, and absent
   * entirely when the course has no classes wired up. The state now has its
   * own badge next to the status.
   */
  it("badges an assigned session, and warns when a ready session has no audience", async () => {
    const base = {
      topic: null,
      material_id: null,
      chapter_id: null,
      chapter_ids: null,
      page_start: null,
      page_end: null,
      extracted_content: null,
      llm_status: null,
      llm_message: null,
      instructions: null,
      student_notes: null,
      reference_images: null,
      created_by: null,
    };
    responses.study_sessions = {
      data: [
        { ...base, id: "assigned", title: "Assigned Session", status: "ready", created_at: "2026-02-01T00:00:00Z" },
        { ...base, id: "orphan", title: "Orphan Session", status: "ready", created_at: "2026-01-01T00:00:00Z" },
      ],
      error: null,
    };
    assignedTargets = {
      assigned: [
        { offering_id: "off-1", group_id: null },
        { offering_id: "off-2", group_id: null },
      ],
    };

    render(<StudySessionManager courseId="course-1" classes={COURSE_CLASSES} />);

    await waitFor(() => {
      expect(screen.getByText("Assigned Session")).toBeInTheDocument();
    });

    // Two targets, so the badge carries the count.
    expect(screen.getByText("Assigned · 2")).toBeInTheDocument();
    expect(screen.getByText("Not assigned")).toBeInTheDocument();
  });

  /*
   * An empty target list is not evidence of anything until the fetch answers.
   * Warning while it is still in flight, after it failed, or on a course with
   * no classes at all would push instructors to re-assign content that is
   * already assigned — the failure greptile flagged on #1268.
   */
  it("withholds the Not-assigned warning until the assignment state is known", async () => {
    const readySession = {
      id: "sess-1",
      title: "Ready Session",
      topic: null,
      material_id: null,
      chapter_id: null,
      chapter_ids: null,
      page_start: null,
      page_end: null,
      extracted_content: null,
      llm_status: null,
      llm_message: null,
      instructions: null,
      student_notes: null,
      reference_images: null,
      created_by: null,
      status: "ready",
      created_at: "2026-02-01T00:00:00Z",
    };
    responses.study_sessions = { data: [readySession], error: null };

    // Still loading.
    assignmentsLoading = true;
    const loadingView = render(
      <StudySessionManager courseId="course-1" classes={COURSE_CLASSES} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Ready Session")).toBeInTheDocument();
    });
    expect(screen.queryByText("Not assigned")).toBeNull();
    loadingView.unmount();

    // The fetch failed: say so, rather than claiming nobody is assigned.
    assignmentsLoading = false;
    assignmentsError = "permission denied";
    const errorView = render(
      <StudySessionManager courseId="course-1" classes={COURSE_CLASSES} />,
    );
    await waitFor(() => {
      expect(screen.getByText("Ready Session")).toBeInTheDocument();
    });
    expect(screen.queryByText("Not assigned")).toBeNull();
    expect(
      screen.getByText(/Could not load which classes these sessions are assigned to/),
    ).toBeInTheDocument();
    errorView.unmount();

    // No classes on the course, so nothing could have been assigned.
    assignmentsError = null;
    render(<StudySessionManager courseId="course-1" classes={[]} />);
    await waitFor(() => {
      expect(screen.getByText("Ready Session")).toBeInTheDocument();
    });
    expect(screen.queryByText("Not assigned")).toBeNull();
  });

  it("shows the author name resolved from created_by", async () => {
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "Authored Session",
          topic: null,
          material_id: null,
          chapter_id: null,
          chapter_ids: null,
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          created_by: "teacher-1",
          status: "ready",
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
      error: null,
    };
    responses.profiles = {
      data: [{ user_id: "teacher-1", full_name: "Maria Papadopoulou", email: "maria@example.com" }],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("Maria Papadopoulou")).toBeInTheDocument();
    });
  });

  // `profiles` is SELECT-able only for yourself, your institution's admins, and
  // instructors of your students — one instructor cannot resolve another's name,
  // and the row simply does not come back. Say so instead of hiding the author.
  it("falls back to Unknown when the author's profile is not readable", async () => {
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "Authored Session",
          topic: null,
          material_id: null,
          chapter_id: null,
          chapter_ids: null,
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          created_by: "hidden-teacher",
          status: "draft",
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
      error: null,
    };
    responses.profiles = { data: [], error: null };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("Authored Session")).toBeInTheDocument();
    });
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("toggles a ready session back to draft via the Set to Draft button", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "A Ready Session",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByText("A Ready Session")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Set to Draft/i }));

    await waitFor(() => {
      const update = updateCalls.find(
        (c) =>
          c.table === "study_sessions" &&
          (c.values as Record<string, unknown>).status === "draft",
      );
      expect(update).toBeTruthy();
      expect(update!.id).toBe("sess-1");
    });
  });

  it("toggles a draft session to ready via Make Available", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-draft",
          title: "Draft One",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "draft",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Draft One")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Make Available/i }));

    await waitFor(() => {
      const update = updateCalls.find(
        (c) =>
          c.table === "study_sessions" &&
          (c.values as Record<string, unknown>).status === "ready",
      );
      expect(update).toBeTruthy();
      expect(update!.id).toBe("sess-draft");
    });
  });

  it("opens the edit dialog pre-populated with the session's current values", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "Editable Session",
          topic: "Editable Topic",
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: "Be concise",
          student_notes: "<p>Notes</p>",
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Editable Session")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTitle(/Edit session/i));

    await waitFor(() => {
      const titleInput = screen.getByLabelText(/Session Title/i) as HTMLInputElement;
      expect(titleInput.value).toBe("Editable Session");
    });
    const topicInput = screen.getByLabelText(/Topic \/ Learning Objective/i) as HTMLInputElement;
    expect(topicInput.value).toBe("Editable Topic");
    const instructionsInput = screen.getByLabelText(
      /Special Instructions for AI Tutor/i,
    ) as HTMLTextAreaElement;
    expect(instructionsInput.value).toBe("Be concise");
  });

  it("persists edited title and topic via UPDATE on study_sessions", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "Old Title",
          topic: "Old Topic",
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Old Title")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTitle(/Edit session/i));

    const titleInput = await screen.findByLabelText(/Session Title/i);
    await user.clear(titleInput);
    await user.type(titleInput, "New Title");

    await user.click(screen.getByRole("button", { name: /Save Changes/i }));

    await waitFor(() => {
      const update = updateCalls.find(
        (c) =>
          c.table === "study_sessions" &&
          (c.values as Record<string, unknown>).title === "New Title",
      );
      expect(update).toBeTruthy();
      expect(update!.id).toBe("sess-1");
    });
  });

  it("deletes a session after confirming the prompt", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-del",
          title: "Deletable",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Deletable")).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByTitle(/Delete session/i));

    await waitFor(() => {
      const del = deleteCalls.find((c) => c.table === "study_sessions");
      expect(del).toBeTruthy();
      expect(del!.id).toBe("sess-del");
    });
  });

  it("disables the assign-to-classes button on draft sessions when classes are provided", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-d",
          title: "Cannot Assign Draft",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "draft",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(
      <StudySessionManager
        courseId="course-1"
        classes={[
          {
            id: "cls-1",
            name: "A1",
            grade_level_id: null,
            section_name: null,
            category: null,
            academic_period: null,
            offering_id: "off-1",
          },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByText("Cannot Assign Draft")).toBeInTheDocument());

    const assignBtn = screen.getByTitle(/Cannot assign draft sessions/i);
    expect(assignBtn).toBeDisabled();
  });

  it("does not render the assign button when no classes are provided", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-1",
          title: "Lone Session",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: null,
          llm_message: null,
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => expect(screen.getByText("Lone Session")).toBeInTheDocument());

    expect(screen.queryByTitle(/Assign to classes/i)).not.toBeInTheDocument();
  });

  it("shows the View Issue collapsible when summary generation failed", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-fail",
          title: "Failed Summary Session",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: null,
          llm_status: "fail",
          llm_message: "Could not summarize",
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() =>
      expect(screen.getByText("Failed Summary Session")).toBeInTheDocument(),
    );
    expect(screen.getByText(/View Issue/i)).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();

    await userEvent.setup().click(screen.getByText(/View Issue/i));
    await waitFor(() =>
      expect(screen.getByText("Could not summarize")).toBeInTheDocument(),
    );
  });

  it("does not show a summary on sessions whose summary generated successfully", async () => {
    responses.course_materials = {
      data: [
        {
          id: "mat-1",
          title: "Book",
          file_name: "book.pdf",
          file_size: 100000,
          page_count: 100,
        },
      ],
      error: null,
    };
    responses.material_chapters = {
      data: [
        {
          id: "ch-1",
          title: "C1",
          chapter_number: 1,
          content_type: "pdf",
          content: null,
          file_name: "Pages 1-10",
          material_id: "mat-1",
        },
      ],
      error: null,
    };
    responses.study_sessions = {
      data: [
        {
          id: "sess-ok",
          title: "Summarized Session",
          topic: null,
          material_id: "mat-1",
          chapter_id: "ch-1",
          chapter_ids: ["ch-1"],
          page_start: null,
          page_end: null,
          extracted_content: "A perfectly fine chapter summary.",
          llm_status: "success",
          llm_message: "Summary generated",
          instructions: null,
          student_notes: null,
          reference_images: null,
          status: "ready",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    };

    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() =>
      expect(screen.getByText("Summarized Session")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/View Summary/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText("A perfectly fine chapter summary."),
    ).not.toBeInTheDocument();
  });
  describe("AI-suggested sessions", () => {
    const withTextbook = () => {
      responses.course_materials = {
        data: [
          {
            id: "mat-1",
            title: "Book",
            file_name: "book.pdf",
            file_size: 100000,
            page_count: 100,
          },
        ],
        error: null,
      };
      responses.material_chapters = {
        data: [
          {
            id: "ch-1",
            title: "C1",
            chapter_number: 1,
            content_type: "pdf",
            content: null,
            file_name: "Pages 1-10",
            material_id: "mat-1",
          },
          {
            id: "ch-2",
            title: "C2",
            chapter_number: 2,
            content_type: "pdf",
            content: null,
            file_name: "Pages 11-20",
            material_id: "mat-1",
          },
        ],
        error: null,
      };
    };

    /** Open the dialog and pick chapter 2, so the wrong-chapter case would fail. */
    const openAndPickChapterTwo = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("button", { name: /Suggest New Sessions with AI/i }));
      await waitFor(() =>
        expect(screen.getByText(/Suggest Tutoring Sessions/i)).toBeInTheDocument(),
      );
      await user.click(screen.getByLabelText(/Ch 2:/i));
      await user.click(screen.getByRole("button", { name: /^Suggest Sessions$/i }));
    };

    it("disables Suggest New Sessions with AI when there is no textbook", async () => {
      render(<StudySessionManager courseId="course-1" />);

      await waitFor(() => {
        expect(screen.getByText(/No Tutoring Sessions/i)).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /Suggest New Sessions with AI/i })).toBeDisabled();
    });

    it("creates one draft session per suggestion, grounded in the chosen chapter", async () => {
      withTextbook();
      render(<StudySessionManager courseId="course-1" />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Suggest New Sessions with AI/i })).toBeEnabled(),
      );

      await openAndPickChapterTwo(userEvent.setup());

      await waitFor(() => expect(insertCalls.length).toBe(1));
      expect(invokedFunctions[0]).toEqual({
        name: "suggest-tutoring-sessions",
        body: { chapterId: "ch-2" },
      });
      // One summary for the chapter, shared by every draft — not one per draft.
      expect(
        invokedFunctions.filter((f) => f.name === "generate-chapter-summary").length,
      ).toBe(1);

      const rows = insertCalls[0].values as Array<Record<string, unknown>>;
      expect(insertCalls[0].table).toBe("study_sessions");
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.title)).toEqual(["Suggested One", "Suggested Two"]);
      // Drafts: nothing the model wrote reaches students before a human looks.
      expect(rows.every((r) => r.status === "draft")).toBe(true);
      expect(rows.every((r) => r.chapter_id === "ch-2")).toBe(true);
      expect(rows.every((r) => r.material_id === "mat-1")).toBe(true);
      expect(rows.every((r) => r.extracted_content === "Some summary text")).toBe(true);
      expect(rows[0].topic).toBe("Objective one");
      expect(rows[0].instructions).toBe("Teach one");
    });

    it("creates nothing when the AI returns no suggestions", async () => {
      withTextbook();
      suggestResponse = { success: false, message: "Chapter is too thin.", sessions: [] };

      render(<StudySessionManager courseId="course-1" />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /Suggest New Sessions with AI/i })).toBeEnabled(),
      );

      await openAndPickChapterTwo(userEvent.setup());

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Chapter is too thin."));
      expect(insertCalls).toHaveLength(0);
      // No suggestions means no sessions, so the summary call is never worth paying for.
      expect(
        invokedFunctions.some((f) => f.name === "generate-chapter-summary"),
      ).toBe(false);
    });
  });

  it("grounds a session in chapters or one document, never a mixture", async () => {
    // `study_sessions` stores provenance as one `material_id` plus a
    // `chapter_ids` array, so a mixed or multi-document selection is one the row
    // would go on to misreport. The picker refuses it rather than storing a
    // half-truth.
    withWholeDocument();
    responses.course_materials__whole_docs = {
      data: [
        { id: "mat-other", title: "Course syllabus", file_name: "syllabus.pdf", page_count: 12, file_size: 2048 },
        { id: "mat-other-2", title: "Reading list", file_name: "reading.pdf", page_count: 3, file_size: 512 },
      ],
      error: null,
    };
    const user = userEvent.setup();
    render(<StudySessionManager courseId="course-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Create Session/i })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: /Create Session/i }));

    const first = await screen.findByRole("checkbox", { name: /Course syllabus/i });
    const second = await screen.findByRole("checkbox", { name: /Reading list/i });

    await user.click(first);
    expect(first.getAttribute("data-state")).toBe("checked");

    // Picking a second document replaces the first rather than adding to it.
    await user.click(second);
    expect(second.getAttribute("data-state")).toBe("checked");
    expect(first.getAttribute("data-state")).toBe("unchecked");
  });
});
