// The edge reporter's compliance contract (see _shared/error-tracking.ts):
// DSN-gated off by default, payload limited to error name/message/stack plus
// function name, trace id and status. These tests pin the DSN parsing, the
// payload bound, and the no-DSN/never-throws behaviour.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildEnvelope,
  buildEvent,
  parseDsn,
  reportException,
} from "../error-tracking.ts";

Deno.test("parseDsn: standard DSN becomes envelope URL + key", () => {
  const target = parseDsn("https://abc123@o450.ingest.sentry.io/42");
  assert(target !== null);
  assertEquals(target.publicKey, "abc123");
  assertEquals(
    target.envelopeUrl,
    "https://o450.ingest.sentry.io/api/42/envelope/",
  );
});

Deno.test("parseDsn: path prefix survives (self-hosted behind a subpath)", () => {
  const target = parseDsn("https://key@glitchtip.example.org/hosted/7");
  assert(target !== null);
  assertEquals(
    target.envelopeUrl,
    "https://glitchtip.example.org/hosted/api/7/envelope/",
  );
});

Deno.test("parseDsn: malformed DSNs are rejected", () => {
  assertEquals(parseDsn("not a url"), null);
  assertEquals(parseDsn("http://key@host.example/42"), null); // cleartext
  assertEquals(parseDsn("https://host.example/42"), null); // no key
  assertEquals(parseDsn("https://key@host.example/"), null); // no project id
  assertEquals(parseDsn("https://key@host.example/project"), null); // non-numeric
});

Deno.test("buildEvent: carries only the documented fields", () => {
  const event = buildEvent(new Error("boom"), {
    functionName: "chat-turn",
    traceId: "trace-1",
    status: 500,
  });
  assertEquals(
    Object.keys(event).sort(),
    ["environment", "event_id", "exception", "extra", "level", "logger", "platform", "tags", "timestamp"],
  );
  const exception = event.exception as { values: Array<{ type: string; value: string }> };
  assertEquals(exception.values[0], { type: "Error", value: "boom" });
  assertEquals(event.tags, {
    function: "chat-turn",
    trace_id: "trace-1",
    status: "500",
  });
  // The privacy bound: no user, no request payloads.
  assert(!("user" in event));
  assert(!("request" in event));
});

Deno.test("buildEvent: truncates oversized messages and stacks", () => {
  const event = buildEvent(
    { name: "Error", message: "x".repeat(1000), stack: "y".repeat(10000) },
    { functionName: "f" },
  );
  const exception = event.exception as { values: Array<{ value: string }> };
  assertEquals(exception.values[0].value.length, 500);
  assertEquals((event.extra as { stack: string }).stack.length, 4000);
});

Deno.test("buildEnvelope: header, item header and event as three JSON lines", () => {
  const event = buildEvent(new Error("boom"), { functionName: "f" });
  const lines = buildEnvelope(event).split("\n");
  assertEquals(lines.length, 3);
  assertEquals(JSON.parse(lines[0]).event_id, event.event_id);
  assertEquals(JSON.parse(lines[1]), { type: "event" });
  assertEquals(JSON.parse(lines[2]).level, "error");
});

Deno.test("reportException: no-op without SENTRY_DSN, and never throws", () => {
  const prior = Deno.env.get("SENTRY_DSN");
  try {
    Deno.env.delete("SENTRY_DSN");
    reportException(new Error("boom"), { functionName: "f" });

    // Even a garbage DSN must not throw — reporting is best-effort.
    Deno.env.set("SENTRY_DSN", "::not-a-dsn::");
    reportException(new Error("boom"), { functionName: "f" });
  } finally {
    if (prior === undefined) Deno.env.delete("SENTRY_DSN");
    else Deno.env.set("SENTRY_DSN", prior);
  }
});
