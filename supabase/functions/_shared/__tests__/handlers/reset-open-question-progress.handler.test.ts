import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  FetchLogEntry,
  MockRoute,
  parseResponse,
} from "../handler-harness.ts";
import { handler } from "../../../reset-open-question-progress/handler.ts";

// ── reset-open-question-progress (#1099, #1162) ────────────────────────
// This handler had no test at all, which is how it carried a standing type
// error nobody saw — `npm test` only typechecks the test directory and what it
// imports.
//
// Note what is deliberately NOT asserted here: section scope. The RPC deletes
// by `open_question_id` alone, across every section, and #1162 accepted that as
// intended rather than gating it — because a gate would have to answer "whose
// work is about to be deleted", and neither publication nor current enrollment
// answers that reliably for work created before the state changed. The warning
// lives in `OpenQuestionsTable`'s confirmation instead.

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const USER_ID = "99999999-9999-9999-9999-999999999999";
const QUESTION_ID = "44444444-4444-4444-4444-444444444444";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const INSTITUTION_ID = "22222222-2222-2222-2222-222222222222";
const AUTH = { authorization: "Bearer test-token" };

const BODY = { questionId: QUESTION_ID, priorMode: "interactive", newMode: "single" };

function json(pattern: string, body: unknown, status = 200): MockRoute {
  return {
    match: (url) => url.includes(pattern),
    respond: () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const CALLER = json("/auth/v1/user", { id: USER_ID, email: "instructor@school.test" });

const QUESTION = json("/rest/v1/questions", {
  course_id: COURSE_ID,
  courses: { institution_id: INSTITUTION_ID },
});

const RESET_RPC = json("/rest/v1/rpc/reset_open_question_progress", { chats: 3 });
const AUDIT_INSERT: MockRoute = {
  match: (url, init) =>
    url.includes("/rest/v1/open_question_mode_changes") && init?.method === "POST",
  respond: () =>
    new Response(JSON.stringify([]), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }),
};

/** An assigned instructor, not an admin. */
const INSTRUCTOR: MockRoute[] = [
  json("/rest/v1/rpc/is_institution_admin", false),
  json("/rest/v1/user_institutions", { is_suspended: false }),
  json("/rest/v1/course_instructors", { user_id: USER_ID }),
];

/** Did the destructive wipe actually run? */
function wiped(fetchLog: FetchLogEntry[]): boolean {
  return fetchLog.some((c) => c.url.includes("rpc/reset_open_question_progress"));
}

Deno.test({
  name: "reset-open-question-progress: 401 without a caller, and destroys nothing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [CALLER, QUESTION, ...INSTRUCTOR, RESET_RPC] });
    try {
      const res = await h.invoke(handler, BODY);
      const { status } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: an assigned instructor can reset",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [CALLER, QUESTION, ...INSTRUCTOR, RESET_RPC, AUDIT_INSERT],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 200);
      assertEquals(wiped(h.fetchLog), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: an institution admin can reset",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        QUESTION,
        json("/rest/v1/rpc/is_institution_admin", true),
        RESET_RPC,
        AUDIT_INSERT,
      ],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 200);
      assertEquals(wiped(h.fetchLog), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: a caller with no claim on the course destroys nothing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        CALLER,
        QUESTION,
        json("/rest/v1/rpc/is_institution_admin", false),
        json("/rest/v1/user_institutions", null),
        json("/rest/v1/course_instructors", null),
        RESET_RPC,
        AUDIT_INSERT,
      ],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 403);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: a suspended instructor keeps the assignment and loses the power",
  ...OPTS,
  async fn() {
    // The regression #1086 closed, on the one function it changed without a
    // test to catch it (#1099). `course_instructors` has no suspension column,
    // so the assignment below is exactly what a suspended instructor still
    // holds — and the old role-only check would have honoured it and wiped
    // every student's work on the question.
    const h = createTestHarness({
      routes: [
        CALLER,
        QUESTION,
        json("/rest/v1/rpc/is_institution_admin", false),
        json("/rest/v1/user_institutions", { is_suspended: true }),
        json("/rest/v1/course_instructors", { user_id: USER_ID }),
        RESET_RPC,
        AUDIT_INSERT,
      ],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 403);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: an authorization check that FAILS is 500, not 403",
  ...OPTS,
  async fn() {
    // #1155: a database fault answered as 403 names a legitimate admin as an
    // intruder. Destroys nothing either way.
    const h = createTestHarness({
      routes: [
        CALLER,
        QUESTION,
        json("/rest/v1/rpc/is_institution_admin", { message: "boom" }, 500),
        RESET_RPC,
        AUDIT_INSERT,
      ],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 500);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: the same is true of the INSTRUCTOR check, on its own branch",
  ...OPTS,
  async fn() {
    // The handler asks two questions and each has its own 500 path. The
    // instructor one is reached only when the admin check has said a clean no,
    // so the test above cannot exercise it.
    const h = createTestHarness({
      routes: [
        CALLER,
        QUESTION,
        json("/rest/v1/rpc/is_institution_admin", false),
        json("/rest/v1/user_institutions", { message: "connection reset" }, 500),
        json("/rest/v1/course_instructors", { user_id: USER_ID }),
        RESET_RPC,
        AUDIT_INSERT,
      ],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 500);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: 404 for a question that does not exist",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [CALLER, json("/rest/v1/questions", null), ...INSTRUCTOR, RESET_RPC],
    });
    try {
      const res = await h.invoke(handler, BODY, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 404);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "reset-open-question-progress: 400 when the modes are identical",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [CALLER, QUESTION, ...INSTRUCTOR, RESET_RPC] });
    try {
      const res = await h.invoke(handler, {
        questionId: QUESTION_ID,
        priorMode: "single",
        newMode: "single",
      }, { headers: AUTH });
      assertEquals((await parseResponse(res)).status, 400);
      assertEquals(wiped(h.fetchLog), false);
    } finally {
      h.cleanup();
    }
  },
});
