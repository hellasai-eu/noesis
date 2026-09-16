import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  type MockRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../derive-group-weaknesses/handler.ts";

// The pure aggregation this handler feeds is covered by group-weaknesses.test.ts.
// What is only reachable here is the IO around it: the caller gate, the RLS-scoped
// authorization read, group→membership resolution, and the enrollment filter that
// decides whose answers are ever fetched. Those are the assertions below.

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const AUTH = { authorization: "Bearer test-token" };

const CALLER_ID = "11111111-1111-1111-1111-111111111111";
const OFFERING_ID = "22222222-2222-2222-2222-222222222222";
const COURSE_ID = "33333333-3333-3333-3333-333333333333";
const CLASS_ID = "44444444-4444-4444-4444-444444444444";
const GROUP_ID = "55555555-5555-5555-5555-555555555555";

const STUDENT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STUDENT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
/** Enrolled in some other class — must never reach a data query. */
const OUTSIDER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

/** GoTrue's `/auth/v1/user` — what `auth.getUser(token)` resolves. */
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

const callerRoute = authUserRoute({ id: CALLER_ID, email: "instructor@test.local" });

/**
 * The RLS-scoped offering read that *is* the authorization check: an anon-key
 * client carrying the caller's token sees the row only if `can_manage_offering`
 * lets it. `rows: []` is therefore "not a manager", not merely "not found".
 */
function offeringRoute(rows: unknown[] = [{
  id: OFFERING_ID,
  course_id: COURSE_ID,
  class_id: CLASS_ID,
}]): MockRoute {
  return supabaseRoute("/rest/v1/offerings", rows);
}

/** Every read the handler makes once it is past the gate, with empty defaults. */
function signalRoutes(overrides: {
  quizAnswers?: unknown[];
  questionCompetencies?: unknown[];
  studentEvaluations?: unknown[];
  evaluationScores?: unknown[];
  courseCompetencies?: unknown[];
  competencyChapters?: unknown[];
  materialChapters?: unknown[];
} = {}): MockRoute[] {
  return [
    supabaseRoute("/rest/v1/quiz_answers", overrides.quizAnswers ?? []),
    supabaseRoute("/rest/v1/question_competencies", overrides.questionCompetencies ?? []),
    supabaseRoute("/rest/v1/student_evaluations", overrides.studentEvaluations ?? []),
    supabaseRoute("/rest/v1/evaluation_competency_scores", overrides.evaluationScores ?? []),
    supabaseRoute("/rest/v1/course_competencies", overrides.courseCompetencies ?? []),
    supabaseRoute("/rest/v1/competency_chapters", overrides.competencyChapters ?? []),
    supabaseRoute("/rest/v1/material_chapters", overrides.materialChapters ?? []),
  ];
}

/**
 * Members the offering's class actually enrols as students.
 *
 * The roster read is the whole isolation mechanism: it is what confines a group
 * to one class and to learners rather than co-teachers. A mock that answered
 * whatever the filters said would keep this suite green after either scoping
 * clause was dropped from the handler, so it answers *only* the query the
 * handler is supposed to make and returns an empty roster for anything else.
 */
function enrollmentRoute(userIds: string[]): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/class_enrollments"),
    respond: (url) => {
      const query = decodeURIComponent(url);
      const scoped = query.includes(`class_id=eq.${CLASS_ID}`) &&
        query.includes("role=eq.student");
      return new Response(
        JSON.stringify(scoped ? userIds.map((user_id) => ({ user_id })) : []),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  };
}

const groupRoute = (offeringId = OFFERING_ID): MockRoute =>
  supabaseRoute("/rest/v1/offering_groups", [{ id: GROUP_ID, offering_id: offeringId }]);

const groupMembersRoute = (userIds: string[]): MockRoute =>
  supabaseRoute(
    "/rest/v1/offering_group_members",
    userIds.map((user_id) => ({ user_id })),
  );

// ── Shape ──────────────────────────────────────────────────────────────

Deno.test({
  name: "derive-group-weaknesses: OPTIONS returns CORS headers",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await handler(
        new Request("http://localhost/functions/v1/derive-group-weaknesses", {
          method: "OPTIONS",
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: 400 when offering_id is missing",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, { group_id: GROUP_ID }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "offering_id is required");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: 400 when neither group_id nor member_user_ids is given",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, { offering_id: OFFERING_ID }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Provide group_id or member_user_ids");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: an empty member_user_ids array is not a group",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Provide group_id or member_user_ids");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: 400 when member_user_ids exceeds the 200-entry cap",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: Array.from({ length: 201 }, (_, i) => `user-${i}`),
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "member_user_ids cannot exceed 200 entries");
      // The cap exists to keep `.in(...)` clauses bounded, so it must fire
      // before the ids reach a query.
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/")), false);
    } finally {
      h.cleanup();
    }
  },
});

// ── Caller gate ────────────────────────────────────────────────────────

Deno.test({
  name: "derive-group-weaknesses: 401 without an Authorization header, and reads nothing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({ routes: [callerRoute, offeringRoute(), ...signalRoutes()] });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A],
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Authorization required");
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: 401 when the token does not resolve to a user",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        authUserRoute({ message: "invalid token" }, 401),
        offeringRoute(),
        ...signalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 401);
      assertEquals(body.error, "Invalid authentication");
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/quiz_answers")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "derive-group-weaknesses: 403 when the caller cannot see the offering under RLS, and no student data is read",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        // The caller-scoped read comes back empty: they do not manage it.
        offeringRoute([]),
        enrollmentRoute([STUDENT_A]),
        ...signalRoutes({
          quizAnswers: [{ user_id: STUDENT_A, is_correct: false, question_id: "q-1" }],
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 403);
      assertEquals(body.error, "Forbidden or offering not found");
      // A 403 that still ran the queries would have leaked the answers into the
      // logs and spent the reads; the gate must come first.
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/quiz_answers")), false);
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/student_evaluations")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: the authorization read is scoped to the caller's token, not the service role",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        enrollmentRoute([]),
        ...signalRoutes(),
      ],
    });
    try {
      await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A],
      }, { headers: AUTH });
      const offeringCall = h.fetchLog.find((e) => e.url.includes("/rest/v1/offerings"));
      assertExists(offeringCall);
      assertEquals(offeringCall!.url.includes(OFFERING_ID), true);
      // The service-role key bypasses RLS, so reading the offering with it would
      // authorize everyone. `can_manage_offering` only decides anything when the
      // read goes out on the anon key carrying the caller's own token.
      const headers = offeringCall!.headers ?? {};
      assertEquals(headers["apikey"], "test-anon-key");
      assertEquals(headers["authorization"], "Bearer test-token");

      // The membership reads, by contrast, are deliberately service-role: they
      // run only after the gate above has already said yes.
      const enrollmentCall = h.fetchLog.find((e) =>
        e.url.includes("/rest/v1/class_enrollments")
      );
      assertExists(enrollmentCall);
      assertEquals(enrollmentCall!.headers?.["apikey"], "test-service-role-key");
    } finally {
      h.cleanup();
    }
  },
});

// ── Group resolution ───────────────────────────────────────────────────

Deno.test({
  name: "derive-group-weaknesses: 400 when the group belongs to a different offering",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        groupRoute("99999999-9999-9999-9999-999999999999"),
        groupMembersRoute([STUDENT_A]),
        enrollmentRoute([STUDENT_A]),
        ...signalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        group_id: GROUP_ID,
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Group not found in this offering");
      // Authorization was granted for OFFERING_ID; a group from elsewhere must
      // not borrow it to read its own members.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/offering_group_members")),
        false,
      );
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: 400 when the group does not exist",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        supabaseRoute("/rest/v1/offering_groups", []),
        ...signalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        group_id: GROUP_ID,
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 400);
      assertEquals(body.error, "Group not found in this offering");
    } finally {
      h.cleanup();
    }
  },
});

// ── Institutional isolation ────────────────────────────────────────────

Deno.test({
  name:
    "derive-group-weaknesses: ids not enrolled in the offering's class never reach a data query (#852)",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        // Only A is a student of this offering's class.
        enrollmentRoute([STUDENT_A]),
        ...signalRoutes({
          quizAnswers: [
            { user_id: STUDENT_A, is_correct: false, question_id: "q-1" },
            { user_id: STUDENT_A, is_correct: false, question_id: "q-2" },
            { user_id: STUDENT_A, is_correct: false, question_id: "q-3" },
            { user_id: STUDENT_A, is_correct: true, question_id: "q-4" },
            { user_id: STUDENT_A, is_correct: true, question_id: "q-5" },
          ],
        }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        // A caller who manages this offering hand-picks an id from another class.
        member_user_ids: [STUDENT_A, OUTSIDER],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      // Only the enrolled member is counted…
      assertEquals(body.overall.member_count, 1);
      // …and the outsider's id is absent from every query the handler issued,
      // so their answers and evaluations are never even fetched.
      const leaked = h.fetchLog.filter((e) =>
        e.url.includes(OUTSIDER) && !e.url.includes("/rest/v1/class_enrollments")
      );
      assertEquals(leaked.map((e) => e.url), []);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "derive-group-weaknesses: the roster read is scoped to the offering's own class and to students",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        enrollmentRoute([STUDENT_A]),
        ...signalRoutes(),
      ],
    });
    try {
      await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A, OUTSIDER],
      }, { headers: AUTH });
      const rosterCall = h.fetchLog.find((e) =>
        e.url.includes("/rest/v1/class_enrollments")
      );
      assertExists(rosterCall);
      const query = decodeURIComponent(rosterCall!.url);
      // Without the class filter the roster is every enrollment in the
      // instance; without the role filter it includes co-teachers. Either one
      // alone lets an id the caller has no business reading survive the filter.
      assertEquals(query.includes(`class_id=eq.${CLASS_ID}`), true);
      assertEquals(query.includes("role=eq.student"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "derive-group-weaknesses: a group with nobody enrolled reports insufficient data instead of querying",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        groupRoute(),
        groupMembersRoute([OUTSIDER]),
        enrollmentRoute([]),
        ...signalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        group_id: GROUP_ID,
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.insufficient_data, true);
      assertEquals(body.suggested_difficulty, null);
      assertEquals(body.overall.member_count, 0);
      assertEquals(body.weak_competencies, []);
      assertEquals(h.fetchLog.some((e) => e.url.includes("/rest/v1/quiz_answers")), false);
    } finally {
      h.cleanup();
    }
  },
});

// ── Aggregation wiring ─────────────────────────────────────────────────

/**
 * Two members with both MCQ and evaluation signal across two competencies.
 * comp-a: 1/4 correct and eval scores 40/30 → mastery 30.
 * comp-b: 2/2 correct and eval score 90    → mastery 95.
 * Overall 3/6 correct → 50% → "medium" (the easy/medium boundary).
 */
function fullSignalRoutes(): MockRoute[] {
  return [
    supabaseRoute("/rest/v1/quiz_answers", [
      { user_id: STUDENT_A, is_correct: false, question_id: "q-1" },
      { user_id: STUDENT_B, is_correct: false, question_id: "q-1" },
      { user_id: STUDENT_A, is_correct: true, question_id: "q-2" },
      { user_id: STUDENT_B, is_correct: true, question_id: "q-2" },
      { user_id: STUDENT_A, is_correct: false, question_id: "q-3" },
      { user_id: STUDENT_B, is_correct: true, question_id: "q-3" },
    ]),
    supabaseRoute("/rest/v1/question_competencies", [
      { question_id: "q-1", competency_id: "comp-a" },
      { question_id: "q-3", competency_id: "comp-a" },
      { question_id: "q-2", competency_id: "comp-b" },
    ]),
    // Newest first, as the handler's `.order(generated_at, desc)` returns them.
    supabaseRoute("/rest/v1/student_evaluations", [
      { id: "eval-a-new", user_id: STUDENT_A, generated_at: "2026-05-01T00:00:00Z" },
      { id: "eval-b", user_id: STUDENT_B, generated_at: "2026-04-01T00:00:00Z" },
      { id: "eval-a-old", user_id: STUDENT_A, generated_at: "2026-01-01T00:00:00Z" },
    ]),
    supabaseRoute("/rest/v1/evaluation_competency_scores", [
      { evaluation_id: "eval-a-new", competency_id: "comp-a", score: 40 },
      { evaluation_id: "eval-b", competency_id: "comp-a", score: 30 },
      { evaluation_id: "eval-a-new", competency_id: "comp-b", score: 90 },
    ]),
    supabaseRoute("/rest/v1/course_competencies", [
      { id: "comp-a", title: "Fractions", chapter_id: "ch-1" },
      { id: "comp-b", title: "Decimals", chapter_id: null },
    ]),
    supabaseRoute("/rest/v1/competency_chapters", [
      { competency_id: "comp-a", chapter_id: "ch-2" },
    ]),
    supabaseRoute("/rest/v1/material_chapters", [
      { id: "ch-1", title: "Chapter 1 — Fractions" },
      { id: "ch-2", title: "Chapter 2 — Review" },
    ]),
  ];
}

Deno.test({
  name:
    "derive-group-weaknesses: a group_id resolves its members and returns weakest-first competencies with their chapters",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        groupRoute(),
        groupMembersRoute([STUDENT_A, STUDENT_B]),
        enrollmentRoute([STUDENT_A, STUDENT_B]),
        ...fullSignalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        group_id: GROUP_ID,
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.insufficient_data, false);
      assertEquals(body.overall, {
        member_count: 2,
        members_with_data: 2,
        total_answers: 6,
        correct_answers: 3,
        percent_correct: 50,
      });
      assertEquals(body.suggested_difficulty, "medium");

      assertEquals(body.weak_competencies.length, 2);
      const [weakest, strongest] = body.weak_competencies;
      assertEquals(weakest.competency_id, "comp-a");
      assertEquals(weakest.mastery, 30);
      assertEquals(weakest.eval_avg, 35);
      assertEquals(weakest.mcq_correct, 1);
      assertEquals(weakest.mcq_total, 4);
      // The direct `chapter_id` column and the competency_chapters junction are
      // both sources; the response carries the union, resolved to titles.
      assertEquals(weakest.chapters.map((c: { id: string }) => c.id), ["ch-1", "ch-2"]);
      assertEquals(weakest.chapters[0].title, "Chapter 1 — Fractions");
      assertEquals(strongest.competency_id, "comp-b");
      assertEquals(strongest.mastery, 95);
      assertEquals(strongest.chapters, []);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: only each member's latest evaluation is scored",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        enrollmentRoute([STUDENT_A, STUDENT_B]),
        ...fullSignalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A, STUDENT_B],
      }, { headers: AUTH });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);
      const scoresCall = h.fetchLog.find((e) =>
        e.url.includes("/rest/v1/evaluation_competency_scores")
      );
      assertExists(scoresCall);
      assertEquals(scoresCall!.url.includes("eval-a-new"), true);
      // A superseded evaluation would drag stale competency scores into the
      // group's picture.
      assertEquals(scoresCall!.url.includes("eval-a-old"), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: duplicate member_user_ids are counted once",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        enrollmentRoute([STUDENT_A, STUDENT_B]),
        ...fullSignalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A, STUDENT_A, STUDENT_B],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.overall.member_count, 2);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: top_n is clamped to 1..10",
  ...OPTS,
  async fn() {
    // Twelve competencies, each exercised by one wrong answer, so every one of
    // them is a candidate and only the clamp decides how many come back.
    const ids = Array.from({ length: 12 }, (_, i) => `comp-${String(i).padStart(2, "0")}`);
    const wideRoutes: MockRoute[] = [
      supabaseRoute(
        "/rest/v1/quiz_answers",
        ids.map((id) => ({ user_id: STUDENT_A, is_correct: false, question_id: `q-${id}` })),
      ),
      supabaseRoute(
        "/rest/v1/question_competencies",
        ids.map((id) => ({ question_id: `q-${id}`, competency_id: id })),
      ),
      supabaseRoute("/rest/v1/student_evaluations", []),
      supabaseRoute("/rest/v1/evaluation_competency_scores", []),
      supabaseRoute(
        "/rest/v1/course_competencies",
        ids.map((id) => ({ id, title: id, chapter_id: null })),
      ),
      supabaseRoute("/rest/v1/competency_chapters", []),
      supabaseRoute("/rest/v1/material_chapters", []),
    ];

    for (const [topN, expected] of [[99, 10], [0, 1], [-5, 1], [4, 4]] as const) {
      const h = createTestHarness({
        routes: [callerRoute, offeringRoute(), enrollmentRoute([STUDENT_A]), ...wideRoutes],
      });
      try {
        const res = await h.invoke(handler, {
          offering_id: OFFERING_ID,
          member_user_ids: [STUDENT_A],
          top_n: topN,
        }, { headers: AUTH });
        const { status, body } = await parseResponse(res);
        assertEquals(status, 200);
        assertEquals(body.weak_competencies.length, expected);
      } finally {
        h.cleanup();
      }
    }
  },
});

// ── Failure handling ───────────────────────────────────────────────────

Deno.test({
  name: "derive-group-weaknesses: 500 when a downstream read fails, without echoing rows",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        callerRoute,
        offeringRoute(),
        enrollmentRoute([STUDENT_A]),
        supabaseRoute(
          "/rest/v1/quiz_answers",
          { message: "relation \"quiz_answers\" does not exist" },
          { status: 500 },
        ),
        ...signalRoutes(),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: OFFERING_ID,
        member_user_ids: [STUDENT_A],
      }, { headers: AUTH });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertExists(body.error);
      assertEquals(body.weak_competencies, undefined);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "derive-group-weaknesses: 500 on a malformed JSON body rather than an unhandled throw",
  ...OPTS,
  async fn() {
    const h = createTestHarness();
    try {
      const res = await handler(
        new Request("http://localhost/functions/v1/derive-group-weaknesses", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...AUTH },
          body: "{not json",
        }),
      );
      const { status, body } = await parseResponse(res);
      assertEquals(status, 500);
      assertExists(body.error);
    } finally {
      h.cleanup();
    }
  },
});
