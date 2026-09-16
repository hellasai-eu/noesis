import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { extractProviderContent } from "../import-provider.ts";

/** How the YouTube path joins caption cues; a scrape never needs it. */
const join = (cues: string[]) => cues.join(" ");

Deno.test("extractProviderContent: reads the shapes providers actually return", () => {
  // Supadata's transcript with `text=true`, and its scrape response.
  assertEquals(
    extractProviderContent({ content: "Hello there.", lang: "en" }, join),
    { text: "Hello there.", language: "en", title: null },
  );
  assertEquals(
    extractProviderContent(
      { content: "# Heading\n\nBody.", lang: "el", name: "A page" },
      join,
    ),
    { text: "# Heading\n\nBody.", language: "el", title: "A page" },
  );

  // Supadata's default transcript shape: timed cues.
  assertEquals(
    extractProviderContent({ content: [{ text: "Hello" }, { text: "there." }], lang: "el" }, join),
    { text: "Hello there.", language: "el", title: null },
  );

  // Other spellings, so swapping provider stays a config change.
  assertEquals(extractProviderContent({ transcript: "Hello there." }, join)?.text, "Hello there.");
  assertEquals(extractProviderContent({ markdown: "# Hi" }, join)?.text, "# Hi");
  assertEquals(
    extractProviderContent({ segments: ["Hello", "there."], language: "en" }, join)?.text,
    "Hello there.",
  );
});

Deno.test("extractProviderContent: anything unrecognised is null, never a guess", () => {
  assertEquals(extractProviderContent({ content: "" }, join), null);
  assertEquals(extractProviderContent({ content: "   " }, join), null);
  assertEquals(extractProviderContent({ status: "processing" }, join), null);
  // A queued job is not content — the caller polls instead of treating the
  // envelope as an answer.
  assertEquals(extractProviderContent({ jobId: "job-1" }, join), null);
  assertEquals(extractProviderContent(null, join), null);
  assertEquals(extractProviderContent("a string", join), null);
});

Deno.test("extractProviderContent: markdown structure survives untouched", () => {
  // The scrape path stores what comes back verbatim, so a heading must not be
  // re-wrapped or paragraph-joined on the way through.
  const markdown = "# Title\n\n- one\n- two\n\n## Section\n\nBody text.";
  assertEquals(extractProviderContent({ content: markdown }, join)?.text, markdown);
});
