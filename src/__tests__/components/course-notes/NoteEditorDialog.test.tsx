import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteEditorDialog } from "@/components/course-notes/NoteEditorDialog";
import { MAX_NOTE_BYTES } from "@/components/course-notes/note-files";

const SECTIONS = [
  { offeringId: "off-a", label: "Section A" },
  { offeringId: "off-b", label: "Section B" },
];

function makeFile(name: string, size = 1024, type = "application/pdf") {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("NoteEditorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the upload title when there are no initial values", () => {
    render(<NoteEditorDialog open onOpenChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("heading", { name: "Upload note" })).toBeInTheDocument();
  });

  it("renders the edit title and the current file name when editing", () => {
    render(
      <NoteEditorDialog
        open
        onOpenChange={() => {}}
        initialValues={{
          title: "Existing",
          description: "desc",
          offeringIds: ["off-a"],
          fileName: "old.pdf",
        }}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByText("Edit note")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Existing")).toBeInTheDocument();
    expect(screen.getByText("old.pdf")).toBeInTheDocument();
  });

  it("refuses to submit an upload with no file chosen", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<NoteEditorDialog open onOpenChange={() => {}} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /upload note/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("Choose a file to upload")).toBeInTheDocument();
  });

  it("rejects a disallowed file type at pick time and does not keep the file", async () => {
    // applyAccept:false on purpose — the accept attribute is advisory, a user
    // can pick "All files" in the OS dialog, so the guard has to hold anyway.
    const user = userEvent.setup({ applyAccept: false });
    render(<NoteEditorDialog open onOpenChange={() => {}} onSubmit={() => {}} />);

    await user.upload(
      screen.getByLabelText("File") as HTMLInputElement,
      makeFile("payload.exe", 1024, "application/x-msdownload"),
    );

    expect(await screen.findByText(/Unsupported file type/)).toBeInTheDocument();
    expect(screen.queryByText(/payload\.exe ·/)).not.toBeInTheDocument();
  });

  it("rejects a file over the size ceiling", async () => {
    const user = userEvent.setup();
    render(<NoteEditorDialog open onOpenChange={() => {}} onSubmit={() => {}} />);

    await user.upload(
      screen.getByLabelText("File") as HTMLInputElement,
      makeFile("huge.pdf", MAX_NOTE_BYTES + 1),
    );

    expect(await screen.findByText(/too large/)).toBeInTheDocument();
  });

  it("defaults the title to the file's stem on first pick", async () => {
    const user = userEvent.setup();
    render(<NoteEditorDialog open onOpenChange={() => {}} onSubmit={() => {}} />);

    await user.upload(
      screen.getByLabelText("File") as HTMLInputElement,
      makeFile("chapter-3.pdf"),
    );

    expect(screen.getByLabelText("Title")).toHaveValue("chapter-3");
  });

  it("submits the file, trimmed text and the selected sections", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <NoteEditorDialog
        open
        onOpenChange={() => {}}
        sections={SECTIONS}
        onSubmit={onSubmit}
      />,
    );

    const file = makeFile("notes.pdf");
    await user.upload(screen.getByLabelText("File") as HTMLInputElement, file);
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "  Lecture 1  ");
    await user.click(screen.getByLabelText("Distribute to section Section B"));
    await user.click(screen.getByRole("button", { name: /upload note/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: "Lecture 1",
      description: "",
      offeringIds: ["off-b"],
      file,
    });
  });

  it("submits a metadata-only edit with a null file", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <NoteEditorDialog
        open
        onOpenChange={() => {}}
        sections={SECTIONS}
        initialValues={{
          title: "Existing",
          description: "old desc",
          offeringIds: ["off-a"],
          fileName: "old.pdf",
        }}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: "Existing",
      description: "old desc",
      offeringIds: ["off-a"],
      file: null,
    });
  });

  it("keeps a note with no sections selected — the draft case", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <NoteEditorDialog
        open
        onOpenChange={() => {}}
        sections={SECTIONS}
        onSubmit={onSubmit}
      />,
    );

    await user.upload(
      screen.getByLabelText("File") as HTMLInputElement,
      makeFile("notes.pdf"),
    );
    await user.click(screen.getByRole("button", { name: /upload note/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ offeringIds: [] }),
    );
  });
});
