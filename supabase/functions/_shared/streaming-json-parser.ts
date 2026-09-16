/**
 * Incremental JSON text field extractor for streaming structured output.
 *
 * When the OpenAI Responses API streams structured JSON, the output arrives
 * character-by-character. This class detects when we are inside a target
 * string field (e.g. "assistant_text_draft") and emits its characters so
 * they can be forwarded to the client in real time.
 *
 * Usage:
 *   const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
 *   for (const chunk of sseChunks) {
 *     const text = extractor.feed(chunk);
 *     if (text) sendToClient(text);
 *   }
 *   const fullJson = extractor.getFullJson();
 */

const enum State {
  SCANNING,   // Looking for the target key
  FOUND_KEY,  // Found the key, looking for `:` then opening `"`
  IN_VALUE,   // Inside the string value — emit characters
  DONE,       // Finished extracting the target field
}

export class StreamingJsonTextExtractor {
  private state = State.SCANNING as State;
  private buf = "";           // Full JSON accumulator
  private keyBuf = "";        // Buffer for matching the target key pattern
  private readonly keyPattern: string; // `"field_name"` including quotes
  private escape = false;     // Next char is escaped
  private unicodeLeft = 0;    // Remaining hex digits for \uXXXX
  private unicodeBuf = "";    // Accumulated hex digits

  constructor(private readonly targetField: string) {
    this.keyPattern = `"${targetField}"`;
  }

  /**
   * Feed a chunk of JSON characters.
   * Returns any extracted text from the target field (empty string if none).
   */
  feed(chars: string): string {
    this.buf += chars;

    if (this.state === State.DONE) return "";

    let extracted = "";

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];

      switch (this.state) {
        case State.SCANNING:
          // Build up a sliding window to match the key pattern
          this.keyBuf += ch;
          // Only keep the tail as long as the pattern
          if (this.keyBuf.length > this.keyPattern.length) {
            this.keyBuf = this.keyBuf.slice(this.keyBuf.length - this.keyPattern.length);
          }
          if (this.keyBuf === this.keyPattern) {
            this.state = State.FOUND_KEY;
            this.keyBuf = "";
          }
          break;

        case State.FOUND_KEY:
          // Skip whitespace and colon, wait for opening quote
          if (ch === '"') {
            this.state = State.IN_VALUE;
          }
          // Ignore `:`, spaces, etc.
          break;

        case State.IN_VALUE:
          if (this.unicodeLeft > 0) {
            this.unicodeBuf += ch;
            this.unicodeLeft--;
            if (this.unicodeLeft === 0) {
              const codePoint = parseInt(this.unicodeBuf, 16);
              extracted += String.fromCharCode(codePoint);
              this.unicodeBuf = "";
            }
            break;
          }

          if (this.escape) {
            this.escape = false;
            switch (ch) {
              case '"':  extracted += '"'; break;
              case '\\': extracted += '\\'; break;
              case '/':  extracted += '/'; break;
              case 'n':  extracted += '\n'; break;
              case 'r':  extracted += '\r'; break;
              case 't':  extracted += '\t'; break;
              case 'b':  extracted += '\b'; break;
              case 'f':  extracted += '\f'; break;
              case 'u':
                this.unicodeLeft = 4;
                this.unicodeBuf = "";
                break;
              default:
                extracted += ch;
            }
            break;
          }

          if (ch === '\\') {
            this.escape = true;
            break;
          }

          if (ch === '"') {
            // End of string value
            this.state = State.DONE;
            break;
          }

          extracted += ch;
          break;

        case State.DONE:
          // Nothing to do — remaining characters are buffered in this.buf
          break;
      }
    }

    return extracted;
  }

  /** Get the full accumulated JSON string. */
  getFullJson(): string {
    return this.buf;
  }

  /** Whether the target field has been fully extracted. */
  isFieldComplete(): boolean {
    return this.state === State.DONE;
  }
}
