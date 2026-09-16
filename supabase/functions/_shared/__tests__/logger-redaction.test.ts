// Guardrail tests for `redactSensitive` in _shared/logger.ts.
//
// `withLogging` logs whole request and response bodies. Before redaction
// existed, `admin-set-user-password` wrote the new password to the Supabase
// edge logs in cleartext (`{ userId, newPassword }`), and `create-user` wrote a
// password plus a frequently under-age student's `dateOfBirth` and
// `fatherName`. These tests pin that behaviour shut.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { redactSensitive, REDACTED } from "../logger.ts";

// The real request bodies, verbatim from the handlers they belong to.
Deno.test("redactSensitive: admin-set-user-password body hides newPassword", () => {
  const body = { userId: "u-1", newPassword: "hunter2-correct-horse" };
  const out = redactSensitive(body) as Record<string, unknown>;

  assertEquals(out.newPassword, REDACTED);
  // The non-secret field is still there — redaction must not gut debuggability.
  assertEquals(out.userId, "u-1");
  assert(!JSON.stringify(out).includes("hunter2"));
});

Deno.test("redactSensitive: create-user body hides password and minor PII", () => {
  const body = {
    email: "student@school.gr",
    password: "s3cr3t-pw",
    fullName: "A Student",
    fatherName: "A Parent",
    dateOfBirth: "2012-04-01",
    institutionId: "inst-1",
    role: "student",
  };
  const out = redactSensitive(body) as Record<string, unknown>;

  assertEquals(out.password, REDACTED);
  assertEquals(out.fatherName, REDACTED);
  assertEquals(out.dateOfBirth, REDACTED);
  // Deliberately retained as correlation keys — see SENSITIVE_KEYS comment.
  assertEquals(out.email, "student@school.gr");
  assertEquals(out.fullName, "A Student");
  assertEquals(out.role, "student");

  const serialized = JSON.stringify(out);
  assert(!serialized.includes("s3cr3t-pw"));
  assert(!serialized.includes("2012-04-01"));
  assert(!serialized.includes("A Parent"));
});

Deno.test("redactSensitive: key matching ignores case and separators", () => {
  const out = redactSensitive({
    newPassword: "a",
    new_password: "b",
    "new-password": "c",
    NEWPASSWORD: "d",
  }) as Record<string, unknown>;

  for (const value of Object.values(out)) assertEquals(value, REDACTED);
});

Deno.test("redactSensitive: composed secret names match by suffix", () => {
  const out = redactSensitive({
    invitation_token: "t",
    openaiApiKey: "k",
    service_role_secret: "s",
    refreshToken: "r",
  }) as Record<string, unknown>;

  for (const value of Object.values(out)) assertEquals(value, REDACTED);
});

// Regression: `sessionId` is a study_sessions / chat-session row id
// on the tutoring surfaces, not an auth credential. Redacting it would
// break tracing a tutoring flow end to end.
Deno.test("redactSensitive: sessionId is NOT redacted", () => {
  const out = redactSensitive({
    sessionId: "sess-abc",
    session_id: "sess-def",
  }) as Record<string, unknown>;

  assertEquals(out.sessionId, "sess-abc");
  assertEquals(out.session_id, "sess-def");
});

// Regression: logAuthFailure records a deliberately masked token for security
// monitoring. It is named `attempted_token_masked` precisely so the `*token`
// suffix rule does not erase it.
Deno.test("redactSensitive: attempted_token_masked survives, attempted_token does not", () => {
  const out = redactSensitive({
    attempted_token_masked: "eyJhbGciOi...aBc12",
    attempted_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.raw",
  }) as Record<string, unknown>;

  assertEquals(out.attempted_token_masked, "eyJhbGciOi...aBc12");
  assertEquals(out.attempted_token, REDACTED);
});

// withLogging nests the body under `request_body`, so redaction has to recurse
// rather than only inspect top-level keys.
Deno.test("redactSensitive: recurses through nested objects and arrays", () => {
  const out = redactSensitive({
    request_body: {
      users: [
        { email: "a@b.gr", password: "p1" },
        { email: "c@d.gr", password: "p2" },
      ],
    },
  });

  const serialized = JSON.stringify(out);
  assert(!serialized.includes("p1"));
  assert(!serialized.includes("p2"));
  assert(serialized.includes("a@b.gr"));
  assertEquals(
    ((out as Record<string, never>).request_body as Record<string, unknown[]>)
      .users[0] as Record<string, unknown>,
    { email: "a@b.gr", password: REDACTED },
  );
});

Deno.test("redactSensitive: leaves primitives and null untouched", () => {
  assertEquals(redactSensitive("plain string"), "plain string");
  assertEquals(redactSensitive(42), 42);
  assertEquals(redactSensitive(null), null);
  assertEquals(redactSensitive(undefined), undefined);
});

Deno.test("redactSensitive: bounds recursion depth", () => {
  // 12 levels deep — past MAX_REDACT_DEPTH (8).
  let deep: Record<string, unknown> = { password: "leaf-secret" };
  for (let i = 0; i < 12; i++) deep = { nested: deep };

  const serialized = JSON.stringify(redactSensitive(deep));
  // The walk stops rather than recursing forever, and the truncated subtree is
  // dropped entirely — so the secret still never reaches the sink.
  assert(serialized.includes("redaction depth exceeded"));
  assert(!serialized.includes("leaf-secret"));
});
