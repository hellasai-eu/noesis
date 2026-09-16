/**
 * #1100 — InstitutionLogoUpload: the two validations and the replace-in-place
 * write.
 *
 * What is worth pinning:
 *
 *  - the FILE GATE. Type and size are checked in the browser and nowhere else
 *    on this path, so a widened regex or a mis-stated limit is the whole
 *    control. A rejected file must also leave no preview behind — the Save
 *    button only exists while one is showing, so a preview from a rejected file
 *    is an upload of a rejected file.
 *  - the REPLACE, which deletes the previous object BEFORE writing the new one.
 *    The stored name is timestamped, so skipping the delete does not overwrite;
 *    it silently accumulates an orphan per logo change.
 *  - the ORDER of the write: storage first, then `institutions.logo_url`. The
 *    row is what everything else reads, so it must never point at an object
 *    that failed to upload.
 *
 * The two code paths derive the storage key DIFFERENTLY — upload takes the last
 * URL segment and re-prefixes the institution id, remove splits on the bucket
 * name — so both are asserted rather than assumed equivalent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const storage = vi.hoisted(() => ({
  uploads: [] as Array<{ path: string; options: unknown }>,
  removed: [] as string[][],
  uploadError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  publicUrl: "https://cdn.test/storage/v1/object/public/institution-logos/inst-1/999.png",
  updates: [] as Array<{ values: Record<string, unknown>; filters: unknown[] }>,
  /**
   * One ordered log across storage AND the database. The per-operation arrays
   * above only prove each call happened; both orderings that matter here are
   * relative, so they need a single sequence to be assertable at all.
   */
  calls: [] as string[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const buildChain = () => {
    const filters: unknown[] = [];
    let values: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    chain.update = (v: Record<string, unknown>) => {
      values = v;
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (storage.updateError) {
        return Promise.resolve(resolve({ data: null, error: storage.updateError }));
      }
      storage.calls.push("db:update");
      storage.updates.push({ values, filters });
      return Promise.resolve(resolve({ data: null, error: null }));
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn(() => buildChain()),
      storage: {
        from: vi.fn(() => ({
          upload: vi.fn(async (path: string, _file: unknown, options: unknown) => {
            if (storage.uploadError) return { data: null, error: storage.uploadError };
            storage.calls.push("storage:upload");
            storage.uploads.push({ path, options });
            return { data: { path }, error: null };
          }),
          remove: vi.fn(async (paths: string[]) => {
            storage.calls.push("storage:remove");
            storage.removed.push(paths);
            return { data: null, error: null };
          }),
          getPublicUrl: vi.fn(() => ({ data: { publicUrl: storage.publicUrl } })),
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

import { InstitutionLogoUpload } from "@/components/InstitutionLogoUpload";

const INST = "inst-1";
const EXISTING =
  "https://cdn.test/storage/v1/object/public/institution-logos/inst-1/111.png";

/** A file of an exact type and size — `size` is what the gate reads. */
function imageFile(name: string, type: string, size = 1024) {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/**
 * `applyAccept: false` because the input carries an `accept` list and
 * userEvent would otherwise silently drop the rejected fixtures — which are
 * exactly the ones the validation tests need to reach the handler.
 */
function setup() {
  return userEvent.setup({ applyAccept: false });
}

function renderUpload(currentLogoUrl: string | null = null) {
  const onLogoUpdate = vi.fn();
  render(
    <InstitutionLogoUpload
      institutionId={INST}
      currentLogoUrl={currentLogoUrl}
      onLogoUpdate={onLogoUpdate}
    />,
  );
  return { onLogoUpdate };
}

async function openDialog(user: ReturnType<typeof setup>, currentLogoUrl: string | null = null) {
  const rendered = renderUpload(currentLogoUrl);
  await user.click(screen.getByRole("button", { name: /Logo/ }));
  await screen.findByRole("dialog");
  return rendered;
}

function fileInput() {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("no file input");
  return input as HTMLInputElement;
}

/**
 * Asserts the stored key is `<institution>/<now>.<ext>`, with the timestamp
 * taken from the window the save actually ran in. A frozen clock cannot be
 * used here — userEvent needs time to advance — and a bare pattern would let a
 * hardcoded constant through, so the bounds are what make it meaningful.
 */
function expectTimestampedKey(path: string, ext: string, from: number, to: number) {
  const match = new RegExp(`^${INST}/(\\d+)\\.${ext}$`).exec(path);
  expect(match, `unexpected storage key: ${path}`).not.toBeNull();
  const stamp = Number(match![1]);
  expect(stamp).toBeGreaterThanOrEqual(from);
  expect(stamp).toBeLessThanOrEqual(to);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("confirm", vi.fn(() => true));
  storage.uploads = [];
  storage.calls = [];
  storage.removed = [];
  storage.uploadError = null;
  storage.updateError = null;
  storage.updates = [];
  storage.publicUrl =
    "https://cdn.test/storage/v1/object/public/institution-logos/inst-1/999.png";
});

describe("InstitutionLogoUpload — the trigger", () => {
  it("offers to add a logo when there is none", () => {
    renderUpload(null);
    expect(screen.getByRole("button", { name: /Add Logo/ })).toBeInTheDocument();
  });

  it("offers to change the logo when one is set", () => {
    renderUpload(EXISTING);
    expect(screen.getByRole("button", { name: /Change Logo/ })).toBeInTheDocument();
  });
});

describe("InstitutionLogoUpload — the file gate", () => {
  it("turns away a file that is not one of the four image types", async () => {
    const user = setup();
    await openDialog(user);

    await user.upload(fileInput(), imageFile("doc.pdf", "application/pdf"));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Please select a JPG, GIF, PNG, or WebP image",
      ),
    );
    // No preview means no Save button, so the file cannot be uploaded.
    expect(screen.queryByRole("button", { name: "Save Logo" })).not.toBeInTheDocument();
  });

  it("turns away an SVG, which is an image but not an allowed one", async () => {
    const user = setup();
    await openDialog(user);

    await user.upload(fileInput(), imageFile("logo.svg", "image/svg+xml"));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "Please select a JPG, GIF, PNG, or WebP image",
      ),
    );
    expect(screen.queryByRole("button", { name: "Save Logo" })).not.toBeInTheDocument();
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "accepts %s",
    async (type) => {
      const user = setup();
      await openDialog(user);

      await user.upload(fileInput(), imageFile("logo.png", type));

      expect(await screen.findByRole("button", { name: "Save Logo" })).toBeInTheDocument();
      expect(toastMocks.error).not.toHaveBeenCalled();
    },
  );

  it("turns away anything over five megabytes", async () => {
    const user = setup();
    await openDialog(user);

    await user.upload(
      fileInput(),
      imageFile("big.png", "image/png", 5 * 1024 * 1024 + 1),
    );

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("Image must be less than 5MB"),
    );
    expect(screen.queryByRole("button", { name: "Save Logo" })).not.toBeInTheDocument();
  });

  it("accepts a file of exactly five megabytes", async () => {
    const user = setup();
    await openDialog(user);

    await user.upload(fileInput(), imageFile("exact.png", "image/png", 5 * 1024 * 1024));

    expect(await screen.findByRole("button", { name: "Save Logo" })).toBeInTheDocument();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("shows the chosen file before it is committed", async () => {
    const user = setup();
    await openDialog(user);

    await user.upload(fileInput(), imageFile("logo.png", "image/png"));

    expect(await screen.findByRole("img", { name: "Preview" })).toBeInTheDocument();
  });

  it("lets the choice be taken back", async () => {
    const user = setup();
    await openDialog(user, EXISTING);
    await user.upload(fileInput(), imageFile("logo.png", "image/png"));
    await screen.findByRole("img", { name: "Preview" });

    // The X sits on the preview; it is the only destructive icon button here.
    const clear = screen
      .getAllByRole("button")
      .find((b) => b.className.includes("-top-2"));
    await user.click(clear!);

    await waitFor(() =>
      expect(screen.queryByRole("img", { name: "Preview" })).not.toBeInTheDocument(),
    );
    expect(fileInput().value).toBe("");
    expect(screen.queryByRole("button", { name: "Save Logo" })).not.toBeInTheDocument();
    // The existing logo is showing again, so Remove is back on offer.
    expect(screen.getByRole("button", { name: "Remove Logo" })).toBeInTheDocument();
  });
});

describe("InstitutionLogoUpload — saving", () => {
  async function chooseAndSave(currentLogoUrl: string | null, fileName = "logo.png") {
    const user = setup();
    const rendered = await openDialog(user, currentLogoUrl);
    await user.upload(fileInput(), imageFile(fileName, "image/png"));
    await screen.findByRole("button", { name: "Save Logo" });
    const from = Date.now();
    await user.click(screen.getByRole("button", { name: "Save Logo" }));
    return { user, from, ...rendered };
  }

  it("stores the file under the institution, then points the row at it", async () => {
    const { onLogoUpdate, from } = await chooseAndSave(null);

    await waitFor(() => expect(storage.uploads).toHaveLength(1));
    expectTimestampedKey(storage.uploads[0].path, "png", from, Date.now());
    expect(storage.uploads[0].options).toEqual({ cacheControl: "3600", upsert: true });
    expect(storage.updates).toEqual([
      {
        values: { logo_url: storage.publicUrl },
        filters: [{ col: "id", val: INST }],
      },
    ]);
    expect(onLogoUpdate).toHaveBeenCalledWith(storage.publicUrl);
    expect(toastMocks.success).toHaveBeenCalledWith("Logo updated successfully");
    // The row must never be pointed at an object that is not there yet.
    expect(storage.calls).toEqual(["storage:upload", "db:update"]);
  });

  it("closes once the logo is saved", async () => {
    await chooseAndSave(null);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("clears out the logo it is replacing, before writing the new one", async () => {
    await chooseAndSave(EXISTING);

    await waitFor(() => expect(storage.uploads).toHaveLength(1));
    expect(storage.removed).toEqual([[`${INST}/111.png`]]);
    // Order matters and is not incidental: the new object is timestamped, so a
    // remove that runs afterwards deletes the logo that was just uploaded.
    expect(storage.calls).toEqual(["storage:remove", "storage:upload", "db:update"]);
  });

  it("removes nothing when there was no logo to replace", async () => {
    await chooseAndSave(null);

    await waitFor(() => expect(storage.uploads).toHaveLength(1));
    expect(storage.removed).toHaveLength(0);
  });

  it("leaves the row untouched when the file does not reach storage", async () => {
    storage.uploadError = { message: "bucket full" };

    const { onLogoUpdate } = await chooseAndSave(null);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("bucket full"));
    expect(storage.updates).toHaveLength(0);
    expect(onLogoUpdate).not.toHaveBeenCalled();
    // Still open, so the admin can retry rather than losing the selection.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not claim success when the row write fails", async () => {
    storage.updateError = { message: "update denied" };

    const { onLogoUpdate } = await chooseAndSave(null);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("update denied"));
    expect(onLogoUpdate).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("keeps the file's own extension", async () => {
    const user = setup();
    await openDialog(user, null);
    await user.upload(fileInput(), imageFile("brand.webp", "image/webp"));
    await screen.findByRole("button", { name: "Save Logo" });
    const from = Date.now();
    await user.click(screen.getByRole("button", { name: "Save Logo" }));

    await waitFor(() => expect(storage.uploads).toHaveLength(1));
    expectTimestampedKey(storage.uploads[0].path, "webp", from, Date.now());
  });
});

describe("InstitutionLogoUpload — removing", () => {
  it("is not offered when there is no logo", async () => {
    const user = setup();
    await openDialog(user, null);

    expect(screen.queryByRole("button", { name: "Remove Logo" })).not.toBeInTheDocument();
  });

  it("steps aside while a replacement is pending", async () => {
    const user = setup();
    await openDialog(user, EXISTING);
    expect(screen.getByRole("button", { name: "Remove Logo" })).toBeInTheDocument();

    await user.upload(fileInput(), imageFile("logo.png", "image/png"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove Logo" })).not.toBeInTheDocument(),
    );
  });

  it("asks first, and does nothing if the admin backs out", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const user = setup();
    const { onLogoUpdate } = await openDialog(user, EXISTING);

    await user.click(screen.getByRole("button", { name: "Remove Logo" }));

    expect(storage.removed).toHaveLength(0);
    expect(storage.updates).toHaveLength(0);
    expect(onLogoUpdate).not.toHaveBeenCalled();
  });

  it("drops the stored object and nulls the row", async () => {
    const user = setup();
    const { onLogoUpdate } = await openDialog(user, EXISTING);

    await user.click(screen.getByRole("button", { name: "Remove Logo" }));

    await waitFor(() => expect(storage.updates).toHaveLength(1));
    // The key is everything after the bucket name, not just the file.
    expect(storage.removed).toEqual([[`${INST}/111.png`]]);
    expect(storage.updates[0]).toEqual({
      values: { logo_url: null },
      filters: [{ col: "id", val: INST }],
    });
    expect(onLogoUpdate).toHaveBeenCalledWith(null);
    expect(toastMocks.success).toHaveBeenCalledWith("Logo removed");
    // The row is the only record of where the object lives, so it is nulled
    // last — losing it first would strand the file with nothing naming it.
    expect(storage.calls).toEqual(["storage:remove", "db:update"]);
  });

  it("keeps the logo when the row cannot be nulled", async () => {
    storage.updateError = { message: "denied" };
    const user = setup();
    const { onLogoUpdate } = await openDialog(user, EXISTING);

    await user.click(screen.getByRole("button", { name: "Remove Logo" }));

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith("denied"));
    expect(onLogoUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
