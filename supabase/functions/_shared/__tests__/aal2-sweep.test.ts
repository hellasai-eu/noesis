/**
 * The aal2 sweep (#1440): every privileged handler must refuse an
 * MFA-enrolled caller whose token is still aal1, because the service-role
 * client bypasses the RLS `mfa_enforced` policies (migration
 * 20260914150000_enforce_aal2_rls.sql).
 *
 * Covered here:
 *  - the two shared caller-resolution chokepoints directly
 *    (`requireCaller`, `callerFromRequest`)
 *  - one handler per enforcement family: requireCaller consumer
 *    (convert-md-to-pdf), callerFromRequest consumer
 *    (check-question-similarity), hand-rolled resolver (cancel-job), and
 *    the chat turn (chat).
 *
 * The passing cases matter as much as the refusals: an UNENROLLED caller at
 * aal1 must keep working (MFA is opt-in — enforcement for them is the
 * enrollment mandate, not this check), and an enrolled caller at aal2 must
 * pass. Existing handler tests use factor-less callers throughout, so they
 * double as regression cover for the unenrolled path.
 */

import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createTestHarness,
  DEFAULT_ENV,
  parseResponse,
} from "./handler-harness.ts";
import type { MockRoute } from "./handler-harness.ts";
import { requireCaller } from "../require-caller.ts";
import { callerFromRequest } from "../course-authz.ts";
import { AAL2_REQUIRED_CODE } from "../require-aal2.ts";
import { handler as convertMdHandler } from "../../convert-md-to-pdf/handler.ts";
import { handler as similarityHandler } from "../../check-question-similarity/handler.ts";
import { handler as cancelJobHandler } from "../../cancel-job/handler.ts";
import { handler as chatHandler } from "../../chat/handler.ts";

const CALLER_ID = "11111111-1111-1111-1111-111111111111";
const VERIFIED_TOTP = [{ factor_type: "totp", status: "verified" }];

/** Access token whose payload carries the given aal claim. The signature is
 * fake: the gates decode the SAME token getUser validated, and getUser is
 * mocked here, so only the payload matters. */
function bearerWithAal(aal: string): string {
  const payload = btoa(JSON.stringify({ aal }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `Bearer eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

/** GoTrue's `/auth/v1/user` — what `auth.getUser(token)` resolves. */
function authUserRoute(factors: unknown[]): MockRoute {
  return {
    match: (url: string) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(
        JSON.stringify({ id: CALLER_ID, email: "caller@test.local", factors }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

function request(aal: string): Request {
  return new Request("http://localhost/functions/v1/test", {
    method: "POST",
    headers: { Authorization: bearerWithAal(aal) },
  });
}

// ── requireCaller chokepoint ───────────────────────────────────────────

Deno.test("requireCaller: refuses an enrolled caller at aal1", async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const result = await requireCaller(request("aal1"));
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.status, 403);
      assertEquals(result.code, AAL2_REQUIRED_CODE);
    }
  } finally {
    h.cleanup();
  }
});

Deno.test("requireCaller: passes an enrolled caller at aal2", async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const result = await requireCaller(request("aal2"));
    assertEquals(result.ok, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("requireCaller: passes an unenrolled caller at aal1", async () => {
  const h = createTestHarness({ routes: [authUserRoute([])] });
  try {
    const result = await requireCaller(request("aal1"));
    assertEquals(result.ok, true);
  } finally {
    h.cleanup();
  }
});

// ── callerFromRequest chokepoint ───────────────────────────────────────

function adminClient() {
  return createClient(
    DEFAULT_ENV.SUPABASE_URL,
    DEFAULT_ENV.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

Deno.test("callerFromRequest: refuses an enrolled caller at aal1", async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const result = await callerFromRequest(request("aal1"), adminClient());
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.status, 403);
      assertEquals(result.code, AAL2_REQUIRED_CODE);
    }
  } finally {
    h.cleanup();
  }
});

Deno.test("callerFromRequest: passes an enrolled caller at aal2", async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const result = await callerFromRequest(request("aal2"), adminClient());
    assertEquals(result.ok, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("callerFromRequest: passes an unenrolled caller at aal1", async () => {
  const h = createTestHarness({ routes: [authUserRoute([])] });
  try {
    const result = await callerFromRequest(request("aal1"), adminClient());
    assertEquals(result.ok, true);
  } finally {
    h.cleanup();
  }
});

// ── One handler per enforcement family ─────────────────────────────────

const AAL1_AUTH = { Authorization: bearerWithAal("aal1") };

// These two handlers build their own Supabase client, whose refresh timer
// outlives the request — the same reason the other job/chat suites opt out.
const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test("convert-md-to-pdf (requireCaller family): 403 for enrolled aal1 caller", async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const res = await h.invoke(convertMdHandler, { markdown: "# Hello" }, {
      headers: AAL1_AUTH,
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.code, AAL2_REQUIRED_CODE);
  } finally {
    h.cleanup();
  }
});

Deno.test("check-question-similarity (callerFromRequest family): 403 for enrolled aal1 caller", async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const res = await h.invoke(similarityHandler, { courseId: "c1" }, {
      headers: AAL1_AUTH,
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.code, AAL2_REQUIRED_CODE);
  } finally {
    h.cleanup();
  }
});

Deno.test("cancel-job (hand-rolled family): 403 for enrolled aal1 caller", OPTS, async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const res = await h.invoke(cancelJobHandler, { jobId: "j1" }, {
      headers: AAL1_AUTH,
    });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.code, AAL2_REQUIRED_CODE);
  } finally {
    h.cleanup();
  }
});

Deno.test("chat (chat-turn family): 403 for enrolled aal1 caller", OPTS, async () => {
  const h = createTestHarness({ routes: [authUserRoute(VERIFIED_TOTP)] });
  try {
    const res = await h.invoke(chatHandler, {
      kind: "open_question",
      subjectId: "q1",
    }, { headers: AAL1_AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.code, AAL2_REQUIRED_CODE);
  } finally {
    h.cleanup();
  }
});
