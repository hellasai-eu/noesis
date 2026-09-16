import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  cuesToParagraphs,
  extractYouTubeMetadata,
  parseYouTubeVideoId,
} from "../youtube.ts";

Deno.test("parseYouTubeVideoId: accepts the forms people actually paste", () => {
  const id = "dQw4w9WgXcQ";
  const accepted = [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc123`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `www.youtube.com/watch?v=${id}`,
    `  https://www.youtube.com/watch?v=${id}  `,
    // The wrapper YouTube's own share affordances still emit: the real watch
    // URL lives percent-encoded in `u`.
    `https://www.youtube.com/attribution_link?a=abc&u=%2Fwatch%3Fv%3D${id}%26feature%3Dshare`,
    `https://www.youtube.com/attribution_link?u=%2Fshorts%2F${id}`,
  ];

  for (const url of accepted) {
    assertEquals(parseYouTubeVideoId(url), id, `should have accepted ${url}`);
  }
});

Deno.test("parseYouTubeVideoId: an attribution_link cannot smuggle another host", () => {
  const id = "dQw4w9WgXcQ";
  const rejected = [
    // No `u` to unwrap.
    "https://www.youtube.com/attribution_link?a=abc",
    // `u` names another host outright. It is resolved against youtube.com's
    // own origin, so an absolute `u` stays on ITS host and fails the
    // allow-list rather than borrowing YouTube's identity.
    `https://www.youtube.com/attribution_link?u=https%3A%2F%2Fevil.example%2Fwatch%3Fv%3D${id}`,
    `https://www.youtube.com/attribution_link?u=%2F%2Fevil.example%2Fwatch%3Fv%3D${id}`,
    // A wrapper inside a wrapper is a redirect chain, not a URL to parse.
    `https://www.youtube.com/attribution_link?u=%2Fattribution_link%3Fu%3D%252Fwatch%253Fv%253D${id}`,
    // Unwraps to something real, but not to a video.
    "https://www.youtube.com/attribution_link?u=%2Fplaylist%3Flist%3DPL123",
  ];

  for (const url of rejected) {
    assertEquals(parseYouTubeVideoId(url), null, `should have rejected ${url}`);
  }
});

Deno.test("parseYouTubeVideoId: rejects anything that is not a YouTube video", () => {
  const rejected = [
    "",
    "not a url",
    "https://vimeo.com/123456789",
    // The reason the host is matched in full rather than with includes().
    "https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=tooshort",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/playlist?list=PL1234567890",
    "javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ",
  ];

  for (const url of rejected) {
    assertEquals(parseYouTubeVideoId(url), null, `should have rejected ${url}`);
  }
});

Deno.test("cuesToParagraphs: joins cues and breaks on sentence ends", () => {
  const cues = ["hello  there", "", "  world.  "];
  assertEquals(cuesToParagraphs(cues), "hello there world.");

  const long = Array.from({ length: 40 }, () => "a sentence of some length.");
  const paragraphs = cuesToParagraphs(long, 100).split("\n\n");
  assertEquals(paragraphs.length > 1, true);
  for (const paragraph of paragraphs) {
    assertEquals(paragraph.includes("\n"), false);
  }
});

Deno.test("extractYouTubeMetadata: reads Supadata's nested shape", () => {
  assertEquals(
    extractYouTubeMetadata({
      title: "A lecture",
      author: { displayName: "A channel", username: "@achannel" },
      media: { duration: 610.4 },
      stats: { views: 12 },
    }),
    { title: "A lecture", author: "A channel", durationSeconds: 610 },
  );
});

Deno.test("extractYouTubeMetadata: accepts the flatter spellings another provider might use", () => {
  assertEquals(
    extractYouTubeMetadata({ name: "A lecture", channel: "A channel", lengthSeconds: "610" }),
    { title: "A lecture", author: "A channel", durationSeconds: 610 },
  );
});

Deno.test("extractYouTubeMetadata: yields nulls rather than guesses", () => {
  const empty = { title: null, author: null, durationSeconds: null };

  // A transcript with no title is still worth importing, so every one of these
  // has to degrade to "unknown" rather than throw.
  assertEquals(extractYouTubeMetadata(null), empty);
  assertEquals(extractYouTubeMetadata("not an object"), empty);
  assertEquals(extractYouTubeMetadata({}), empty);
  assertEquals(extractYouTubeMetadata({ title: "   ", media: { duration: 0 } }), empty);
  assertEquals(
    extractYouTubeMetadata({ media: { duration: "not a number" } }).durationSeconds,
    null,
  );
});
