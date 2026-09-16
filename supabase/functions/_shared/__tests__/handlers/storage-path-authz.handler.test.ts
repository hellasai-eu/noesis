import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler as detectChapters } from "../../../detect-chapters/handler.ts";
import { handler as splitChapters } from "../../../split-chapters/handler.ts";
import { handler as pdfThumbnail } from "../../../generate-pdf-thumbnail/handler.ts";
import { handler as extractImages } from "../../../extract-images-from-pdf/handler.ts";

// ── Storage-path handlers (#1135) ──────────────────────────────────────
// All four took `{filePath, bucketName}` from the request body, established no
// caller identity, and read or wrote that object with the service-role key —
// so an anonymous request reached any institution's storage. They now resolve
// the owning course FROM the object and authorize the token-derived caller
// against it.

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const OTHER_COURSE_ID = "44444444-4444-4444-4444-444444444444";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";
const FILE_PATH = `${COURSE_ID}/1700000000-textbook.pdf`;
const BUCKET = "course-materials";
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

/** The `course_materials` row that owns the path. `null` = no such object. */
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
    new Response(JSON.stringify({ institution_id: INSTITUTION_ID }), {
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

/** `user_institutions` read behind `hasActiveMembership`. */
function membershipRoute(present: boolean, suspended = false): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(JSON.stringify(present ? { is_suspended: suspended } : null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

function courseInstructorRoute(assigned: boolean): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(JSON.stringify(assigned ? { user_id: CALLER_ID } : null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const OFFERINGS_NONE: MockRoute = {
  match: (url) => url.includes("/rest/v1/offerings"),
  respond: () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

const ENROLLMENT_NONE: MockRoute = {
  match: (url) => url.includes("/rest/v1/class_enrollments"),
  respond: () =>
    new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

/** A caller who is an admin of the institution that owns the file. */
function managerRoutes(courseId: string = COURSE_ID): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
    materialRoute(courseId),
    COURSE_ROUTE,
    institutionAdminRoute(true),
  ];
}

/** A caller with no relationship to the institution at all. */
function outsiderRoutes(courseId: string = COURSE_ID): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "outsider@elsewhere.test" }),
    materialRoute(courseId),
    COURSE_ROUTE,
    institutionAdminRoute(false),
    membershipRoute(false),
    courseInstructorRoute(false),
    OFFERINGS_NONE,
    ENROLLMENT_NONE,
  ];
}

/** Did anything reach ConvertAPI, OpenAI, or storage? */
function didExternalWork(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) =>
    c.url.includes("convertapi.com") ||
    c.url.includes("api.openai.com") ||
    c.url.includes("/storage/v1/")
  );
}

const CASES: Array<{
  name: string;
  handler: (req: Request) => Promise<Response>;
  body: Record<string, unknown>;
}> = [
  {
    name: "detect-chapters",
    handler: detectChapters,
    body: { filePath: FILE_PATH, bucketName: BUCKET, totalPages: 10 },
  },
  {
    name: "split-chapters",
    handler: splitChapters,
    body: {
      filePath: FILE_PATH,
      bucketName: BUCKET,
      chapters: [{ chapterIndex: 0, pageStart: 1, pageEnd: 2 }],
    },
  },
  {
    name: "generate-pdf-thumbnail",
    handler: pdfThumbnail,
    body: { filePath: FILE_PATH, bucketName: BUCKET },
  },
  {
    name: "extract-images-from-pdf",
    handler: extractImages,
    body: { filePath: FILE_PATH, bucketName: BUCKET, page: 1, courseId: COURSE_ID },
  },
];

for (const c of CASES) {
  Deno.test(`${c.name}: 401 without an Authorization header, and touches nothing`, async () => {
    const h = createTestHarness({ routes: managerRoutes() });
    try {
      const res = await h.invoke(c.handler, c.body);
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(didExternalWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: 401 when the token does not resolve`, async () => {
    const h = createTestHarness({
      routes: [authUserRoute({ error: "bad jwt" }, 401), ...managerRoutes().slice(1)],
    });
    try {
      const res = await h.invoke(c.handler, c.body, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(didExternalWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: 403 for a caller with no claim on the owning course`, async () => {
    const h = createTestHarness({ routes: outsiderRoutes() });
    try {
      const res = await h.invoke(c.handler, c.body, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(didExternalWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: 404 when no material owns the path`, async () => {
    // The old exploit shape: name any path you like. With no `course_materials`
    // row behind it there is no course to authorize against, so it stops here —
    // which also makes `../` traversal a non-event.
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
        materialRoute(null),
        COURSE_ROUTE,
        institutionAdminRoute(true),
      ],
    });
    try {
      const res = await h.invoke(c.handler, {
        ...c.body,
        filePath: "../other-institution/secret.pdf",
      }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(didExternalWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: 403 for a bucket outside the allow-list`, async () => {
    const h = createTestHarness({ routes: managerRoutes() });
    try {
      const res = await h.invoke(c.handler, {
        ...c.body,
        bucketName: "bug-reports",
      }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(didExternalWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: a suspended admin is refused`, async () => {
    // `is_institution_admin` already excludes suspended members (#1082); this
    // pins that these handlers go through it rather than reading the role.
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "suspended@school.test" }),
        materialRoute(COURSE_ID),
        COURSE_ROUTE,
        institutionAdminRoute(false),
        membershipRoute(true, true),
        courseInstructorRoute(true),
        OFFERINGS_NONE,
        ENROLLMENT_NONE,
      ],
    });
    try {
      const res = await h.invoke(c.handler, c.body, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(didExternalWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });
}

// ── The body's courseId is not the authority ───────────────────────────

Deno.test("extract-images-from-pdf: a forged body courseId does not redirect the write", async () => {
  // The old code took the destination path AND the course_materials row's
  // course_id straight from the body, so naming another course wrote into it.
  // Authorization now resolves from the file, so the mismatch is refused
  // outright — and the caller never reaches a write at all.
  const h = createTestHarness({ routes: outsiderRoutes(OTHER_COURSE_ID) });
  try {
    const res = await h.invoke(extractImages, {
      filePath: FILE_PATH,
      bucketName: BUCKET,
      page: 1,
      courseId: COURSE_ID, // a course the caller may well manage
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(didExternalWork(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

// ── Reader vs manager ──────────────────────────────────────────────────

Deno.test("generate-pdf-thumbnail: an enrolled student is allowed", async () => {
  // Thumbnails hang off the material preview, which enrolled students reach.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "student@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      membershipRoute(true),
      courseInstructorRoute(false),
      {
        match: (url) => url.includes("/rest/v1/offerings"),
        respond: () =>
          new Response(JSON.stringify([{ class_id: "class-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("/rest/v1/class_enrollments"),
        respond: () =>
          new Response(JSON.stringify([{ class_id: "class-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
    envVars: { CONVERT_API_KEY: "" },
  });
  try {
    const res = await h.invoke(pdfThumbnail, {
      filePath: FILE_PATH,
      bucketName: BUCKET,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    // Past the gate: it fails later on the missing ConvertAPI key, not on 403.
    assertEquals(status === 403, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-pdf-thumbnail: a suspended student is refused despite a live enrollment", async () => {
  // Suspension does not delete `class_enrollments` rows, so the enrollment on
  // its own is not evidence of access. Without the membership check the
  // student fallback reopens #1082's hole for readers: a suspended member
  // keeps reading through a stale row, and a thumbnail publishes a rendering
  // of the PDF's first page.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "suspended.student@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      membershipRoute(true, true), // membership row present, but suspended
      courseInstructorRoute(false),
      {
        match: (url) => url.includes("/rest/v1/offerings"),
        respond: () =>
          new Response(JSON.stringify([{ class_id: "class-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("/rest/v1/class_enrollments"),
        respond: () =>
          new Response(JSON.stringify([{ class_id: "class-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(pdfThumbnail, {
      filePath: FILE_PATH,
      bucketName: BUCKET,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(didExternalWork(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("split-chapters: an enrolled student is refused", async () => {
  // Splitting mints new storage objects — authoring, not reading. The same
  // caller who may render a thumbnail must not reach this.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "student@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      membershipRoute(true),
      courseInstructorRoute(false),
      {
        match: (url) => url.includes("/rest/v1/offerings"),
        respond: () =>
          new Response(JSON.stringify([{ class_id: "class-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url) => url.includes("/rest/v1/class_enrollments"),
        respond: () =>
          new Response(JSON.stringify([{ class_id: "class-1" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const res = await h.invoke(splitChapters, {
      filePath: FILE_PATH,
      bucketName: BUCKET,
      chapters: [{ chapterIndex: 0, pageStart: 1, pageEnd: 2 }],
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(didExternalWork(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("detect-chapters: an assigned instructor with a live membership is allowed", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      materialRoute(COURSE_ID),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      membershipRoute(true),
      courseInstructorRoute(true),
    ],
    envVars: { CONVERT_API_KEY: "" },
  });
  try {
    const res = await h.invoke(detectChapters, {
      filePath: FILE_PATH,
      bucketName: BUCKET,
      totalPages: 10,
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status === 401 || status === 403 || status === 404, false);
  } finally {
    h.cleanup();
  }
});
