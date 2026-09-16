import { describe, it, expect } from "vitest";
import {
  asModerationStatus,
  moderationPatch,
  MODERATION_APPROVED,
  MODERATION_PENDING,
  MODERATION_REJECTED,
} from "@/lib/material-moderation";

/**
 * Moderation state used to be written into `openai_file_id` as the sentinels
 * "moderated" / "rejected". That column is read everywhere as a real OpenAI file
 * id, so a moderated image could not be deleted at all: `delete-from-openai` sent
 * `file_id=moderated`, OpenAI answered 400 ("Expected an ID that begins with
 * 'file'"), and the handler — which refuses to delete a file it could not detach
 * from the vector store — returned 502 before anything local was removed.
 *
 * These tests pin the two halves of the fix: the outcome has its own field, and
 * the patch touches nothing else.
 */
describe("moderationPatch", () => {
  it("records an approval in moderation_status", () => {
    expect(moderationPatch({ decision: "ALLOW", description: "A labelled cell diagram" })).toEqual({
      is_moderated: true,
      moderation_status: MODERATION_APPROVED,
      ai_description: "A labelled cell diagram",
      // The uploader's own description is overridden with what moderation saw.
      description: "A labelled cell diagram",
    });
  });

  it("leaves description alone when an approval carries no description", () => {
    // The key is absent entirely: a patch with `description: null` would blank
    // whatever the uploader wrote and put nothing in its place.
    expect(moderationPatch({ decision: "ALLOW", description: "   " })).not.toHaveProperty(
      "description",
    );
    expect(moderationPatch({ decision: "ALLOW" })).not.toHaveProperty("description");
  });

  it("never overwrites description with a rejection reason", () => {
    // A rejection's description is empty by schema, and the reason is already
    // shown from `ai_description`.
    expect(
      moderationPatch({ decision: "REJECT", reason_category: "violence", description: "" }),
    ).not.toHaveProperty("description");
  });

  it("records a rejection with its reason", () => {
    expect(
      moderationPatch({ decision: "REJECT", reason_category: "violence", notes: "graphic injury" }),
    ).toEqual({
      is_moderated: true,
      moderation_status: MODERATION_REJECTED,
      ai_description: "REJECTED: violence - graphic injury",
    });
  });

  it("omits the note separator when there is no note", () => {
    expect(moderationPatch({ decision: "REJECT", reason_category: "nudity" }).ai_description).toBe(
      "REJECTED: nudity",
    );
  });

  it("treats anything that is not an explicit ALLOW as a rejection", () => {
    // The edge function is the only caller, but a malformed or empty response
    // must not be able to approve an image by default.
    expect(moderationPatch({}).moderation_status).toBe(MODERATION_REJECTED);
    expect(moderationPatch({ decision: "allow" }).moderation_status).toBe(MODERATION_REJECTED);
  });

  it("never writes to openai_file_id — the bug that made moderated images undeletable", () => {
    expect(Object.keys(moderationPatch({ decision: "ALLOW", description: "fine" })).sort()).toEqual([
      "ai_description",
      "description",
      "is_moderated",
      "moderation_status",
    ]);
    expect(
      Object.keys(moderationPatch({ decision: "REJECT", reason_category: "violence" })).sort(),
    ).toEqual(["ai_description", "is_moderated", "moderation_status"]);
  });

  it("sets is_moderated for a rejection too — it means moderation RAN, not 'approved'", () => {
    expect(moderationPatch({ decision: "REJECT", reason_category: "violence" }).is_moderated).toBe(
      true,
    );
  });
});

describe("asModerationStatus", () => {
  it("passes through the three known values", () => {
    expect(asModerationStatus("approved")).toBe(MODERATION_APPROVED);
    expect(asModerationStatus("rejected")).toBe(MODERATION_REJECTED);
    expect(asModerationStatus("pending")).toBe(MODERATION_PENDING);
  });

  it("treats an unknown or absent value as unmoderated", () => {
    expect(asModerationStatus(null)).toBe(MODERATION_PENDING);
    expect(asModerationStatus(undefined)).toBe(MODERATION_PENDING);
    // The old sentinel, should a row somehow survive the backfill unmigrated.
    expect(asModerationStatus("moderated")).toBe(MODERATION_PENDING);
  });
});
