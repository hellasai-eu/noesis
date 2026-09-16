import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, MockRoute } from "../handler-harness.ts";
import { verifyQuestionEnrollment } from "../../verify-question-enrollment.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Group targeting (#1158) ────────────────────────────────────────────
// `offering_questions.group_id` publishes a question to one group within a
// class rather than the whole class. The helper filtered on `published_at` and
// then authorized anyone enrolled in the offering's class, so a student outside
// the targeted group was treated as entitled.
//
// It is the single definition of "entitled to this question" — its own docblock
// says every grader goes through it rather than re-inlining the check — so the
// rule belongs here and all three callers inherit it:
// `submit-open-answer`, `grade-deterministic-answer` and the open-question
// tutoring subject (`_shared/chat-subjects/open-question.ts`).

const USER_ID = "99999999-9999-9999-9999-999999999999";
const QUESTION_ID = "44444444-4444-4444-4444-444444444444";
const GROUP_ID = "77777777-7777-7777-7777-777777777777";

function client() {
  return createClient("http://localhost:54321", "test-service-role-key", {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** A published `offering_questions` row, optionally targeted at a group. */
function offeringRoute(groupId: string | null): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/offering_questions"),
    respond: () =>
      new Response(
        JSON.stringify([
          {
            offering_id: "off-1",
            group_id: groupId,
            offerings: { id: "off-1", class_id: "class-1" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

const ENROLLED: MockRoute = {
  match: (url) => url.includes("/rest/v1/class_enrollments"),
  respond: () =>
    new Response(JSON.stringify([{ class_id: "class-1" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
};

/** The caller's memberships among the queried groups. */
function groupMemberRoute(groups: string[]): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/offering_group_members"),
    respond: () =>
      new Response(JSON.stringify(groups.map((g) => ({ group_id: g }))), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

Deno.test("verifyQuestionEnrollment: a class-wide question needs no group membership", async () => {
  // `group_id` null means the whole class. The membership table must not even
  // be consulted — asserted by leaving it unmocked.
  const h = createTestHarness({ routes: [offeringRoute(null), ENROLLED] });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, true);
    assertEquals(
      h.fetchLog.some((c) => c.url.includes("offering_group_members")),
      false,
    );
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: a group-targeted question refuses a non-member", async () => {
  // The caller is enrolled in the class — which used to be the whole check —
  // but is not in the group the question was published to.
  const h = createTestHarness({
    routes: [offeringRoute(GROUP_ID), ENROLLED, groupMemberRoute([])],
  });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 403);
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: a group-targeted question allows a member", async () => {
  const h = createTestHarness({
    routes: [offeringRoute(GROUP_ID), ENROLLED, groupMemberRoute([GROUP_ID])],
  });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, true);
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: a failed membership check is not a denial", async () => {
  // A database fault reported as 403 would name a legitimate group member as an
  // intruder. Still refuses, but as a 500 the caller can retry.
  const h = createTestHarness({
    routes: [
      offeringRoute(GROUP_ID),
      ENROLLED,
      {
        match: (url) => url.includes("/rest/v1/offering_group_members"),
        respond: () =>
          new Response(JSON.stringify({ message: "connection reset" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ],
  });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 500);
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: membership is checked for the CALLER, not just the group", async () => {
  const h = createTestHarness({
    routes: [offeringRoute(GROUP_ID), ENROLLED, groupMemberRoute([GROUP_ID])],
  });
  try {
    await verifyQuestionEnrollment(client(), { questionId: QUESTION_ID, userId: USER_ID });
    const call = h.fetchLog.find((c) => c.url.includes("offering_group_members"));
    assertEquals(call?.url.includes(USER_ID), true);
    assertEquals(call?.url.includes(GROUP_ID), true);
  } finally {
    h.cleanup();
  }
});


// ── Several targets in one class (greptile, #1159) ─────────────────────
// A question can be published to the same class more than once — class-wide and
// to a group, or to two groups. Keeping one row per class would refuse a
// learner entitled by any of the others, so entitlement asks whether ANY target
// reaches them.

const OTHER_GROUP_ID = "66666666-6666-6666-6666-666666666666";

/** Several published rows for the same class. */
function multiTargetRoute(groupIds: Array<string | null>): MockRoute {
  return {
    match: (url) => url.includes("/rest/v1/offering_questions"),
    respond: () =>
      new Response(
        JSON.stringify(
          groupIds.map((g, i) => ({
            offering_id: `off-${i + 1}`,
            group_id: g,
            offerings: { id: `off-${i + 1}`, class_id: "class-1" },
          })),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
}

Deno.test("verifyQuestionEnrollment: a class-wide target entitles even when a group target is newer", async () => {
  // The newest row is group-scoped and the caller is not in it, but the same
  // question is also published to the whole class. Collapsing to the newest
  // would have refused them.
  const h = createTestHarness({
    routes: [multiTargetRoute([GROUP_ID, null]), ENROLLED],
  });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, true);
    // A class-wide target settles it, so membership is never consulted.
    assertEquals(
      h.fetchLog.some((c) => c.url.includes("offering_group_members")),
      false,
    );
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: membership in the SECOND of two groups entitles", async () => {
  const h = createTestHarness({
    routes: [
      multiTargetRoute([GROUP_ID, OTHER_GROUP_ID]),
      ENROLLED,
      groupMemberRoute([OTHER_GROUP_ID]),
    ],
  });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, true);
    // ...and the offering returned is the one that actually entitled them.
    if (result.ok) assertEquals(result.offeringId, "off-2");
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: membership in neither group still refuses", async () => {
  const h = createTestHarness({
    routes: [
      multiTargetRoute([GROUP_ID, OTHER_GROUP_ID]),
      ENROLLED,
      groupMemberRoute([]),
    ],
  });
  try {
    const result = await verifyQuestionEnrollment(client(), {
      questionId: QUESTION_ID,
      userId: USER_ID,
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.status, 403);
  } finally {
    h.cleanup();
  }
});

Deno.test("verifyQuestionEnrollment: the membership query asks about every targeted group", async () => {
  // One round-trip for all of them, not one per target.
  const h = createTestHarness({
    routes: [
      multiTargetRoute([GROUP_ID, OTHER_GROUP_ID]),
      ENROLLED,
      groupMemberRoute([]),
    ],
  });
  try {
    await verifyQuestionEnrollment(client(), { questionId: QUESTION_ID, userId: USER_ID });
    const calls = h.fetchLog.filter((c) => c.url.includes("offering_group_members"));
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url.includes(GROUP_ID), true);
    assertEquals(calls[0].url.includes(OTHER_GROUP_ID), true);
  } finally {
    h.cleanup();
  }
});
