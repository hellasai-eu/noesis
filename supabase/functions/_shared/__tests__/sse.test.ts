import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  drainSSEBlocks,
  normalizeSSENewlines,
  parseSSEFrame,
} from "../sse.ts";

/** Convenience: run a whole stream body through the framing the handler uses. */
function framesOf(body: string): string[] {
  const { blocks, rest } = drainSSEBlocks(normalizeSSENewlines(body));
  return [...blocks, rest]
    .map(parseSSEFrame)
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => f.type);
}

Deno.test("sse: LF-framed stream yields every frame", () => {
  const body =
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';

  assertEquals(framesOf(body), [
    "response.output_text.delta",
    "response.completed",
  ]);
});

Deno.test("sse: CRLF-framed stream yields the same frames", () => {
  // The regression behind #1039: `\r\n\r\n` contains no `\n\n`, so scanning for
  // `\n\n` found no boundary and the whole stream stayed buffered — no output
  // text, and no response.completed either.
  const body =
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"a"}\r\n\r\n' +
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';

  assertEquals(framesOf(body), [
    "response.output_text.delta",
    "response.completed",
  ]);
});

Deno.test("sse: a final frame with no trailing blank line is not dropped", () => {
  const body =
    'data: {"type":"response.output_text.delta","delta":"a"}\n\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}';

  assertEquals(framesOf(body), [
    "response.output_text.delta",
    "response.completed",
  ]);
});

Deno.test("sse: event name is taken from the event: line when the payload has no type", () => {
  // Error frames in particular name themselves this way; reading only the
  // payload's `type` discarded them, which is why a failed turn logged nothing.
  const frame = parseSSEFrame('event: error\ndata: {"message":"upstream exploded"}');

  assertEquals(frame?.type, "error");
  assertEquals(frame?.data?.message, "upstream exploded");
});

Deno.test("sse: payload type wins over the event: line", () => {
  const frame = parseSSEFrame(
    'event: message\ndata: {"type":"response.completed","response":{}}',
  );

  assertEquals(frame?.type, "response.completed");
});

Deno.test("sse: data: without the optional space still parses", () => {
  const frame = parseSSEFrame('data:{"type":"response.completed"}');

  assertEquals(frame?.type, "response.completed");
});

Deno.test("sse: [DONE] and blank blocks do not masquerade as events", () => {
  assertEquals(parseSSEFrame("data: [DONE]")?.data, null);
  assertEquals(parseSSEFrame("   "), null);
  assertEquals(parseSSEFrame(""), null);
});

Deno.test("sse: unparseable data is surfaced, not silently dropped", () => {
  const frame = parseSSEFrame("event: response.failed\ndata: {not json");

  assertEquals(frame?.type, "response.failed");
  assertEquals(frame?.data, null);
});

Deno.test("sse: a frame split across chunk boundaries is held until complete", () => {
  const first = drainSSEBlocks('data: {"type":"response.out');
  assertEquals(first.blocks.length, 0);

  const second = drainSSEBlocks(first.rest + 'put_text.delta","delta":"a"}\n\n');
  assertEquals(second.blocks.length, 1);
  assertEquals(parseSSEFrame(second.blocks[0])?.type, "response.output_text.delta");
});


/** Feeds a body through the reader loop in fixed-size reads, as the handler does. */
function framesOfChunked(body: string, chunkSize: number): string[] {
  let buffer = "";
  const types: string[] = [];
  for (let i = 0; i < body.length; i += chunkSize) {
    // Exactly the handler's order: append raw, then normalise the buffer.
    buffer = normalizeSSENewlines(buffer + body.slice(i, i + chunkSize));
    const { blocks, rest } = drainSSEBlocks(buffer);
    for (const b of blocks) {
      const f = parseSSEFrame(b);
      if (f) types.push(f.type);
    }
    buffer = rest;
  }
  const last = parseSSEFrame(buffer);
  if (last) types.push(last.type);
  return types;
}

Deno.test("sse: CRLF boundary split across reads still frames correctly", () => {
  // Normalising each chunk instead of the buffer leaves `\n\r\n` at the join —
  // no `\n\n`, so the boundary is missed and two frames merge into one, losing
  // the earlier delta entirely.
  const body =
    'data: {"type":"response.output_text.delta","delta":"a"}\r\n\r\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n';

  // Every possible split point must behave identically.
  for (let size = 1; size <= body.length; size++) {
    assertEquals(
      framesOfChunked(body, size),
      ["response.output_text.delta", "response.completed"],
      `split every ${size} chars`,
    );
  }
});

Deno.test("sse: multiple data: lines in one frame are joined, not truncated", () => {
  const frame = parseSSEFrame('event: response.completed\ndata: {"type":"x",\ndata: "response":{}}');

  assertEquals(frame?.type, "x");
});

Deno.test("sse: normalizeSSENewlines is idempotent", () => {
  const once = normalizeSSENewlines("a\r\n\r\nb");
  assertEquals(normalizeSSENewlines(once), once);
  assertEquals(once, "a\n\nb");
});
