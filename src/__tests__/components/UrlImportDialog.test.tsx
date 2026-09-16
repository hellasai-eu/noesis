import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * The import has to end up indistinguishable from an uploaded material: a real
 * storage object, an OpenAI file id, and a `course_materials` row of type
 * "other". Each step is mocked here so the ORDER and the payloads are what the
 * test pins — particularly that the row is only written after OpenAI returned a
 * file id, which is what keeps a material that never reached OpenAI from
 * existing at all.
 */

const mockInvoke = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockToastSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({ upload: mockUpload, remove: mockRemove }),
    },
    functions: { invoke: mockInvoke },
    from: () => ({ insert: mockInsert }),
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError, info: vi.fn(), warning: vi.fn() },
}));

import { UrlImportDialog } from "@/components/UrlImportDialog";

const COURSE_ID = "course-1";
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PAGE_URL = "https://example.test/article";
/** A YouTube link naming no single video — no transcript to import. */
const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL123";

const VIDEO_RESULT = {
  kind: "youtube" as const,
  url: VIDEO_URL,
  videoId: "dQw4w9WgXcQ",
  title: "The French Revolution",
  author: "A channel",
  durationSeconds: 610,
  language: "el",
  markdown: "In 1789 the estates general met at Versailles.",
  characterCount: 45,
};

const PAGE_RESULT = {
  kind: "web" as const,
  url: PAGE_URL,
  videoId: null,
  title: "Η Γαλλική Επανάσταση",
  author: "example.test",
  durationSeconds: null,
  language: "el",
  markdown: "## Causes\n\n- Debt\n- Famine",
  characterCount: 26,
};

/**
 * The dialog always opens for one of the two imports; the menu that chose it
 * lives on CoursePage. Defaulting to "youtube" keeps the tests that are about
 * the shared half — the editor, the save, the rollback — free of the choice.
 */
function renderDialog(onSuccess = vi.fn(), kind: "youtube" | "web" = "youtube") {
  render(
    <UrlImportDialog
      courseId={COURSE_ID}
      kind={kind}
      courseLanguage="el"
      open
      onOpenChange={vi.fn()}
      onSuccess={onSuccess}
    />,
  );
}

/** Matches both labels — "Video link" and "Page link". */
async function fetchUrl(user: ReturnType<typeof userEvent.setup>, url = VIDEO_URL) {
  await user.type(screen.getByLabelText(/link$/i), url);
  await user.click(screen.getByRole("button", { name: /^fetch$/i }));
}

/**
 * The Markdown handed to storage.upload on the first call.
 *
 * Read through `FileReader` because jsdom's `Blob` implements neither `text()`
 * nor `arrayBuffer()`.
 */
function uploadedMarkdown(): Promise<string> {
  const blob = mockUpload.mock.calls[0][1] as Blob;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("UrlImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpload.mockResolvedValue({ error: null });
    mockRemove.mockResolvedValue({ error: null });
    mockInsert.mockResolvedValue({ error: null });
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") return Promise.resolve({ data: VIDEO_RESULT, error: null });
      if (name === "upload-to-openai") {
        return Promise.resolve({ data: { openaiFileId: "file-abc" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("does not mark itself as beta", () => {
    renderDialog();
    expect(screen.queryByText(/^beta$/i)).not.toBeInTheDocument();
  });

  it("refuses something that is not a link without calling the function", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user, "not a link");

    expect(await screen.findByText(/enter a link/i)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("sends the course language and the chosen kind with the request", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user);

    // A provider that can serve several languages should give back the one the
    // class is taught in. `kind` is the instructor's choice from the menu, not
    // something the server has to infer from the URL.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("fetch-url-content", {
        body: { url: VIDEO_URL, courseId: COURSE_ID, language: "el", kind: "youtube" },
      }),
    );
  });

  it("refuses a web page under the YouTube import, without calling the function", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user, PAGE_URL);

    expect(await screen.findByText(/not a YouTube video link/i)).toBeInTheDocument();
    // Nothing to learn from a round trip whose answer is already known here —
    // and a wasted provider credit if it were not caught.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("refuses a YouTube link under the web import, without calling the function", async () => {
    const user = userEvent.setup();
    renderDialog(vi.fn(), "web");

    await fetchUrl(user, VIDEO_URL);

    // Scraping a watch page returns YouTube's own furniture, not the video.
    expect(await screen.findByText(/is a YouTube link/i)).toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // A playlist names no video, so neither import can do anything with it — and
  // neither sends the instructor to the other one, which could not help either.
  // Split per kind rather than looped: one dialog per test keeps each fast
  // enough not to sit on userEvent's default timeout.
  it.each(["youtube", "web"] as const)(
    "refuses a YouTube link that names no video, under the %s import",
    async (kind) => {
      const user = userEvent.setup();
      renderDialog(vi.fn(), kind);

      await fetchUrl(user, PLAYLIST_URL);

      expect(await screen.findByText(/not a single video/i)).toBeInTheDocument();
      expect(mockInvoke).not.toHaveBeenCalled();
    },
  );

  it("names the import it was opened for", async () => {
    renderDialog(vi.fn(), "web");
    expect(screen.getByText(/import a web page/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/page link/i)).toBeInTheDocument();
  });

  it("previews the content before anything is saved", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user);

    expect(await screen.findByText(VIDEO_RESULT.markdown)).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toHaveValue(VIDEO_RESULT.title);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("stores a video's transcript as a Markdown 'other' material", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderDialog(onSuccess);

    await fetchUrl(user);
    await screen.findByText(VIDEO_RESULT.markdown);
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalled());

    const [storagePath, blob, options] = mockUpload.mock.calls[0];
    expect(storagePath.startsWith(`${COURSE_ID}/`)).toBe(true);
    expect(storagePath.endsWith(".md")).toBe(true);
    expect((options as { contentType: string }).contentType).toContain("text/markdown");
    expect((blob as Blob).type).toContain("text/markdown");

    const markdown = await uploadedMarkdown();
    expect(markdown).toContain("# The French Revolution");
    expect(markdown).toContain(`Source: ${VIDEO_URL}`);
    expect(markdown).toContain(VIDEO_RESULT.markdown);

    // No PDF conversion is involved any more.
    expect(mockInvoke.mock.calls.some(([name]) => name === "convert-md-to-pdf")).toBe(false);

    const openaiCall = mockInvoke.mock.calls.find(([name]) => name === "upload-to-openai");
    expect(openaiCall?.[1].body).toMatchObject({ courseId: COURSE_ID, filePath: storagePath });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        course_id: COURSE_ID,
        material_type: "other",
        title: VIDEO_RESULT.title,
        author: VIDEO_RESULT.author,
        description: VIDEO_URL,
        openai_file_id: "file-abc",
      }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("saves what the instructor edited, not what was fetched", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user);
    const editor = await screen.findByLabelText(/content \(markdown\)/i);

    // Extraction is imperfect — the point of the editor is that a mishearing or
    // a stray navigation crumb can be fixed rather than forcing a discard.
    await user.clear(editor);
    await user.type(editor, "In 1789 the Estates General met at Versailles.");
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalled());

    const markdown = await uploadedMarkdown();
    expect(markdown).toContain("In 1789 the Estates General met at Versailles.");
    expect(markdown).not.toContain("estates general met at Versailles.");
  });

  it("saves the instructor's own Markdown structure unescaped", async () => {
    const user = userEvent.setup();
    // The transcript arrives with a line that merely looks like Markdown; the
    // instructor then adds a heading of their own.
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") {
        return Promise.resolve({
          data: { ...VIDEO_RESULT, markdown: "# 1 thing to know\nand then some." },
          error: null,
        });
      }
      if (name === "upload-to-openai") {
        return Promise.resolve({ data: { openaiFileId: "file-abc" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    renderDialog();

    await fetchUrl(user);
    const editor = await screen.findByLabelText(/content \(markdown\)/i);

    // The caption's accidental marker is escaped on the way IN, so the editor
    // already shows what will be saved.
    expect(editor).toHaveValue("\\# 1 thing to know\nand then some.");

    await user.clear(editor);
    await user.type(editor, "## A heading I meant");
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalled());

    // What was approved in the editor is what landed in the file: a heading,
    // not "\## A heading I meant".
    const markdown = await uploadedMarkdown();
    expect(markdown).toContain("## A heading I meant");
    expect(markdown).not.toContain("\\##");
  });

  it("does not call an untouched transcript edited", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") {
        return Promise.resolve({
          data: { ...VIDEO_RESULT, markdown: "# 1 thing to know" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    renderDialog();

    await fetchUrl(user);
    await screen.findByLabelText(/content \(markdown\)/i);

    // "Edited" compares against the seeded text, not the raw response — the
    // escape is ours, not the instructor's.
    expect(screen.queryByRole("button", { name: /revert/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/edited/i)).not.toBeInTheDocument();
  });

  it("can revert back to what was fetched", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user);
    const editor = await screen.findByLabelText(/content \(markdown\)/i);

    // No revert offered until something actually differs.
    expect(screen.queryByRole("button", { name: /revert/i })).not.toBeInTheDocument();

    await user.clear(editor);
    await user.type(editor, "scratch that");
    await user.click(await screen.findByRole("button", { name: /revert/i }));

    expect(screen.getByLabelText(/content \(markdown\)/i)).toHaveValue(VIDEO_RESULT.markdown);
    expect(screen.queryByRole("button", { name: /revert/i })).not.toBeInTheDocument();
  });

  it("will not save an empty document", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user);
    await user.clear(await screen.findByLabelText(/content \(markdown\)/i));

    expect(screen.getByRole("button", { name: /save as material/i })).toBeDisabled();
    expect(screen.getByText(/add some text before saving/i)).toBeInTheDocument();
  });

  it("toggles between editing and a rendered preview", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") return Promise.resolve({ data: PAGE_RESULT, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    renderDialog(vi.fn(), "web");

    await fetchUrl(user, PAGE_URL);
    await screen.findByLabelText(/content \(markdown\)/i);

    await user.click(screen.getByRole("button", { name: /preview/i }));

    // Rendered, not raw: the heading is a heading rather than "## Causes".
    expect(await screen.findByRole("heading", { name: "Causes" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/content \(markdown\)/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByLabelText(/content \(markdown\)/i)).toHaveValue(PAGE_RESULT.markdown);
  });

  it("stores a web page's Markdown without escaping its structure", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") return Promise.resolve({ data: PAGE_RESULT, error: null });
      if (name === "upload-to-openai") {
        return Promise.resolve({ data: { openaiFileId: "file-web" }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    renderDialog(vi.fn(), "web");

    await fetchUrl(user, PAGE_URL);
    await screen.findByText(/Causes/);
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalled());

    const markdown = await uploadedMarkdown();
    expect(markdown).toContain("## Causes");
    expect(markdown).toContain("- Debt");
    expect(markdown).toContain("Site: example.test");
    // The page's own Markdown must survive: escaping it would destroy the
    // structure that makes it worth importing.
    expect(markdown).not.toContain("\\##");

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ description: PAGE_URL, material_type: "other" }),
    );
  });

  it("removes the stored object and creates no row when OpenAI sync fails", async () => {
    const user = userEvent.setup();
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") return Promise.resolve({ data: VIDEO_RESULT, error: null });
      return Promise.resolve({ data: { error: "OpenAI is down" }, error: null });
    });
    renderDialog();

    await fetchUrl(user);
    await screen.findByText(VIDEO_RESULT.markdown);
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("OpenAI is down"));
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalledWith([mockUpload.mock.calls[0][0]]);
  });

  it("cleans up the OpenAI file when the material row cannot be created", async () => {
    const user = userEvent.setup();
    mockInsert.mockResolvedValue({ error: { message: "insert failed" } });
    renderDialog();

    await fetchUrl(user);
    await screen.findByText(VIDEO_RESULT.markdown);
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    // Without this the file stays in the institution's vector store with no
    // owning row — and the ordinary deletion flow is driven from that row, so
    // nothing in the app could ever remove it.
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("delete-from-openai", {
        body: { action: "delete-orphan", openaiFileId: "file-abc", courseId: COURSE_ID },
      }),
    );
    expect(mockRemove).toHaveBeenCalledWith([mockUpload.mock.calls[0][0]]);
  });

  it("retries the cleanup once, then tells the user what was left behind", async () => {
    const user = userEvent.setup();
    mockInsert.mockResolvedValue({ error: { message: "insert failed" } });
    mockInvoke.mockImplementation((name: string) => {
      if (name === "fetch-url-content") return Promise.resolve({ data: VIDEO_RESULT, error: null });
      if (name === "upload-to-openai") {
        return Promise.resolve({ data: { openaiFileId: "file-abc" }, error: null });
      }
      // The cleanup fails both times.
      return Promise.resolve({ data: null, error: { message: "network down" } });
    });
    renderDialog();

    await fetchUrl(user);
    await screen.findByText(VIDEO_RESULT.markdown);
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() =>
      expect(
        mockInvoke.mock.calls.filter(([name]) => name === "delete-from-openai"),
      ).toHaveLength(2),
    );

    // A file that is indexed and owned by nothing is not a console-only
    // problem: the person who can act on it is not looking at devtools.
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("file-abc"),
        expect.objectContaining({ duration: expect.any(Number) }),
      ),
    );
  });

  it("does not delete the OpenAI file once the row owns it", async () => {
    const user = userEvent.setup();
    renderDialog();

    await fetchUrl(user);
    await screen.findByText(VIDEO_RESULT.markdown);
    await user.click(screen.getByRole("button", { name: /save as material/i }));

    await waitFor(() => expect(mockInsert).toHaveBeenCalled());
    expect(mockInvoke.mock.calls.some(([name]) => name === "delete-from-openai")).toBe(false);
  });

  it("surfaces the function's own message when there is nothing to import", async () => {
    const user = userEvent.setup();
    mockInvoke.mockResolvedValue({ data: { error: "This video has no transcript." }, error: null });
    renderDialog();

    await fetchUrl(user);

    expect(await screen.findByText("This video has no transcript.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save as material/i })).toBeDisabled();
  });
});
