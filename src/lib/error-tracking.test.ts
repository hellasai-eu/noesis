// The reporter's compliance contract (see the module header): DSN-gated off
// by default, and the payload contains nothing beyond error name, message,
// stack, and a query-stripped path. These tests pin both halves.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildEnvelope, buildEvent, initErrorTracking, parseDsn } from "./error-tracking";

describe("parseDsn", () => {
  it("parses a standard DSN into envelope URL + key", () => {
    const target = parseDsn("https://abc123@o450.ingest.sentry.io/42");
    expect(target).not.toBeNull();
    expect(target!.publicKey).toBe("abc123");
    expect(target!.envelopeUrl).toContain("https://o450.ingest.sentry.io/api/42/envelope/");
    expect(target!.envelopeUrl).toContain("sentry_key=abc123");
  });

  it("keeps a path prefix (self-hosted GlitchTip behind a subpath)", () => {
    const target = parseDsn("https://key@glitchtip.example.org/hosted/7");
    expect(target!.envelopeUrl).toContain("https://glitchtip.example.org/hosted/api/7/envelope/");
  });

  it("rejects malformed DSNs", () => {
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn("http://key@host.example/42")).toBeNull(); // cleartext
    expect(parseDsn("https://host.example/42")).toBeNull(); // no key
    expect(parseDsn("https://key@host.example/")).toBeNull(); // no project id
    expect(parseDsn("https://key@host.example/project")).toBeNull(); // non-numeric id
  });
});

describe("buildEvent", () => {
  it("carries only the documented fields", () => {
    const err = new Error("boom");
    const event = buildEvent(err, "/app/courses/123");
    expect(Object.keys(event).sort()).toEqual(
      ["environment", "event_id", "exception", "extra", "level", "platform", "tags", "timestamp"],
    );
    const exception = event.exception as { values: Array<{ type: string; value: string }> };
    expect(exception.values[0]).toEqual({ type: "Error", value: "boom" });
    expect(event.tags).toEqual({ url_path: "/app/courses/123" });
    // The privacy bound: no user, no request, no breadcrumbs.
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("breadcrumbs");
  });

  it("truncates oversized messages and stacks", () => {
    const err = { name: "Error", message: "x".repeat(1000), stack: "y".repeat(10000) };
    const event = buildEvent(err, "/");
    const exception = event.exception as { values: Array<{ value: string }> };
    expect(exception.values[0].value).toHaveLength(500);
    expect((event.extra as { stack: string }).stack).toHaveLength(4000);
  });
});

describe("buildEnvelope", () => {
  it("emits header, item header and event as three JSON lines", () => {
    const event = buildEvent(new Error("boom"), "/");
    const lines = buildEnvelope(event).split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).event_id).toBe(event.event_id);
    expect(JSON.parse(lines[1])).toEqual({ type: "event" });
    expect(JSON.parse(lines[2]).level).toBe("error");
  });
});

describe("initErrorTracking", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without a DSN", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    initErrorTracking(undefined);
    expect(addListener).not.toHaveBeenCalled();
    addListener.mockRestore();
  });

  it("reports an uncaught error once and dedupes repeats", () => {
    initErrorTracking("https://key@errors.example.org/1");
    const boom = new Error("same failure");
    window.dispatchEvent(new ErrorEvent("error", { error: boom, message: boom.message }));
    window.dispatchEvent(new ErrorEvent("error", { error: boom, message: boom.message }));

    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/1/envelope/");
    expect(options.keepalive).toBe(true);
    expect(options.body).toContain("same failure");
  });
});
