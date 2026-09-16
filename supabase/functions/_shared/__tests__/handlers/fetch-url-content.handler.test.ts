import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, parseResponse, supabaseRoute } from "../handler-harness.ts";
import type { MockRoute } from "../handler-harness.ts";
import { handler } from "../../../fetch-url-content/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };
const AUTH = { Authorization: "Bearer test-token" };
const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PAGE_URL = "https://example.test/article";

/** The provider endpoints, pointed somewhere the harness can intercept. */
const PROVIDER_ENV = {
  CONTENT_PROVIDER_API_KEY: "provider-key",
  CONTENT_TRANSCRIPT_API_URL: "https://provider.test/v1/transcript",
  CONTENT_METADATA_API_URL: "https://provider.test/v1/metadata",
  CONTENT_SCRAPE_API_URL: "https://provider.test/v1/web/scrape",
};

/** GoTrue's `/auth/v1/user` — what `auth.getUser(token)` resolves. */
const CALLER: MockRoute = {
  match: (url: string) => url.includes("/auth/v1/user"),
  respond: () =>
    new Response(JSON.stringify({ id: "user-1", email: "instructor@test.local" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

/** The course exists and the caller is an admin of its institution. */
const MANAGER_ROUTES: MockRoute[] = [
  CALLER,
  supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
  supabaseRoute("/rest/v1/rpc/is_institution_admin", true),
];

/** The caller is signed in but manages nothing. */
const OUTSIDER_ROUTES: MockRoute[] = [
  CALLER,
  supabaseRoute("/rest/v1/courses", { institution_id: "inst-1" }),
  supabaseRoute("/rest/v1/rpc/is_institution_admin", false),
  supabaseRoute("/rest/v1/user_institutions", null),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The provider answers a transcript, and then the video's metadata. */
function providerVideoRoutes(
  transcript: Record<string, unknown> = { content: "Καλημέρα σε όλους.", lang: "el" },
): MockRoute[] {
  return [
    {
      match: (url) => url.includes("/v1/metadata"),
      respond: () =>
        json({
          title: "A lecture",
          author: { displayName: "A channel" },
          media: { duration: 610 },
        }),
    },
    {
      match: (url) => url.includes("/v1/transcript"),
      respond: () => json(transcript),
    },
  ];
}

/**
 * Nothing left for the site itself.
 *
 * The assertion this suite exists to make, and an allow-list rather than a
 * block-list on purpose: an import may reach the provider and the Supabase API,
 * and nothing else. The importer used to fetch youtube.com and the page
 * directly, and naming those two hosts would not catch the third one somebody
 * adds later.
 *
 * Compared on hostname, never on substring — the provider's own URL carries the
 * video's address in a query parameter, so "does the URL mention youtube.com"
 * is true for exactly the call that is meant to be there.
 */
/**
 * The provider call must carry NO `Authorization` header.
 *
 * Not a style point — this is a production outage in test form. The request
 * used to send `Authorization: Bearer <key>` alongside `x-api-key`, to make
 * swapping provider a config change; Supadata rejects any request carrying an
 * `Authorization` header, so every import 401'd with a valid key. Measured on
 * 2026-09-02: `x-api-key` alone 200, either form of Bearer 401.
 */
function assertNoAuthorizationHeader(call: { headers?: Record<string, string> } | undefined) {
  assertEquals(call !== undefined, true, "expected a provider call to inspect");
  assertEquals(
    call?.headers?.authorization,
    undefined,
    "a provider request must not carry an Authorization header",
  );
}

const ALLOWED_HOSTS = new Set(["provider.test", "localhost"]);

function assertOnlyProviderWasFetched(fetchLog: { url: string }[]) {
  for (const entry of fetchLog) {
    assertEquals(
      ALLOWED_HOSTS.has(new URL(entry.url).hostname),
      true,
      `an import reached ${new URL(entry.url).hostname}`,
    );
  }
}

Deno.test("fetch-url-content: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/fetch-url-content", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "fetch-url-content: an unauthenticated caller is refused",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1" });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Unauthorized");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a caller who does not manage the course is refused",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ envVars: PROVIDER_ENV, routes: OUTSIDER_ROUTES });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1" }, {
        headers: AUTH,
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      // No provider credit is spent on a refused request.
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("provider.test")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: returns 400 without a courseId",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: MANAGER_ROUTES });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("courseId"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: rejects a kind it does not have a route for",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ envVars: PROVIDER_ENV, routes: MANAGER_ROUTES });
    try {
      const res = await h.invoke(
        handler,
        { url: VIDEO_URL, courseId: "course-1", kind: "podcast" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("kind"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: refuses a page under the YouTube import",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ envVars: PROVIDER_ENV, routes: MANAGER_ROUTES });
    try {
      const res = await h.invoke(
        handler,
        { url: PAGE_URL, courseId: "course-1", kind: "youtube" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("not a YouTube video link"), true);
      // Refused before the transcript endpoint was asked about an article.
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("provider.test")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: refuses a video under the web-page import",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ envVars: PROVIDER_ENV, routes: MANAGER_ROUTES });
    try {
      const res = await h.invoke(
        handler,
        { url: VIDEO_URL, courseId: "course-1", kind: "web" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error.includes("YouTube link"), true);
      // Scraping a watch page would spend a credit to return YouTube's own
      // furniture rather than the video.
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("provider.test")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a YouTube link naming no video is refused, never scraped",
  ...OPTS,
  async fn() {
    // A YouTube URL with no video id is not thereby an ordinary web page.
    // Letting one through to the scrape endpoint would spend a credit to
    // import YouTube's navigation furniture as course material — so it is
    // refused under either action, and under none.
    for (
      const url of [
        "https://www.youtube.com/playlist?list=PL1234567890",
        "https://www.youtube.com/@somechannel",
        "https://www.youtube.com/results?search_query=history",
        // The wrapper is understood; what this one wraps still has no
        // transcript. (One wrapping a real video imports normally.)
        "https://www.youtube.com/attribution_link?u=%2Fplaylist%3Flist%3DPL123",
        "https://youtu.be/tooshort",
      ]
    ) {
      for (const kind of ["youtube", "web", undefined]) {
        const h = createTestHarness({ envVars: PROVIDER_ENV, routes: MANAGER_ROUTES });
        try {
          const res = await h.invoke(handler, { url, courseId: "course-1", kind }, {
            headers: AUTH,
          });
          const { status, body } = await parseResponse(res);
          assertEquals(status, 400, `should have refused ${url} under kind=${kind}`);
          assertEquals(body.error.includes("not a single video"), true);
          assertEquals(h.fetchLog.some((entry) => entry.url.includes("provider.test")), false);
        } finally {
          h.cleanup();
        }
      }
    }
  },
});

Deno.test({
  name: "fetch-url-content: a look-alike host is treated as a web page, never as YouTube",
  ...OPTS,
  async fn() {
    const lookAlike = "https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ";
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        {
          match: (url) => url.includes("/v1/web/scrape"),
          respond: () => json({ url: lookAlike, content: "Ordinary page.", name: "Not YouTube" }),
        },
      ],
    });
    try {
      // Contains "youtube.com" but is not YouTube — the case a substring check
      // would wave through, under the import that would then be wrong for it.
      const res = await h.invoke(
        handler,
        { url: lookAlike, courseId: "course-1", kind: "web" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.kind, "web");
      assertEquals(body.videoId, null);
      assertEquals(
        h.fetchLog.some((entry) => new URL(entry.url).hostname.endsWith("youtube.com")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: refuses a link that points inside a network",
  ...OPTS,
  async fn() {
    // The provider does the fetching, so none of these is an SSRF sink any
    // more — but each is a link somebody could paste, and each is worth naming
    // rather than paying the provider to discover.
    for (
      const url of [
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:54321/rest/v1/profiles",
        "http://127.0.0.1/",
        "http://10.0.0.5/admin",
        "http://[::1]/",
        "http://user:pass@example.com/",
        "file:///etc/passwd",
      ]
    ) {
      const h = createTestHarness({ envVars: PROVIDER_ENV, routes: MANAGER_ROUTES });
      try {
        const res = await h.invoke(handler, { url, courseId: "course-1", kind: "web" }, {
          headers: AUTH,
        });
        const { status } = await parseResponse(res);
        assertEquals(status, 400, `should have refused ${url}`);
        // Refused before anything left, for the target or for the provider.
        assertEquals(
          h.fetchLog.every((entry) =>
            !/169\.254|10\.0\.0\.5|\[::1\]|127\.0\.0\.1|user:pass|etc\/passwd|provider\.test/
              .test(entry.url)
          ),
          true,
          `something was fetched for ${url}`,
        );
      } finally {
        h.cleanup();
      }
    }
  },
});

Deno.test({
  name: "fetch-url-content: imports a page through the scrape endpoint and nowhere else",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        {
          match: (url) => url.includes("/v1/web/scrape"),
          respond: () =>
            json({
              url: PAGE_URL,
              content: "# Η Γαλλική Επανάσταση\n\n- Πρώτο\n- Δεύτερο",
              name: "Η Γαλλική Επανάσταση",
              lang: "el",
            }),
        },
      ],
    });
    try {
      const res = await h.invoke(
        handler,
        { url: PAGE_URL, courseId: "course-1", language: "el", kind: "web" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.kind, "web");
      assertEquals(body.title, "Η Γαλλική Επανάσταση");
      assertEquals(body.author, "example.test");
      assertEquals(body.language, "el");
      assertEquals(body.markdown.includes("# Η Γαλλική Επανάσταση"), true);
      assertEquals(body.markdown.includes("- Πρώτο"), true);
      assertEquals(body.characterCount, body.markdown.length);

      const call = h.fetchLog.find((entry) => entry.url.includes("/v1/web/scrape"));
      assertEquals(call?.headers?.["x-api-key"], "provider-key");
      assertNoAuthorizationHeader(call);
      // The course's language is what the request asked for.
      assertEquals(new URL(call?.url ?? "https://x.test").searchParams.get("lang"), "el");
      // The page itself was never fetched from here.
      assertOnlyProviderWasFetched(h.fetchLog);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a page the provider cannot read is reported, not fetched directly",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        // The provider answers, with nothing in it. There is no second route to
        // try any more, so this is the end of the import.
        { match: (url) => url.includes("/v1/web/scrape"), respond: () => json({ content: "" }) },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: PAGE_URL, courseId: "course-1", kind: "web" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 422);
      assertEquals(body.error.includes("Could not read that page"), true);
      assertOnlyProviderWasFetched(h.fetchLog);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: imports a transcript through the provider and never asks YouTube",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [...MANAGER_ROUTES, ...providerVideoRoutes()],
    });
    try {
      const res = await h.invoke(
        handler,
        { url: VIDEO_URL, courseId: "course-1", language: "el", kind: "youtube" },
        { headers: AUTH },
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.kind, "youtube");
      assertEquals(body.videoId, "dQw4w9WgXcQ");
      assertEquals(body.url, VIDEO_URL);
      assertEquals(body.markdown, "Καλημέρα σε όλους.");
      assertEquals(body.language, "el");
      assertEquals(body.characterCount, body.markdown.length);
      // Title, channel and duration come from the provider's metadata call —
      // YouTube's player response is no longer ours to read.
      assertEquals(body.title, "A lecture");
      assertEquals(body.author, "A channel");
      assertEquals(body.durationSeconds, 610);

      const transcriptCall = h.fetchLog.find((entry) => entry.url.includes("/v1/transcript"));
      assertEquals(transcriptCall?.headers?.["x-api-key"], "provider-key");
      assertNoAuthorizationHeader(transcriptCall);
      assertNoAuthorizationHeader(h.fetchLog.find((e) => e.url.includes("/v1/metadata")));
      assertEquals(
        transcriptCall?.url.includes("v%3DdQw4w9WgXcQ") ||
          transcriptCall?.url.includes("v=dQw4w9WgXcQ"),
        true,
      );
      assertOnlyProviderWasFetched(h.fetchLog);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: infers the route when an older caller sends no kind",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [...MANAGER_ROUTES, ...providerVideoRoutes()],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.kind, "youtube");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a transcript survives a metadata call that fails",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        { match: (url) => url.includes("/v1/metadata"), respond: () => json({}, 500) },
        {
          match: (url) => url.includes("/v1/transcript"),
          respond: () => json({ content: "Καλημέρα σε όλους.", lang: "el" }),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      // The transcript is the import; a missing title is a worse import, not a
      // failed one — the dialog falls back to the video id and lets the
      // instructor type a title.
      assertEquals(status, 200);
      assertEquals(body.markdown, "Καλημέρα σε όλους.");
      assertEquals(body.title, null);
      assertEquals(body.author, null);
      assertEquals(body.durationSeconds, null);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a video with no transcript reports it as such",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        // 404 is the provider saying "nothing here for that URL" — an answer,
        // not an outage.
        { match: (url) => url.includes("/v1/transcript"), respond: () => json({}, 404) },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 422);
      assertEquals(body.error.includes("Could not get a transcript"), true);
      // No metadata credit spent on a video that produced nothing.
      assertEquals(h.fetchLog.some((entry) => entry.url.includes("/v1/metadata")), false);
    } finally {
      h.cleanup();
    }
  },
});

/**
 * Supadata queues ANY video over 20 minutes and answers 202 `{jobId}` — which
 * is most of what an instructor imports, so the job flow is the main path, not
 * an edge case.
 */
Deno.test({
  name: "fetch-url-content: waits out an async provider job",
  ...OPTS,
  async fn() {
    let polls = 0;
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        {
          match: (url) => url.includes("/v1/metadata"),
          respond: () => json({ title: "A lecture" }),
        },
        {
          match: (url) => url.includes("/v1/transcript/job-1"),
          respond: () => {
            polls++;
            return json({ status: "completed", content: "Καλημέρα σε όλους.", lang: "el" });
          },
        },
        {
          match: (url) => url.includes("/v1/transcript?"),
          respond: () => json({ jobId: "job-1" }, 202),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.markdown, "Καλημέρα σε όλους.");
      // The job is polled before the first sleep, so a ready job costs no wait.
      assertEquals(polls, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a failed provider job is reported, not retried forever",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: PROVIDER_ENV,
      routes: [
        ...MANAGER_ROUTES,
        {
          match: (url) => url.includes("/v1/transcript/job-1"),
          respond: () => json({ status: "failed", error: "unsupported media" }),
        },
        {
          match: (url) => url.includes("/v1/transcript?"),
          respond: () => json({ jobId: "job-1" }, 202),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 422);
      assertEquals(body.error.includes("could not process this link"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a job still running at the deadline says to try again",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: {
        ...PROVIDER_ENV,
        // Budget exhausted on the first check, so the test does not sit through
        // a real polling interval.
        CONTENT_PROVIDER_POLL_BUDGET_MS: "1",
      },
      routes: [
        ...MANAGER_ROUTES,
        {
          match: (url) => url.includes("/v1/transcript/job-1"),
          respond: () => json({ status: "active" }),
        },
        {
          match: (url) => url.includes("/v1/transcript?"),
          respond: () => json({ jobId: "job-1" }, 202),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 504);
      assertEquals(body.error.includes("Try again"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: says the service is unconfigured when there is no provider key",
  ...OPTS,
  async fn() {
    // Both imports are off without a key now — there is no route that does not
    // go through the provider — so this is a configuration fault to escalate,
    // not "that link did not work".
    for (const kind of ["youtube", "web"]) {
      const h = createTestHarness({
        envVars: { CONTENT_PROVIDER_API_KEY: "", YOUTUBE_TRANSCRIPT_API_KEY: "" },
        routes: MANAGER_ROUTES,
      });
      try {
        const res = await h.invoke(
          handler,
          { url: kind === "youtube" ? VIDEO_URL : PAGE_URL, courseId: "course-1", kind },
          { headers: AUTH },
        );
        const { status, body } = await parseResponse(res);
        assertEquals(status, 503, `${kind} should have reported a configuration fault`);
        assertEquals(body.error.includes("CONTENT_PROVIDER_API_KEY"), true);
        assertOnlyProviderWasFetched(h.fetchLog);
      } finally {
        h.cleanup();
      }
    }
  },
});

Deno.test({
  name: "fetch-url-content: the older key spelling still configures the provider",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: {
        // What deployments already have set; kept working on purpose.
        YOUTUBE_TRANSCRIPT_API_KEY: "provider-key",
        CONTENT_TRANSCRIPT_API_URL: "https://provider.test/v1/transcript",
        CONTENT_METADATA_API_URL: "https://provider.test/v1/metadata",
      },
      routes: [...MANAGER_ROUTES, ...providerVideoRoutes()],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.markdown, "Καλημέρα σε όλους.");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "fetch-url-content: a rejected provider key is reported as a key problem",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      envVars: { ...PROVIDER_ENV, CONTENT_PROVIDER_API_KEY: "bad-key" },
      routes: [
        ...MANAGER_ROUTES,
        {
          match: (url) => url.includes("/v1/transcript"),
          respond: () => json({ error: "unauthorized" }, 401),
        },
      ],
    });
    try {
      const res = await h.invoke(handler, { url: VIDEO_URL, courseId: "course-1", kind: "youtube" }, {
        headers: AUTH,
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 502);
      assertEquals(body.error.includes("API key"), true);
    } finally {
      h.cleanup();
    }
  },
});
