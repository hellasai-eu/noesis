/**
 * GenerateImageDialog: pick a chapter → describe the image → generate → save.
 *
 * The dialog calls `generate-study-image` with the instructor's prompt plus a
 * context line built from the chapter, then files the returned PNG as an
 * "Images" material.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const chapters = [
  { id: "ch-1", material_id: "mat-1", title: "Volcanoes", chapter_number: 1 },
  { id: "ch-2", material_id: "mat-1", title: "Earthquakes", chapter_number: 2 },
];

const inserts = vi.hoisted(() => ({ current: [] as { table: string; rows: unknown }[] }));
const uploads = vi.hoisted(() => ({ current: [] as { path: string; body: unknown }[] }));
const removed = vi.hoisted(() => ({ current: [] as string[] }));
const insertError = vi.hoisted(() => ({ current: null as { message: string } | null }));

vi.mock("@/integrations/supabase/client", () => {
  const chapterChain = () => {
    const chain: Record<string, (...a: unknown[]) => unknown> = {};
    const passThrough = () => chain;
    chain.select = passThrough;
    chain.in = passThrough;
    chain.order = (...args: unknown[]) => {
      // The second .order("id") has no options object and ends the chain.
      if (args.length === 1) return Promise.resolve({ data: chapters, error: null });
      return chain;
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === "material_chapters") return chapterChain();
        return {
          insert: (rows: unknown) => {
            inserts.current.push({ table, rows });
            return Promise.resolve({ data: null, error: insertError.current });
          },
        };
      }),
      storage: {
        from: () => ({
          upload: (path: string, body: unknown) => {
            uploads.current.push({ path, body });
            return Promise.resolve({ data: { path }, error: null });
          },
          remove: (paths: string[]) => {
            removed.current.push(...paths);
            return Promise.resolve({ data: null, error: null });
          },
        }),
      },
      auth: {
        getSession: () =>
          Promise.resolve({ data: { session: { access_token: "user-token" } } }),
      },
    },
  };
});

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "instructor-1" } }),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

beforeAll(() => {
  for (const fn of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
  ] as const) {
    if (!(Element.prototype as unknown as Record<string, unknown>)[fn]) {
      (Element.prototype as unknown as Record<string, unknown>)[fn] = () => {};
    }
  }
});

import { GenerateImageDialog } from "@/components/GenerateImageDialog";

// A 1x1 transparent PNG — enough for `atob` to decode into a real Blob.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMAGE_DATA_URI = `data:image/png;base64,${PNG_B64}`;

const materials = [{ id: "mat-1", title: "Geology", file_name: "geology.pdf" }];

const renderDialog = (onSuccess = vi.fn(), onOpenChange = vi.fn()) => {
  const view = render(
    <GenerateImageDialog
      courseId="course-1"
      courseTitle="Earth Science"
      materials={materials}
      open
      onOpenChange={onOpenChange}
      onSuccess={onSuccess}
    />,
  );
  const setOpen = (open: boolean) =>
    view.rerender(
      <GenerateImageDialog
        courseId="course-1"
        courseTitle="Earth Science"
        materials={materials}
        open={open}
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
      />,
    );
  return { onSuccess, onOpenChange, setOpen };
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  inserts.current = [];
  uploads.current = [];
  removed.current = [];
  insertError.current = null;
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ imageUrl: IMAGE_DATA_URI }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

const pickChapterAndPrompt = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("combobox"));
  await user.click(await screen.findByText(/1\. Volcanoes/));
  await user.type(
    screen.getByLabelText(/What should the image show/i),
    "cross-section of a volcano",
  );
};

describe("GenerateImageDialog", () => {
  it("sends the instructor's prompt with the chapter as context", async () => {
    renderDialog();
    const user = userEvent.setup();

    await pickChapterAndPrompt(user);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/functions/v1/generate-study-image");
    // The caller's own token — the anon key does not resolve to a user (#1137).
    expect(init.headers.Authorization).toBe("Bearer user-token");

    const body = JSON.parse(init.body);
    expect(body.prompt).toBe("cross-section of a volcano");
    expect(body.context).toContain("Course: Earth Science");
    expect(body.context).toContain("Material: Geology");
    expect(body.context).toContain("Chapter 1: Volcanoes");
  });

  it("cannot generate before a chapter and a prompt are given", async () => {
    renderDialog();

    expect(screen.getByRole("button", { name: /^Generate$/i })).toBeDisabled();
  });

  it("files the generated image as an unmoderated Images material", async () => {
    const { onSuccess, onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await pickChapterAndPrompt(user);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await user.click(await screen.findByRole("button", { name: /Save to materials/i }));

    await waitFor(() => expect(inserts.current).toHaveLength(1));

    const { table, rows } = inserts.current[0];
    expect(table).toBe("course_materials");
    expect(rows).toMatchObject({
      course_id: "course-1",
      material_type: "images",
      uploaded_by: "instructor-1",
      // An AI-drawn image faces the same review as an uploaded one.
      is_moderated: false,
      description: "cross-section of a volcano",
    });

    // A .png name, so every file-name router treats it as the image it is.
    expect((rows as { file_name: string }).file_name).toMatch(/\.png$/);
    expect(uploads.current).toHaveLength(1);
    expect(uploads.current[0].path).toContain("course-1/");
    expect((uploads.current[0].body as Blob).type).toBe("image/png");

    expect(onSuccess).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves the chapter and prompt it generated from, not later edits", async () => {
    renderDialog();
    const user = userEvent.setup();

    await pickChapterAndPrompt(user);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));
    await screen.findByRole("button", { name: /Save to materials/i });

    // The instructor changes their mind about the chapter after the image is back.
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText(/2\. Earthquakes/));

    // The mismatch is stated rather than silently saved.
    expect(await screen.findByText(/generated for .Volcanoes./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Save to materials/i }));
    await waitFor(() => expect(inserts.current).toHaveLength(1));

    // Title defaulted from the generated chapter, description from its prompt.
    expect(inserts.current[0].rows).toMatchObject({
      title: "Volcanoes — illustration",
      description: "cross-section of a volcano",
    });
  });

  it("drops an image that arrives after the dialog was closed", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { setOpen } = renderDialog();
    const user = userEvent.setup();

    await pickChapterAndPrompt(user);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    // Closed mid-generation; the request only lands afterwards.
    setOpen(false);
    resolveFetch({ ok: true, json: () => Promise.resolve({ imageUrl: IMAGE_DATA_URI }) });

    setOpen(true);

    // The next session starts clean rather than inheriting the previous image.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Save to materials/i })).toBeNull(),
    );
  });

  it("removes the uploaded file when the material row cannot be written", async () => {
    insertError.current = { message: "insert failed" };

    renderDialog();
    const user = userEvent.setup();

    await pickChapterAndPrompt(user);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));
    await user.click(await screen.findByRole("button", { name: /Save to materials/i }));

    await waitFor(() => expect(removed.current).toEqual([uploads.current[0].path]));
    expect(toastMocks.error).toHaveBeenCalledWith("insert failed");
  });

  it("surfaces the function's error message and saves nothing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Too many images generated. Please try again later." }),
    });

    renderDialog();
    const user = userEvent.setup();

    await pickChapterAndPrompt(user);
    await user.click(screen.getByRole("button", { name: /^Generate$/i }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Too many images generated. Please try again later.",
      ),
    );
    expect(screen.queryByRole("button", { name: /Save to materials/i })).toBeNull();
    expect(inserts.current).toHaveLength(0);
  });
});
