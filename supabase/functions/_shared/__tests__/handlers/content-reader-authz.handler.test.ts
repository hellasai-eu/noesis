import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler as checkSimilarity } from "../../../check-question-similarity/handler.ts";
import { handler as extractCompetencies } from "../../../extract-competencies/handler.ts";
import { handler as chapterSummary } from "../../../generate-chapter-summary/handler.ts";
import { handler as cheatsheet } from "../../../generate-cheatsheet/handler.ts";
import { handler as flashcards } from "../../../generate-flashcards/handler.ts";

// ── Content readers (#1136) ────────────────────────────────────────────
// These five read a course's questions, materials or chapters and spent OpenAI
// credit generating from them, with the service-role key and no caller
// identity. An anonymous request could read another institution's content and
// bill this platform for it.
//
// All five are instructor surfaces — the generate controls in
// `CheatSheetViewer` sit inside its `isAdmin` branch, and the other components
// are only rendered from `CoursePage` — so the gate is manager level.

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";
const CHAPTER_ID = "44444444-4444-4444-4444-444444444444";
const MATERIAL_ID = "55555555-5555-5555-5555-555555555555";
const AUTH = { Authorization: "Bearer test-token" };

function authUserRoute(user: unknown, status = 200): MockRoute {
  return {
    match: (url) => url.includes("/auth/v1/user"),
    respond: () =>
      new Response(JSON.stringify(user), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** chapter -> material, the first hop of `resolveCourseForChapter`. */
function chapterRoute(materialId: string | null): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/material_chapters") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(JSON.stringify(materialId ? { material_id: materialId } : null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** material -> course, the second hop. */
function materialRoute(courseId: string | null): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/course_materials") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(JSON.stringify(courseId ? { course_id: courseId } : null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const COURSE_ROUTE: MockRoute = {
  match: (url, init) => url.includes("/rest/v1/courses") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response(JSON.stringify({ institution_id: INSTITUTION_ID, language: "en" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

function institutionAdminRoute(allow: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/is_institution_admin"),
    respond: () =>
      new Response(JSON.stringify(allow), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const MEMBERSHIP_NONE: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
};

const INSTRUCTOR_NONE: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
};

/** Did anything reach OpenAI? That is the spend these gates protect. */
function spent(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) => c.url.includes("api.openai.com"));
}

function managerRoutes(): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
    chapterRoute(MATERIAL_ID),
    materialRoute(COURSE_ID),
    COURSE_ROUTE,
    institutionAdminRoute(true),
  ];
}

function outsiderRoutes(): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "outsider@elsewhere.test" }),
    chapterRoute(MATERIAL_ID),
    materialRoute(COURSE_ID),
    COURSE_ROUTE,
    institutionAdminRoute(false),
    MEMBERSHIP_NONE,
    INSTRUCTOR_NONE,
  ];
}

const CASES: Array<{
  name: string;
  handler: (req: Request) => Promise<Response>;
  body: Record<string, unknown>;
}> = [
  {
    name: "check-question-similarity",
    handler: checkSimilarity,
    body: { courseId: COURSE_ID },
  },
  {
    name: "extract-competencies",
    handler: extractCompetencies,
    body: { courseId: COURSE_ID, materialId: MATERIAL_ID },
  },
  {
    name: "generate-chapter-summary",
    handler: chapterSummary,
    body: { chapterIds: [CHAPTER_ID], courseId: COURSE_ID },
  },
  { name: "generate-cheatsheet", handler: cheatsheet, body: { chapterId: CHAPTER_ID } },
  { name: "generate-flashcards", handler: flashcards, body: { chapterId: CHAPTER_ID } },
];

for (const c of CASES) {
  Deno.test({
    name: `${c.name}: 401 without an Authorization header, and spends nothing`,
    ...OPTS,
    async fn() {
      const h = createTestHarness({ routes: managerRoutes() });
      try {
        const res = await h.invoke(c.handler, c.body);
        const { status } = await parseResponse(res);
        assertEquals(status, 401);
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: 401 when the token does not resolve`,
    ...OPTS,
    async fn() {
      const h = createTestHarness({
        routes: [authUserRoute({ error: "bad jwt" }, 401), ...managerRoutes().slice(1)],
      });
      try {
        const res = await h.invoke(c.handler, c.body, { headers: AUTH });
        const { status } = await parseResponse(res);
        assertEquals(status, 401);
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: 403 for a caller with no claim on the course, and spends nothing`,
    ...OPTS,
    async fn() {
      const h = createTestHarness({ routes: outsiderRoutes() });
      try {
        const res = await h.invoke(c.handler, c.body, { headers: AUTH });
        const { status } = await parseResponse(res);
        assertEquals(status, 403);
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: a suspended admin is refused`,
    ...OPTS,
    async fn() {
      // `is_institution_admin` already excludes suspended members (#1082); this
      // pins that these handlers go through it rather than reading the role.
      const h = createTestHarness({
        routes: [
          authUserRoute({ id: CALLER_ID, email: "suspended@school.test" }),
          chapterRoute(MATERIAL_ID),
          materialRoute(COURSE_ID),
          COURSE_ROUTE,
          institutionAdminRoute(false),
          {
            match: (url, init) =>
              url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
            respond: () =>
              new Response(JSON.stringify({ is_suspended: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
          },
          INSTRUCTOR_NONE,
        ],
      });
      try {
        const res = await h.invoke(c.handler, c.body, { headers: AUTH });
        const { status } = await parseResponse(res);
        assertEquals(status, 403);
        assertEquals(spent(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });
}

// ── The chapter, not the body, decides the course ──────────────────────

Deno.test({
  name: "generate-cheatsheet: 404 when no chapter owns the id, and spends nothing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
        chapterRoute(null),
        materialRoute(COURSE_ID),
        COURSE_ROUTE,
        institutionAdminRoute(true),
      ],
    });
    try {
      const res = await h.invoke(cheatsheet, { chapterId: "no-such-chapter" }, {
        headers: AUTH,
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "generate-chapter-summary: authorizes against the chapter's course, not the body's",
  ...OPTS,
  async fn() {
    // The body names a course the caller manages; the chapter belongs to one
    // they do not. Authorization has to follow the chapter.
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
        chapterRoute(MATERIAL_ID),
        materialRoute("77777777-7777-7777-7777-777777777777"),
        COURSE_ROUTE,
        institutionAdminRoute(false),
        MEMBERSHIP_NONE,
        INSTRUCTOR_NONE,
      ],
    });
    try {
      const res = await h.invoke(chapterSummary, {
        chapterIds: [CHAPTER_ID],
        courseId: COURSE_ID, // a course the caller may well manage
      }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "extract-competencies: authorizes against the material's course, not the body's",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
        chapterRoute(MATERIAL_ID),
        materialRoute("77777777-7777-7777-7777-777777777777"),
        COURSE_ROUTE,
        institutionAdminRoute(false),
        MEMBERSHIP_NONE,
        INSTRUCTOR_NONE,
      ],
    });
    try {
      const res = await h.invoke(extractCompetencies, {
        courseId: COURSE_ID,
        materialId: MATERIAL_ID,
      }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});


// ── A list is authorized entry by entry (greptile, #1156) ──────────────

Deno.test({
  name: "generate-chapter-summary: a mixed-course chapter list is refused outright",
  ...OPTS,
  async fn() {
    // Two chapters from two different courses. Authorizing only the first
    // would fetch and send them all to OpenAI — check-one-act-on-many — and
    // carrying the LAST resolved course through would pick the language and
    // the token attribution arbitrarily. Neither call site produces such a
    // list, so it is refused rather than resolved.
    let chapterLookups = 0;
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
        {
          // Both chapters resolve, to different materials.
          match: (url, init) =>
            url.includes("/rest/v1/material_chapters") && (init?.method ?? "GET") === "GET",
          respond: () => {
            chapterLookups++;
            return new Response(
              JSON.stringify({ material_id: chapterLookups === 1 ? MATERIAL_ID : "other-material" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        },
        {
          // ...and those materials belong to different courses.
          match: (url, init) =>
            url.includes("/rest/v1/course_materials") && (init?.method ?? "GET") === "GET",
          respond: (url: string) =>
            new Response(
              JSON.stringify({
                course_id: url.includes("other-material")
                  ? "77777777-7777-7777-7777-777777777777"
                  : COURSE_ID,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        },
        COURSE_ROUTE,
        {
          // Admin of the first course only.
          match: (url, init) =>
            url.includes("/rest/v1/rpc/is_institution_admin"),
          respond: (_url: string, init?: RequestInit) => {
            const body = typeof init?.body === "string" ? init.body : "";
            return new Response(JSON.stringify(body.includes(COURSE_ID)), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
        },
        MEMBERSHIP_NONE,
        INSTRUCTOR_NONE,
      ],
    });
    try {
      const res = await h.invoke(chapterSummary, {
        chapterIds: [CHAPTER_ID, "chapter-from-another-course"],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "All sources must belong to the same course");
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});
