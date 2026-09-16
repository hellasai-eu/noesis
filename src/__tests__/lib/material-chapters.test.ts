/**
 * #1019 — reclassifying a split textbook into a chapterless type ("Images" or
 * "Other") would strand its `material_chapters` rows and their uploaded split
 * PDFs: still stored, but behind controls the UI now hides for those types.
 *
 * The guard refuses the change rather than deleting the chapters, because a
 * chapter owns its cheat sheet and flashcards and is referenced by
 * `question_chapters` — a silent cleanup during a metadata edit would destroy
 * generated content.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const countResult = vi.hoisted(
  () => ({ count: 0 as number | null, error: null as unknown }),
);
const eqSpy = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: () => ({
        eq: (col: string, val: string) => {
          eqSpy(col, val);
          return Promise.resolve(countResult);
        },
      }),
    })),
  },
}));

import { blockedReclassificationReason } from "@/lib/material-chapters";

beforeEach(() => {
  countResult.count = 0;
  countResult.error = null;
  eqSpy.mockClear();
});

describe("blockedReclassificationReason (#1019)", () => {
  it("blocks a chaptered textbook from becoming 'other'", async () => {
    countResult.count = 7;

    const reason = await blockedReclassificationReason("mat-1", "textbook", "other");

    expect(reason).toContain("7 chapters");
    expect(reason).toContain("Other");
    expect(reason).toContain("Delete the chapters first");
    expect(eqSpy).toHaveBeenCalledWith("material_id", "mat-1");
  });

  it("blocks a chaptered textbook from becoming 'images' too", async () => {
    countResult.count = 1;

    const reason = await blockedReclassificationReason("mat-1", "textbook", "images");

    // Singular, because the message is shown to a person.
    expect(reason).toContain("1 chapter.");
    expect(reason).toContain("Images");
  });

  it("allows the change when the material has no chapters", async () => {
    countResult.count = 0;

    expect(await blockedReclassificationReason("mat-1", "textbook", "other")).toBeNull();
  });

  it("allows reclassification into a chaptered type without querying at all", async () => {
    countResult.count = 99;

    expect(
      await blockedReclassificationReason("mat-1", "other", "textbook"),
    ).toBeNull();
    // Moving OUT of a chapterless type strands nothing, so no lookup is needed.
    expect(eqSpy).not.toHaveBeenCalled();
  });

  it("allows a no-op change, and chapterless -> chapterless", async () => {
    countResult.count = 99;

    expect(await blockedReclassificationReason("mat-1", "other", "other")).toBeNull();
    expect(await blockedReclassificationReason("mat-1", "images", "other")).toBeNull();
    expect(eqSpy).not.toHaveBeenCalled();
  });

  it("surfaces a failed count rather than silently allowing the change", async () => {
    countResult.error = { message: "boom" };

    await expect(
      blockedReclassificationReason("mat-1", "textbook", "other"),
    ).rejects.toBeTruthy();
  });
});
