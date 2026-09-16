import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler as chat } from "../../../chat/handler.ts";
import { handler as studentQuestions } from "../../../generate-student-questions/handler.ts";

// ── Student-facing handlers (#1136) ────────────────────────────────────
// All three resolved a caller and then never checked them against anything.
// The two tutoring endpoints of the day — `socratic-chat` and
// `study-tutor`, since replaced by `chat` (#1441) — treated the token as
// optional entirely: present for the log line, absent without consequence, so
// an anonymous request got tutoring on any question or any student's study
// session, on this platform's OpenAI budget. `generate-student-questions` did
// require a token, but never checked the caller against `courseId`.

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const CALLER_ID = "99999999-9999-9999-9999-999999999999";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const QUESTION_ID = "44444444-4444-4444-4444-444444444444";
const STUDY_SESSION_ID = "55555555-5555-5555-5555-555555555555";
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

function jsonRoute(pattern: string, body: unknown): MockRoute {
  return {
    match: (url) => url.includes(pattern),
    respond: () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

/** `verifyQuestionEnrollment`: published offering, and the caller enrolled. */
function enrollmentRoutes(enrolled: boolean): MockRoute[] {
  return [
    jsonRoute("/rest/v1/offering_questions", [
      { offering_id: "off-1", offerings: { id: "off-1", class_id: "class-1" } },
    ]),
    jsonRoute("/rest/v1/class_enrollments", enrolled ? [{ class_id: "class-1" }] : []),
  ];
}

/** Did anything reach OpenAI? That is the spend these gates protect. */
function spent(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) => c.url.includes("api.openai.com"));
}

const CHAT_BODY = { kind: "open_question", subjectId: QUESTION_ID, courseId: COURSE_ID };
const STUDY_BODY = { kind: "study_session", subjectId: STUDY_SESSION_ID, courseId: COURSE_ID };

// ── chat: open-question surface ────────────────────────────────────────

Deno.test({
  name: "chat/open_question: 401 without an Authorization header, and spends nothing",
  ...OPTS,
  async fn() {
    // The old behaviour: the token was optional, so this exact request was
    // answered — tutoring on any question, billed to this platform.
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID }),
        jsonRoute("/rest/v1/courses", { language: "en" }),
        ...enrollmentRoutes(true),
      ],
    });
    try {
      const res = await h.invoke(chat, CHAT_BODY);
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/open_question: 403 for a caller not enrolled for that question",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID }),
        jsonRoute("/rest/v1/courses", { language: "en" }),
        ...enrollmentRoutes(false),
      ],
    });
    try {
      const res = await h.invoke(chat, CHAT_BODY, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

// ── chat: study-session surface ────────────────────────────────────────
//
// "Another student's session" has no test here any more, and that is the
// point of the unified contract rather than a gap: the turn is addressed by
// *subject*, and `resolveSession` keys the session on the authenticated
// caller — so there is no session id in the body to point somewhere else.
// The shim that did accept one carried its own ownership check, and went with
// it (#1441). What is left to establish is that the subject exists, and that
// a lookup fault is not reported as a denial.

Deno.test({
  name: "chat/study_session: 401 without an Authorization header, and spends nothing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID }),
        jsonRoute("/rest/v1/study_sessions", { id: STUDY_SESSION_ID, course_id: COURSE_ID }),
      ],
    });
    try {
      const res = await h.invoke(chat, STUDY_BODY);
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/study_session: a subject lookup that FAILS is not a denial",
  ...OPTS,
  async fn() {
    // Reporting a database fault as 403 would name a legitimate owner as an
    // intruder. Still refuses, but as a 500 the caller can retry.
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID }),
        {
          match: (url) => url.includes("/rest/v1/study_sessions"),
          respond: () =>
            new Response(JSON.stringify({ message: "connection reset" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }),
        },
      ],
    });
    try {
      const res = await h.invoke(chat, STUDY_BODY, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 500);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "chat/study_session: 404 when the study session does not exist",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID }),
        jsonRoute("/rest/v1/study_sessions", null),
      ],
    });
    try {
      const res = await h.invoke(chat, STUDY_BODY, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 404);
      assertEquals(spent(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

// ── generate-student-questions ─────────────────────────────────────────

Deno.test({
  name: "generate-student-questions: 403 for a course the caller has no claim on",
  ...OPTS,
  async fn() {
    // This one already required a token — it just never checked the caller
    // against `courseId`. The offering lookup further down only warns.
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "student@school.test" }),
        jsonRoute("/rest/v1/courses", { institution_id: "inst-1", language: "en" }),
        jsonRoute("/rest/v1/rpc/is_institution_admin", false),
        jsonRoute("/rest/v1/user_institutions", null),
        jsonRoute("/rest/v1/course_instructors", null),
        jsonRoute("/rest/v1/offerings", []),
        jsonRoute("/rest/v1/class_enrollments", []),
      ],
    });
    try {
      const res = await h.invoke(studentQuestions, {
        courseId: COURSE_ID,
        chapterId: "ch-1",
        difficulty: "medium",
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
  name: "generate-student-questions: an enrolled student gets past the gate",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ id: CALLER_ID, email: "student@school.test" }),
        jsonRoute("/rest/v1/courses", { institution_id: "inst-1", language: "en" }),
        jsonRoute("/rest/v1/rpc/is_institution_admin", false),
        jsonRoute("/rest/v1/user_institutions", { is_suspended: false }),
        jsonRoute("/rest/v1/course_instructors", null),
        jsonRoute("/rest/v1/offerings", [{ class_id: "class-1" }]),
        jsonRoute("/rest/v1/class_enrollments", [{ class_id: "class-1" }]),
      ],
    });
    try {
      const res = await h.invoke(studentQuestions, {
        courseId: COURSE_ID,
        chapterId: "ch-1",
        difficulty: "medium",
      }, { headers: AUTH });
      const { status } = await parseResponse(res);
      // Past the gate; it fails later on unmocked downstream calls, not on 403.
      assertEquals(status === 401 || status === 403, false);
    } finally {
      h.cleanup();
    }
  },
});
