import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  openaiRoute,
  parseResponse,
  supabaseRoute,
} from "../handler-harness.ts";
import { handler } from "../../../cluster-students-by-performance/handler.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

Deno.test("cluster-students-by-performance: OPTIONS returns CORS headers", async () => {
  const h = createTestHarness();
  try {
    const req = new Request("http://localhost/functions/v1/cluster-students-by-performance", {
      method: "OPTIONS",
    });
    const res = await handler(req);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    h.cleanup();
  }
});

Deno.test("cluster-students-by-performance: 400 when offering_id / class_id missing", async () => {
  const h = createTestHarness();
  try {
    const res = await h.invoke(handler, {});
    const { status } = await parseResponse(res);
    assertEquals(status, 400);
  } finally {
    h.cleanup();
  }
});

Deno.test({
  name: "cluster-students-by-performance: PII guardrail — student names from profiles are not forwarded to OpenAI (issue #557)",
  ...OPTS,
  async fn() {
    const NAME_SENTINEL = "Maria Karagianni-Leakedname";
    const aiResponse = {
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            groups: [
              {
                name: "Group A",
                rationale: "shared low fractions mastery",
                description: "This group needs fraction practice.",
                member_user_ids: ["S1", "S2", "S3"],
              },
            ],
          }),
        }],
      }],
      status: "completed",
    };

    const h = createTestHarness({
      routes: [
        supabaseRoute("/auth/v1/user", { id: "instr-1", email: "instr@test.local" }),
        supabaseRoute("/rest/v1/offerings", { id: "off-1", course_id: "course-1", class_id: "class-1" }),
        supabaseRoute("/rest/v1/class_enrollments", [
          { user_id: "user-1" },
          { user_id: "user-2" },
          { user_id: "user-3" },
        ]),
        supabaseRoute("/rest/v1/profiles", [
          { user_id: "user-1", full_name: NAME_SENTINEL },
          { user_id: "user-2", full_name: "John Doe" },
          { user_id: "user-3", full_name: "Anna Other" },
        ]),
        supabaseRoute("/rest/v1/quiz_answers", [
          { user_id: "user-1", is_correct: true, question_id: "q-1", questions: { difficulty: "easy" } },
          { user_id: "user-1", is_correct: false, question_id: "q-2", questions: { difficulty: "medium" } },
          { user_id: "user-2", is_correct: true, question_id: "q-1", questions: { difficulty: "easy" } },
          { user_id: "user-3", is_correct: false, question_id: "q-2", questions: { difficulty: "medium" } },
        ]),
        supabaseRoute("/rest/v1/question_competencies", []),
        supabaseRoute("/rest/v1/course_competencies", []),
        supabaseRoute("/rest/v1/student_evaluations", []),
        supabaseRoute("/rest/v1/offering_groups", []),
        openaiRoute("/v1/responses", aiResponse, { method: "POST" }),
      ],
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: "off-1",
        class_id: "class-1",
        target_group_count: 2,
      }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      // Response still carries names so the instructor UI can render them.
      const aliceGroup = body.groups?.[0]?.members?.find((m: any) => m.user_id === "user-1");
      assertExists(aliceGroup);
      assertEquals(aliceGroup.full_name, NAME_SENTINEL);

      // But the OpenAI request must NOT contain the name or any name-shaped key.
      const openAiCall = h.fetchLog.find(
        (e) => e.url.includes("api.openai.com") && e.method === "POST",
      );
      assertExists(openAiCall);
      assertEquals(openAiCall!.body!.includes(NAME_SENTINEL), false);
      assertEquals(openAiCall!.body!.includes("John Doe"), false);
      assertEquals(openAiCall!.body!.includes("Anna Other"), false);
      // The serialized studentSummaries[*] objects must not carry `name` /
      // `full_name` keys. student_id is the only learner identifier sent.
      const reqBody = JSON.parse(openAiCall!.body!);
      const userMsg = reqBody.input.find((m: any) => m.role === "user");
      assertExists(userMsg);
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : (userMsg.content as any[]).map((c) => c.text ?? "").join(" ");
      assertEquals(text.includes("\"name\""), false);
      assertEquals(text.includes("\"full_name\""), false);
      assertEquals(text.includes("\"student_id\""), true);
      // The learner identifier is an opaque alias, never the auth user id:
      // aliases are what the model sees and echoes back in member_user_ids.
      assertEquals(text.includes("user-1"), false);
      assertEquals(text.includes("user-2"), false);
      assertEquals(text.includes("user-3"), false);
      assertEquals(text.includes("\"S1\""), true);
    } finally {
      h.cleanup();
    }
  },
});

const AI_TWO_GROUPS = {
  output: [{
    type: "message",
    content: [{
      type: "output_text",
      text: JSON.stringify({
        groups: [
          {
            name: "Group A",
            rationale: "r",
            description: "d",
            member_user_ids: ["S1", "S2"],
          },
          {
            name: "Group B",
            rationale: "r",
            description: "d",
            member_user_ids: ["S3"],
          },
        ],
      }),
    }],
  }],
  status: "completed",
};

const baseRoutes = (existingGroups: unknown[]) => [
  supabaseRoute("/auth/v1/user", { id: "instr-1", email: "instr@test.local" }),
  supabaseRoute("/rest/v1/offerings", { id: "off-1", course_id: "course-1", class_id: "class-1" }),
  supabaseRoute("/rest/v1/class_enrollments", [
    { user_id: "user-1" },
    { user_id: "user-2" },
    { user_id: "user-3" },
  ]),
  supabaseRoute("/rest/v1/profiles", [
    { user_id: "user-1", full_name: "Maria Papadopoulou" },
    { user_id: "user-2", full_name: "John Doe" },
    { user_id: "user-3", full_name: "Anna Other" },
  ]),
  supabaseRoute("/rest/v1/quiz_answers", [
    { user_id: "user-1", is_correct: true, question_id: "q-1", questions: { difficulty: "easy" } },
    { user_id: "user-2", is_correct: true, question_id: "q-1", questions: { difficulty: "easy" } },
    { user_id: "user-3", is_correct: false, question_id: "q-2", questions: { difficulty: "medium" } },
  ]),
  supabaseRoute("/rest/v1/question_competencies", []),
  supabaseRoute("/rest/v1/course_competencies", []),
  supabaseRoute("/rest/v1/student_evaluations", []),
  supabaseRoute("/rest/v1/offering_groups", existingGroups),
  openaiRoute("/v1/responses", AI_TWO_GROUPS, { method: "POST" }),
];

function openAiUserMessage(h: ReturnType<typeof createTestHarness>): string {
  const call = h.fetchLog.find((e) => e.url.includes("api.openai.com") && e.method === "POST");
  assertExists(call);
  const reqBody = JSON.parse(call!.body!);
  const userMsg = reqBody.input.find((m: { role: string }) => m.role === "user");
  assertExists(userMsg);
  return typeof userMsg.content === "string"
    ? userMsg.content
    : (userMsg.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(" ");
}

Deno.test({
  name:
    "cluster-students-by-performance: existing groups are passed to the prompt (names redacted) and the count is a maximum defaulting to 5",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes([
        { name: "Fraction Stars", description: "Focus group led by John Doe" },
        { name: "Essay Circle", description: null },
      ]),
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: "off-1",
        class_id: "class-1",
      }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status } = await parseResponse(res);
      assertEquals(status, 200);

      const text = openAiUserMessage(h);
      // No count in the request → default maximum of 5.
      assertEquals(text.includes("Maximum number of groups: 5"), true);
      // Existing groups listed with the avoid-duplicates instruction.
      assertEquals(text.includes("Fraction Stars"), true);
      assertEquals(text.includes("Essay Circle"), true);
      assertEquals(text.includes("do not reuse an existing group's name"), true);
      // Roster names inside instructor-authored group text are redacted.
      assertEquals(text.includes("John"), false);
      assertEquals(text.includes("[student]"), true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "cluster-students-by-performance: avoid_existing_groups=false skips the offering_groups fetch, and excess AI groups are clamped to the maximum",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: baseRoutes([{ name: "Fraction Stars", description: "d" }]),
    });
    try {
      const res = await h.invoke(handler, {
        offering_id: "off-1",
        class_id: "class-1",
        max_group_count: 2,
        avoid_existing_groups: false,
      }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);

      // Existing groups were neither fetched nor mentioned in the prompt.
      assertEquals(
        h.fetchLog.some((e) => e.url.includes("/rest/v1/offering_groups")),
        false,
      );
      const text = openAiUserMessage(h);
      assertEquals(text.includes("Maximum number of groups: 2"), true);
      assertEquals(text.includes("Fraction Stars"), false);

      // AI returned 2 groups here; with max 2 both survive and nobody is dropped.
      assertEquals(body.groups.length, 2);
      assertEquals(body.unassigned.length, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name:
    "cluster-students-by-performance: empty or invalid AI groups do not consume the maximum-group cap",
  ...OPTS,
  async fn() {
    const withInvalidGroups = {
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            groups: [
              // Empty and unknown-ID groups come first; they must not crowd
              // out the valid groups below when the cap is 2.
              { name: "Empty", rationale: "r", description: "d", member_user_ids: [] },
              // "nobody" is an unknown alias token; "user-1" is a real user id,
              // which the model never sees and must therefore not map back.
              { name: "Ghosts", rationale: "r", description: "d", member_user_ids: ["nobody", "user-1"] },
              { name: "A", rationale: "r", description: "d", member_user_ids: ["S1", "S2"] },
              { name: "B", rationale: "r", description: "d", member_user_ids: ["S3"] },
            ],
          }),
        }],
      }],
      status: "completed",
    };
    const routes = baseRoutes([]);
    routes[routes.length - 1] = openaiRoute("/v1/responses", withInvalidGroups, { method: "POST" });
    const h = createTestHarness({ routes });
    try {
      const res = await h.invoke(handler, {
        offering_id: "off-1",
        class_id: "class-1",
        max_group_count: 2,
      }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(
        body.groups.map((g: { name: string }) => g.name),
        ["A", "B"],
      );
      assertEquals(body.unassigned.length, 0);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "cluster-students-by-performance: AI groups beyond the maximum are dropped and their members unassigned",
  ...OPTS,
  async fn() {
    const threeGroups = {
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            groups: [
              { name: "A", rationale: "r", description: "d", member_user_ids: ["S1"] },
              { name: "B", rationale: "r", description: "d", member_user_ids: ["S2"] },
              { name: "C", rationale: "r", description: "d", member_user_ids: ["S3"] },
            ],
          }),
        }],
      }],
      status: "completed",
    };
    const routes = baseRoutes([]);
    routes[routes.length - 1] = openaiRoute("/v1/responses", threeGroups, { method: "POST" });
    const h = createTestHarness({ routes });
    try {
      const res = await h.invoke(handler, {
        offering_id: "off-1",
        class_id: "class-1",
        max_group_count: 2,
      }, {
        headers: { authorization: "Bearer test-token" },
      });
      const { status, body } = await parseResponse(res);
      assertEquals(status, 200);
      assertEquals(body.groups.length, 2);
      assertEquals(
        body.unassigned.map((m: { user_id: string }) => m.user_id),
        ["user-3"],
      );
    } finally {
      h.cleanup();
    }
  },
});
