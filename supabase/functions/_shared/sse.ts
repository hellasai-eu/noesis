/**
 * Server-sent-event framing helpers for the streaming LLM handlers.
 *
 * Extracted from study-tutor so the framing rules can be tested. They were
 * previously inlined in a ReadableStream, where two spec details went
 * unhandled and a turn that hit either produced no output and no diagnosis
 * (#1039):
 *
 *  - Frames are separated by a BLANK LINE. Under CRLF that separator is
 *    `\r\n\r\n`, which contains no `\n\n`, so scanning for `\n\n` finds no
 *    boundary at all and every frame stays buffered forever.
 *  - The event name lives on the `event:` line. Reading only the JSON payload's
 *    `type` field discards every frame that names itself the SSE way.
 */

export interface SSEFrame {
  /** Event name: the payload's `type` if present, else the `event:` line. */
  type: string;
  /** Parsed `data:` payload, or null when absent, `[DONE]`, or unparseable. */
  data: Record<string, unknown> | null;
}

/**
 * Normalises line endings so blank-line framing can be found.
 *
 * Apply to the WHOLE BUFFER after appending a chunk, never to the chunk alone.
 * A read can split `\r\n\r\n` anywhere, including after the second `\r`:
 * normalising that chunk on its own yields a trailing `\r`, the next chunk
 * supplies the `\n`, and the join is `\n\r\n` — which holds no `\n\n`, so the
 * boundary is missed and two frames silently merge. Normalising the buffer
 * lets the halves reunite first. It is idempotent, so re-running it over the
 * retained tail each iteration is safe.
 */
export function normalizeSSENewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * Splits whatever complete frames are in `buffer`.
 * Returns the frames plus the trailing remainder, which the caller keeps until
 * more bytes arrive — and must flush once the stream ends, since a final frame
 * need not be followed by a blank line.
 */
export function drainSSEBlocks(buffer: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = buffer;
  let boundary: number;
  while ((boundary = rest.indexOf("\n\n")) !== -1) {
    blocks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
  }
  return { blocks, rest };
}

/** Parses one frame. Returns null for blank blocks. */
export function parseSSEFrame(block: string): SSEFrame | null {
  if (!block.trim()) return null;

  let eventName = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      // Per the spec a frame may carry several `data:` lines, joined by \n —
      // keeping only the last would quietly truncate a multi-line payload.
      // The single space after the colon is optional.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  const trimmed = dataLines.join("\n").trim();
  if (!trimmed || trimmed === "[DONE]") {
    return { type: eventName || "[DONE]", data: null };
  }

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    return { type: (data.type as string) || eventName, data };
  } catch {
    return { type: eventName || "<unparseable-data>", data: null };
  }
}
