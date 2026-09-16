import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { adminMfaMandateActive, callerIsAal2, callerMfaSatisfied } from "../require-aal2.ts";

function tokenWithPayload(payload: unknown): string {
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
}

const verified = { factors: [{ factor_type: "totp", status: "verified" }] };

Deno.test("require-aal2: unenrolled caller passes regardless of aal", () => {
  assertEquals(callerMfaSatisfied({}, tokenWithPayload({ aal: "aal1" })), true);
  assertEquals(callerMfaSatisfied({ factors: [] }, "not-a-jwt"), true);
  assertEquals(callerMfaSatisfied({ factors: null }, tokenWithPayload({})), true);
});

Deno.test("require-aal2: only-unverified factors pass at aal1", () => {
  const user = { factors: [{ factor_type: "totp", status: "unverified" }] };
  assertEquals(callerMfaSatisfied(user, tokenWithPayload({ aal: "aal1" })), true);
});

Deno.test("require-aal2: enrolled caller needs aal2", () => {
  assertEquals(callerMfaSatisfied(verified, tokenWithPayload({ aal: "aal2" })), true);
  assertEquals(callerMfaSatisfied(verified, tokenWithPayload({ aal: "aal1" })), false);
});

Deno.test("require-aal2: enrolled caller fails closed on a missing or unreadable aal", () => {
  assertEquals(callerMfaSatisfied(verified, tokenWithPayload({})), false);
  assertEquals(callerMfaSatisfied(verified, tokenWithPayload({ aal: 2 })), false);
  assertEquals(callerMfaSatisfied(verified, "not-a-jwt"), false);
  assertEquals(callerMfaSatisfied(verified, ""), false);
});

Deno.test("require-aal2: callerIsAal2 accepts only a readable aal2 claim", () => {
  assertEquals(callerIsAal2(tokenWithPayload({ aal: "aal2" })), true);
  assertEquals(callerIsAal2(tokenWithPayload({ aal: "aal1" })), false);
  assertEquals(callerIsAal2(tokenWithPayload({})), false);
  assertEquals(callerIsAal2("not-a-jwt"), false);
});

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

function settingsStub(result: { data: { value: unknown } | null; error: unknown }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(result),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

Deno.test("require-aal2: mandate active once the deadline has passed, not before", async () => {
  assertEquals(
    await adminMfaMandateActive(settingsStub({ data: { value: "2020-01-01T00:00:00Z" }, error: null })),
    true,
  );
  assertEquals(
    await adminMfaMandateActive(settingsStub({ data: { value: "2099-01-01T00:00:00Z" }, error: null })),
    false,
  );
});

Deno.test("require-aal2: mandate fails closed on a missing or unreadable deadline row", async () => {
  assertEquals(await adminMfaMandateActive(settingsStub({ data: null, error: null })), true);
  assertEquals(
    await adminMfaMandateActive(settingsStub({ data: null, error: { message: "boom" } })),
    true,
  );
  assertEquals(
    await adminMfaMandateActive(settingsStub({ data: { value: "not-a-date" }, error: null })),
    true,
  );
});
