import { describe, expect, it } from "vitest";
import {
  buildImportedMarkdown,
  escapeMarkdownBlockStarts,
  formatVideoDuration,
  isYouTubeUrl,
  parseYouTubeVideoId,
  importedFileStem,
  importFallbackStem,
  isImportableUrl,
  importKindMismatch,
  normalizeImportUrl,
  seedImportedContent,
} from "@/lib/url-import";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeVideoId", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc123`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    // The wrapper YouTube's own share affordances still emit: the real watch
    // URL lives percent-encoded in `u`.
    `https://www.youtube.com/attribution_link?a=abc&u=%2Fwatch%3Fv%3D${ID}%26feature%3Dshare`,
    `https://www.youtube.com/attribution_link?u=%2Fshorts%2F${ID}`,
  ])("accepts %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBe(ID);
  });

  it.each([
    // No `u` to unwrap.
    "https://www.youtube.com/attribution_link?a=abc",
    // `u` names another host outright — resolving it against youtube.com must
    // not let it borrow YouTube's identity.
    `https://www.youtube.com/attribution_link?u=https%3A%2F%2Fevil.example%2Fwatch%3Fv%3D${ID}`,
    `https://www.youtube.com/attribution_link?u=%2F%2Fevil.example%2Fwatch%3Fv%3D${ID}`,
    // A wrapper inside a wrapper is a redirect chain, not a URL to parse.
    `https://www.youtube.com/attribution_link?u=%2Fattribution_link%3Fu%3D%252Fwatch%253Fv%253D${ID}`,
    // Unwraps to something real, but not to a video.
    "https://www.youtube.com/attribution_link?u=%2Fplaylist%3Flist%3DPL123",
  ])("does not unwrap %s into a video", (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });

  it.each([
    "",
    "not a url",
    "https://vimeo.com/123456789",
    // The host is compared in full, so a look-alike domain is not YouTube.
    `https://youtube.com.attacker.example/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    "https://www.youtube.com/watch?v=tooshort",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/playlist?list=PL1234567890",
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
  ])("rejects %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
    expect(isYouTubeUrl(url)).toBe(false);
  });
});

describe("formatVideoDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatVideoDuration(452)).toBe("7:32");
    expect(formatVideoDuration(3849)).toBe("1:04:09");
  });

  it("returns null for a missing or nonsensical length", () => {
    expect(formatVideoDuration(null)).toBeNull();
    expect(formatVideoDuration(0)).toBeNull();
    expect(formatVideoDuration(Number.NaN)).toBeNull();
  });
});

describe("escapeMarkdownBlockStarts", () => {
  it("escapes only line-leading structure characters", () => {
    expect(escapeMarkdownBlockStarts("# not a heading")).toBe("\\# not a heading");
    expect(escapeMarkdownBlockStarts("- so anyway")).toBe("\\- so anyway");
    expect(escapeMarkdownBlockStarts("1. first")).toBe("\\1. first");
    // Mid-line punctuation is left alone: escaping it mangles ordinary prose.
    expect(escapeMarkdownBlockStarts("a 5 * 3 = 15 rule")).toBe("a 5 * 3 = 15 rule");
  });
});

describe("buildImportedMarkdown", () => {
  it("records where the text came from", () => {
    const markdown = buildImportedMarkdown({
      title: "A lecture",
      sourceUrl: `https://www.youtube.com/watch?v=${ID}`,
      kind: "youtube",
      author: "A channel",
      language: "el",
      content: "Καλημέρα σε όλους.",
    });

    expect(markdown).toContain("# A lecture");
    expect(markdown).toContain(`Source: https://www.youtube.com/watch?v=${ID}`);
    expect(markdown).toContain("Channel: A channel");
    expect(markdown).toContain("Language: el");
    expect(markdown).toContain("Καλημέρα σε όλους.");
  });

  it("omits the provenance lines it has no value for", () => {
    const markdown = buildImportedMarkdown({
      title: "A lecture",
      sourceUrl: `https://www.youtube.com/watch?v=${ID}`,
      kind: "youtube",
      content: "text",
    });

    expect(markdown).not.toContain("Channel:");
    expect(markdown).not.toContain("Language:");
  });

  it("labels a page by its site and leaves its Markdown intact", () => {
    // A scraped page arrives as real Markdown: escaping its block starts would
    // destroy the structure that makes it worth importing.
    const markdown = buildImportedMarkdown({
      title: "The French Revolution",
      sourceUrl: "https://example.test/article",
      kind: "web",
      author: "example.test",
      content: "## Causes\n\n- Debt\n- Famine",
    });

    expect(markdown).toContain("Site: example.test");
    expect(markdown).toContain("## Causes");
    expect(markdown).toContain("- Debt");
    expect(markdown).not.toContain("\\##");
    expect(markdown).not.toContain("\\-");
  });

  it("stores the content verbatim, whatever kind it came from", () => {
    // Escaping moved to `seedImportedContent` so that the editor holds exactly
    // what will be saved. Escaping here as well would rewrite an instructor's
    // own headings into literal text after they had approved them.
    const markdown = buildImportedMarkdown({
      title: "A lecture",
      sourceUrl: `https://www.youtube.com/watch?v=${ID}`,
      kind: "youtube",
      content: "## A heading the instructor added\n- and a list",
    });

    expect(markdown).toContain("## A heading the instructor added");
    expect(markdown).toContain("- and a list");
    expect(markdown).not.toContain("\\#");
    expect(markdown).not.toContain("\\-");
  });
});

describe("seedImportedContent", () => {
  it("escapes a transcript's accidental Markdown", () => {
    // Captions are prose that was never Markdown: a line that happens to start
    // "- so anyway" is a sentence, not a bullet.
    expect(seedImportedContent("youtube", "# 1 thing to know\n- so anyway")).toBe(
      "\\# 1 thing to know\n\\- so anyway",
    );
  });

  it("leaves a scraped page's real Markdown alone", () => {
    const page = "## Causes\n\n- Debt\n- Famine";
    expect(seedImportedContent("web", page)).toBe(page);
  });
});

describe("importedFileStem", () => {
  it("keeps a usable ASCII stem", () => {
    expect(importedFileStem("The French Revolution", `youtube-${ID}`)).toBe(
      `The_French_Revolution-youtube-${ID}`,
    );
  });

  it("falls back when the title has no ASCII left", () => {
    // A Greek title sanitises to underscores only, which would name the object
    // `_______.md` — hence the fallback.
    expect(importedFileStem("Η Γαλλική Επανάσταση", `youtube-${ID}`)).toBe(`youtube-${ID}`);
    expect(importedFileStem("", "example.test")).toBe("example.test");
    expect(importedFileStem("", "")).toBe("import");
  });
});

describe("importFallbackStem", () => {
  it("names a video by its id and a page by its host", () => {
    expect(importFallbackStem(`https://www.youtube.com/watch?v=${ID}`, ID)).toBe(`youtube-${ID}`);
    expect(importFallbackStem("https://www.example.test/a/b")).toBe("example.test");
    expect(importFallbackStem("not a url")).toBe("web-import");
  });
});

describe("isImportableUrl", () => {
  it.each([
    "https://example.com",
    "http://example.com/a?b=c",
    "example.com/article",
    `https://youtu.be/${ID}`,
  ])("accepts %s", (url) => {
    expect(isImportableUrl(url)).toBe(true);
  });

  it.each([
    "",
    "not a url",
    "ftp://example.com",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    // No dot in the host: "localhost" and friends are refused server-side too,
    // but there is no reason to make the round trip.
    "http://localhost:3000",
  ])("rejects %s", (url) => {
    expect(isImportableUrl(url)).toBe(false);
  });
});

describe("normalizeImportUrl", () => {
  it("fills in the scheme a person leaves out", () => {
    expect(normalizeImportUrl(" example.com/a ")).toBe("https://example.com/a");
    expect(normalizeImportUrl("http://example.com")).toBe("http://example.com");
  });
});

describe("importKindMismatch", () => {
  it("accepts each import's own links", () => {
    expect(importKindMismatch("youtube", `https://youtu.be/${ID}`)).toBeNull();
    expect(importKindMismatch("web", "https://example.test/article")).toBeNull();
  });

  it("points a link pasted under the wrong action at the right one", () => {
    expect(importKindMismatch("youtube", "https://example.test/article")).toMatch(
      /not a YouTube video link/,
    );
    // Scraping a watch page returns YouTube's own furniture, not the video.
    expect(importKindMismatch("web", `https://www.youtube.com/watch?v=${ID}`)).toMatch(
      /Use “From a YouTube video”/,
    );
  });

  it.each([
    "https://www.youtube.com/playlist?list=PL1234567890",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/results?search_query=history",
    // An attribution_link that unwraps to a playlist rather than a video: the
    // wrapper is understood, what it wraps still has no transcript.
    "https://www.youtube.com/attribution_link?u=%2Fplaylist%3Flist%3DPL123",
  ])("refuses %s under BOTH imports rather than scraping it", (url) => {
    // A YouTube URL with no video id is not thereby an ordinary web page.
    // Letting it through to the scraper would import YouTube's navigation
    // furniture as though it were course material, so neither action takes it —
    // and neither sends the instructor to the other one, which cannot help.
    for (const kind of ["youtube", "web"] as const) {
      expect(importKindMismatch(kind, url)).toMatch(/not a single video/);
    }
  });

  it("treats a look-alike host as an ordinary page, not as YouTube", () => {
    const lookAlike = `https://youtube.com.attacker.example/watch?v=${ID}`;
    expect(importKindMismatch("web", lookAlike)).toBeNull();
    expect(importKindMismatch("youtube", lookAlike)).toMatch(/not a YouTube video link/);
  });
});
