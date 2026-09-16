import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PDFDocument } from "pdf-lib";

/**
 * Guards the one field that decides whether an uploaded material is INDEXED or
 * merely uploaded (#1108).
 *
 * `upload-to-openai` adds a file to the institution's vector store only if the
 * request lets it resolve a course — `courseId`, or a `materialId` it can read
 * `course_id` off. This dialog has no materialId (it uploads BEFORE inserting
 * the row, so a material that fails to reach OpenAI is never created), so
 * `courseId` is the only thing keeping the file out of limbo. Omitting it cost
 * nothing visible: the function still answers `success: true`, with
 * `addedToVectorStore: false` that no caller reads. The regression is therefore
 * silent by construction, which is exactly why it is worth a test rather than
 * trusting review to notice a missing key.
 */

const mockInvoke = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockDownload = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: mockUpload,
        download: mockDownload,
        remove: mockRemove,
      }),
    },
    functions: { invoke: mockInvoke },
    from: () => ({ insert: mockInsert }),
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mockToastError, info: vi.fn(), warning: vi.fn() },
}));

import { MaterialUploadDialog } from "@/components/MaterialUploadDialog";

const COURSE_ID = "course-1";

/**
 * A real (tiny) PDF — the dialog parses the file with pdf-lib on selection, so
 * a stub Blob would fail before any of the behaviour under test runs.
 *
 * `arrayBuffer()` is patched on because jsdom's File does not implement it, and
 * the component calls it first thing: without this the whole selection path
 * throws, `file` is never set, and the Upload button stays disabled forever —
 * which is a test-environment gap, not the component misbehaving.
 */
async function pdfFile(name = "textbook.pdf"): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  // Copied into a fresh Uint8Array because pdf-lib types `save()` as
  // `Uint8Array<ArrayBufferLike>`, which the DOM lib no longer accepts as a
  // BlobPart (it could be backed by a SharedArrayBuffer). The copy is
  // ArrayBuffer-backed, so it satisfies both `File` and `arrayBuffer()`.
  const bytes = new Uint8Array(await doc.save());
  const file = new File([bytes], name, { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return file;
}

/**
 * Two reasons this is not `userEvent.upload`:
 *   * the input is `display: none` (a styled drop zone triggers it), and upload
 *     clicks its target first, which a hidden element cannot accept;
 *   * the dialog renders through a Radix portal, so the input is under
 *     `document.body`, not under the container `render()` returns.
 */
function selectFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("MaterialUploadDialog rendered no file input");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("MaterialUploadDialog — upload-to-openai payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpload.mockResolvedValue({ error: null });
    mockDownload.mockResolvedValue({ data: new Blob(["pdf"]), error: null });
    mockRemove.mockResolvedValue({ error: null });
    mockInsert.mockResolvedValue({ error: null });
    mockInvoke.mockResolvedValue({ data: { openaiFileId: "file-abc" }, error: null });
  });

  it("passes courseId so the file is indexed into the institution vector store", async () => {
    const user = userEvent.setup();
    render(
      <MaterialUploadDialog
        courseId={COURSE_ID}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    selectFile(await pdfFile());

    // Selection stages the file to a temp path; the Upload button stays disabled
    // until that finishes, so waiting on it is what sequences this test.
    const submit = screen.getByRole("button", { name: /^upload$/i });
    await waitFor(() => expect(submit).toBeEnabled(), { timeout: 10_000 });
    await user.click(submit);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());

    const [fnName, options] = mockInvoke.mock.calls[0];
    expect(fnName).toBe("upload-to-openai");
    expect(options.body).toMatchObject({
      courseId: COURSE_ID,
      fileName: "textbook.pdf",
    });
    expect(options.body.filePath).toContain(COURSE_ID);
  }, 20_000);

  it("still creates the material row after the upload call", async () => {
    const user = userEvent.setup();
    render(
      <MaterialUploadDialog
        courseId={COURSE_ID}
        open
        onOpenChange={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    selectFile(await pdfFile());
    const submit = screen.getByRole("button", { name: /^upload$/i });
    await waitFor(() => expect(submit).toBeEnabled(), { timeout: 10_000 });
    await user.click(submit);

    // The row carries the file id the function returned — the ordering that
    // makes courseId (not materialId) the only resolvable handle at call time.
    await waitFor(() =>
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ course_id: COURSE_ID, openai_file_id: "file-abc" }),
      ),
    );
  }, 20_000);
});
