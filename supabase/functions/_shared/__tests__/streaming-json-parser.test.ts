import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { StreamingJsonTextExtractor } from "../streaming-json-parser.ts";

Deno.test("extracts target field from complete JSON", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const json = '{"assistant_text_draft":"Hello world!","other":"value"}';
  const text = extractor.feed(json);
  assertEquals(text, "Hello world!");
  assertEquals(extractor.isFieldComplete(), true);
});

Deno.test("extracts field from character-by-character streaming", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const json = '{"assistant_text_draft":"Hi there","response_class":"ON_TRACK"}';
  let extracted = "";
  for (const ch of json) {
    extracted += extractor.feed(ch);
  }
  assertEquals(extracted, "Hi there");
  assertEquals(extractor.isFieldComplete(), true);
});

Deno.test("handles JSON escape sequences", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const json = '{"assistant_text_draft":"line1\\nline2\\t\\"quoted\\"\\\\backslash"}';
  const text = extractor.feed(json);
  assertEquals(text, 'line1\nline2\t"quoted"\\backslash');
});

Deno.test("handles unicode escapes", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const json = '{"assistant_text_draft":"\\u0048\\u0065\\u006C\\u006C\\u006F"}';
  const text = extractor.feed(json);
  assertEquals(text, "Hello");
});

Deno.test("handles multi-chunk streaming", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const chunks = [
    '{"assistan',
    't_text_draft',
    '":"Hello ',
    'wor',
    'ld!","resp',
    'onse_class":"ON_TRACK"}',
  ];
  let extracted = "";
  for (const chunk of chunks) {
    extracted += extractor.feed(chunk);
  }
  assertEquals(extracted, "Hello world!");
});

Deno.test("returns empty for unrelated content after field", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const text1 = extractor.feed('{"assistant_text_draft":"done"');
  assertEquals(text1, "done");
  assertEquals(extractor.isFieldComplete(), true);
  const text2 = extractor.feed(',"other":"should not extract"}');
  assertEquals(text2, "");
});

Deno.test("accumulates full JSON", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  extractor.feed('{"assista');
  extractor.feed('nt_text_draft":"hi"}');
  assertEquals(extractor.getFullJson(), '{"assistant_text_draft":"hi"}');
});

Deno.test("handles empty string value", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const text = extractor.feed('{"assistant_text_draft":"","other":"val"}');
  assertEquals(text, "");
  assertEquals(extractor.isFieldComplete(), true);
});

Deno.test("handles LaTeX math content", () => {
  const extractor = new StreamingJsonTextExtractor("assistant_text_draft");
  const json = '{"assistant_text_draft":"The formula is $x^2 + y^2 = r^2$. What is $r$?"}';
  const text = extractor.feed(json);
  assertEquals(text, "The formula is $x^2 + y^2 = r^2$. What is $r$?");
});
