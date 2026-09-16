/**
 * useInstitutionConfig — out-of-order response handling.
 *
 * The race here is the one greptile flagged on #1197: switching institutions
 * fires overlapping requests, and if the *older* one resolves last it would
 * overwrite the newer institution's config. `LocaleProvider` reads
 * `default_language` from this hook, so a stale win puts the whole UI back into
 * the previous institution's language.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useInstitutionConfig } from "@/hooks/useInstitutionConfig";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

/** Rows keyed by institution id, plus a deferred resolver per id. */
const ROWS: Record<string, { default_language: string }> = {
  "inst-greek": { default_language: "el" },
  "inst-english": { default_language: "en" },
};

let pending: Record<string, (value: unknown) => void>;

function mockSupabase() {
  vi.mocked(supabase.from).mockImplementation(
    () =>
      ({
        select: () => ({
          eq: (_col: string, id: string) => ({
            single: () =>
              new Promise((resolve) => {
                pending[id] = resolve;
              }),
          }),
        }),
      }) as unknown as ReturnType<typeof supabase.from>
  );
}

/** Resolve the in-flight request for `id` with its row. */
function settle(id: string) {
  pending[id]?.({
    data: {
      institution_type: "generic",
      school_levels: [],
      academic_period: null,
      ...ROWS[id],
    },
    error: null,
  });
}

describe("useInstitutionConfig", () => {
  beforeEach(() => {
    pending = {};
    // The `from` spy is module-level, so call counts leak between tests without
    // this — the "no institution selected" assertion is a call-count assertion.
    vi.clearAllMocks();
    mockSupabase();
  });

  it("reports the institution's default language", async () => {
    const { result } = renderHook(() => useInstitutionConfig("inst-greek"));
    settle("inst-greek");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.defaultLanguage).toBe("el");
  });

  it("ignores a superseded response that resolves last", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useInstitutionConfig(id),
      { initialProps: { id: "inst-greek" } }
    );

    // Switch before the first request comes back — both are now in flight.
    rerender({ id: "inst-english" });

    // The NEW institution answers first, then the stale one arrives late.
    settle("inst-english");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.defaultLanguage).toBe("en");

    // Flush the stale continuation and React's resulting update *before*
    // asserting. A `waitFor` here would be useless: the value is already "en",
    // so it would pass on its first tick and never observe the late overwrite.
    await act(async () => {
      settle("inst-greek");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Without the cancellation guard the late Greek response wins here and the
    // UI silently reverts to the institution the user just navigated away from.
    expect(result.current.defaultLanguage).toBe("en");
  });

  it("stays idle and not loading with no institution selected", async () => {
    const { result } = renderHook(() => useInstitutionConfig(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
