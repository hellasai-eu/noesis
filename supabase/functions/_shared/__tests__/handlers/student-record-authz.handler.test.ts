import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler as studentEvaluation } from "../../../generate-student-evaluation/handler.ts";

// ── Student-record handlers (#1135) ────────────────────────────────────
// These took `{courseId, userId}` from the request body and wrote an AI
// verdict onto that student with the service-role key, establishing no caller
// identity. They now require a caller who manages the course AND a subject who
// is actually a student on it. (`grade-interaction` shared this suite until
// AI grading was removed; `generate-student-evaluation` remains.)

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const SUBJECT_ID = "88888888-8888-8888-8888-888888888888";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";
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

/** Question fetches made past the gate resolve to this course. */
function questionRoute(courseId: string = COURSE_ID): MockRoute {
  return {
    match: (url, init) =>
      url.includes("/rest/v1/questions") && (init?.method ?? "GET") === "GET",
    respond: () =>
      new Response(
        JSON.stringify({
          question: "Explain photosynthesis.",
          answer_key: { model_answer: "Plants convert light to energy." },
          course_id: courseId,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
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

const MEMBERSHIP_NONE: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
  respond: () =>
    new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

/**
 * `instructor_can_access_section` — the section-scope RPC. `true` is the
 * unrestricted case (no `course_instructor_sections` rows for this
 * instructor+course), which is what most callers are.
 */
function sectionAccessRoute(allow: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/rpc/instructor_can_access_section"),
    respond: () =>
      new Response(JSON.stringify(allow), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const OFFERINGS: MockRoute = {
  match: (url) => url.includes("/rest/v1/offerings"),
  respond: () =>
    new Response(JSON.stringify([{ class_id: "class-1" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

/** Whether the *subject* is enrolled. */
function enrollmentRoute(enrolled: boolean): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/class_enrollments"),
    respond: () =>
      new Response(JSON.stringify(enrolled ? [{ class_id: "class-1" }] : []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** An institution admin, with the subject enrolled on the course. */
function managerRoutes(subjectEnrolled = true): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
    questionRoute(),
    COURSE_ROUTE,
    institutionAdminRoute(true),
    OFFERINGS,
    enrollmentRoute(subjectEnrolled),
  ];
}

/** A caller with no claim on the course at all. */
function outsiderRoutes(): MockRoute[] {
  return [
    authUserRoute({ id: CALLER_ID, email: "outsider@elsewhere.test" }),
    questionRoute(),
    COURSE_ROUTE,
    institutionAdminRoute(false),
    MEMBERSHIP_NONE,
    {
      match: (url, init) =>
        url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
      respond: () =>
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    OFFERINGS,
    enrollmentRoute(true),
  ];
}

/** Did anything reach OpenAI, or write a verdict back? */
function didWork(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) =>
    c.url.includes("api.openai.com") ||
    (c.method === "POST" && c.url.includes("/rest/v1/") &&
      !c.url.includes("/rest/v1/rpc/")) ||
    (c.method === "PATCH" && c.url.includes("/rest/v1/"))
  );
}

const CASES: Array<{
  name: string;
  handler: (req: Request) => Promise<Response>;
  body: Record<string, unknown>;
}> = [
  {
    name: "generate-student-evaluation",
    handler: studentEvaluation,
    body: { courseId: COURSE_ID, userId: SUBJECT_ID, stats: {} },
  },
];

for (const c of CASES) {
  Deno.test(`${c.name}: 401 without an Authorization header, and writes nothing`, async () => {
    const h = createTestHarness({ routes: managerRoutes() });
    try {
      const res = await h.invoke(c.handler, c.body);
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(didWork(h.fetchLog), false);
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
      assertEquals(didWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: 403 for a caller who does not manage the course`, async () => {
    const h = createTestHarness({ routes: outsiderRoutes() });
    try {
      const res = await h.invoke(c.handler, c.body, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(didWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });

  Deno.test(`${c.name}: 403 when the subject is not a student on the course`, async () => {
    // The check that is easy to miss: the caller genuinely manages this course,
    // but the user id in the body belongs to someone who is not on it. Without
    // this, an instructor could write an AI verdict onto any account.
    const h = createTestHarness({ routes: managerRoutes(false) });
    try {
      const res = await h.invoke(c.handler, c.body, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "That user is not a student on this course");
      assertEquals(didWork(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  });
}

// ── An assigned instructor with a live membership gets through ─────────

Deno.test("generate-student-evaluation: an assigned instructor is allowed past the gate", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor@school.test" }),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      {
        match: (url, init) =>
          url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ is_suspended: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url, init) =>
          url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ user_id: CALLER_ID }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      OFFERINGS,
      enrollmentRoute(true),
      sectionAccessRoute(true),
    ],
  });
  try {
    const res = await h.invoke(studentEvaluation, {
      courseId: COURSE_ID,
      userId: SUBJECT_ID,
      stats: {},
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    // Past the gate — it fails later on unmocked downstream calls, not on 401/403.
    assertEquals(status === 401 || status === 403, false);
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-student-evaluation: a suspended admin is refused", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "suspended@school.test" }),
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
      {
        match: (url, init) =>
          url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ user_id: CALLER_ID }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      OFFERINGS,
      enrollmentRoute(true),
    ],
  });
  try {
    const res = await h.invoke(studentEvaluation, {
      courseId: COURSE_ID,
      userId: SUBJECT_ID,
      stats: {},
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(didWork(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});


// ── Section scope (greptile, #1150) ────────────────────────────────────
// `course_instructor_sections` restricts an instructor to named sections of a
// course. RLS enforces that for browser traffic, but these handlers run on the
// service-role key, so the policy is never evaluated — the check has to be made
// here, or the restriction holds everywhere except the one path that writes AI
// verdicts onto student records.

Deno.test("generate-student-evaluation: a section-restricted instructor cannot reach another section's student", async () => {
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "instructor.sectionB@school.test" }),
      COURSE_ROUTE,
      institutionAdminRoute(false),
      {
        match: (url, init) =>
          url.includes("/rest/v1/user_institutions") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ is_suspended: false }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      {
        match: (url, init) =>
          url.includes("/rest/v1/course_instructors") && (init?.method ?? "GET") === "GET",
        respond: () =>
          new Response(JSON.stringify({ user_id: CALLER_ID }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      },
      OFFERINGS,
      enrollmentRoute(true),
      sectionAccessRoute(false), // the subject sits in a section they do not teach
    ],
  });
  try {
    const res = await h.invoke(studentEvaluation, {
      courseId: COURSE_ID,
      userId: SUBJECT_ID,
      stats: {},
    }, { headers: AUTH });
    const { status, body } = await parseResponse(res);
    assertEquals(status, 403);
    assertEquals(body.error, "That student is in a section you do not teach");
    assertEquals(didWork(h.fetchLog), false);
  } finally {
    h.cleanup();
  }
});

Deno.test("generate-student-evaluation: an institution admin is not bound by section restrictions", async () => {
  // Section rules bind assigned instructors. An admin qualifies a different
  // way, so the RPC is never consulted — asserted by leaving it unmocked and
  // checking it was never called.
  const h = createTestHarness({
    routes: [
      authUserRoute({ id: CALLER_ID, email: "admin@school.test" }),
      questionRoute(),
      COURSE_ROUTE,
      institutionAdminRoute(true),
      OFFERINGS,
      enrollmentRoute(true),
    ],
  });
  try {
    const res = await h.invoke(studentEvaluation, {
      courseId: COURSE_ID,
      userId: SUBJECT_ID,
      stats: {},
    }, { headers: AUTH });
    const { status } = await parseResponse(res);
    assertEquals(status === 401 || status === 403, false);
    assertEquals(
      h.fetchLog.some((c) => c.url.includes("instructor_can_access_section")),
      false,
    );
  } finally {
    h.cleanup();
  }
});
