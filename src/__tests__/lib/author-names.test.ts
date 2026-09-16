/**
 * Author-name resolution for the Author columns.
 *
 * The bug this covers: `profiles.full_name` is only filled from signup
 * metadata, so an invited or admin-created account has NULL there and every
 * question it authored rendered as "Unknown". `email` is written for every
 * account by `handle_new_user`, so it is the fallback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSupabaseFrom = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: mockSupabaseFrom },
}));

import { fetchAuthorNames } from "@/lib/author-names";

type ProfileRow = { user_id: string; full_name: string | null; email: string | null };

function mockProfiles(
  result: { data: ProfileRow[] | null; error: unknown },
): { selected: string | null; ids: string[] | null } {
  const captured: { selected: string | null; ids: string[] | null } = {
    selected: null,
    ids: null,
  };
  mockSupabaseFrom.mockImplementation((table: string) => {
    expect(table).toBe("profiles");
    const chain: Record<string, unknown> = {};
    chain.select = (cols: string) => {
      captured.selected = cols;
      return chain;
    };
    chain.in = (_col: string, ids: string[]) => {
      captured.ids = ids;
      return Promise.resolve(result);
    };
    return chain;
  });
  return captured;
}

beforeEach(() => {
  mockSupabaseFrom.mockReset();
});

describe("fetchAuthorNames", () => {
  it("prefers full_name", async () => {
    mockProfiles({
      data: [{ user_id: "u1", full_name: "Maria Papadopoulou", email: "maria@school.gr" }],
      error: null,
    });
    await expect(fetchAuthorNames(["u1"])).resolves.toEqual({
      u1: "Maria Papadopoulou",
    });
  });

  it("falls back to email when full_name is null, empty, or whitespace", async () => {
    mockProfiles({
      data: [
        { user_id: "u1", full_name: null, email: "null-name@school.gr" },
        { user_id: "u2", full_name: "", email: "empty-name@school.gr" },
        { user_id: "u3", full_name: "   ", email: "blank-name@school.gr" },
      ],
      error: null,
    });
    await expect(fetchAuthorNames(["u1", "u2", "u3"])).resolves.toEqual({
      u1: "null-name@school.gr",
      u2: "empty-name@school.gr",
      u3: "blank-name@school.gr",
    });
  });

  it("omits a profile with neither name nor email, leaving the caller's fallback", async () => {
    mockProfiles({
      data: [{ user_id: "u1", full_name: null, email: null }],
      error: null,
    });
    await expect(fetchAuthorNames(["u1"])).resolves.toEqual({});
  });

  it("omits ids RLS did not return — one instructor cannot read another's profile", async () => {
    mockProfiles({
      data: [{ user_id: "mine", full_name: "Me", email: "me@school.gr" }],
      error: null,
    });
    await expect(fetchAuthorNames(["mine", "hidden-by-rls"])).resolves.toEqual({
      mine: "Me",
    });
  });

  it("selects email alongside the name, and de-duplicates / drops empty ids", async () => {
    const captured = mockProfiles({ data: [], error: null });
    await fetchAuthorNames(["u1", "u1", null, undefined, "u2"]);
    expect(captured.selected).toBe("user_id, full_name, email");
    expect(captured.ids).toEqual(["u1", "u2"]);
  });

  it("makes no request when there is nothing to resolve", async () => {
    mockSupabaseFrom.mockImplementation(() => {
      throw new Error("should not query");
    });
    await expect(fetchAuthorNames([null, undefined])).resolves.toEqual({});
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });

  it("returns an empty map instead of throwing when the query errors", async () => {
    mockProfiles({ data: null, error: { message: "permission denied" } });
    await expect(fetchAuthorNames(["u1"])).resolves.toEqual({});
  });
});
