/**
 * Tests for the instructor-driven study guide generation functions (#1004).
 *
 * The behaviours worth pinning are the ones that distinguish this flow from the
 * job it replaced:
 *
 *  - every call polls UNDER the edge function's wall-clock cap, which is the
 *    bug that made the job version fail partially;
 *  - the outline call writes only skeleton pieces, never theory or questions;
 *  - the questions call is grounded in the STORED theory and refuses when there
 *    is none, because the instructor may have rewritten it.
 *
 * Question conversion is covered exhaustively in `study-guide-questions.test.ts`.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { createTestHarness, type MockRoute } from "./handler-harness.ts";
import {
  MAX_PIECES,
  MAX_QUESTIONS_PER_PIECE,
  STUDY_GUIDE_MAX_POLL_MS,
} from "../study-guide-generation.ts";
import { modelFor } from "../model-policy.ts";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

const GUIDE_ID = "guide-1";
const PIECE_ID = "piece-1";
const COURSE_ID = "course-1";

function responsesEnvelope(payload: unknown) {
  return {
    id: "resp-1",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

interface State {
  insertedPieces: Array<Record<string, unknown>>;
  theoryUpdates: Array<Record<string, unknown>>;
  rpcCalls: Array<{ name: string; body: Record<string, unknown> }>;
  theoryHtml: string | null;
}

function newState(theoryHtml: string | null = null): State {
  return { insertedPieces: [], theoryUpdates: [], rpcCalls: [], theoryHtml };
}

function mcq(question: string) {
  return {
    type: "mcq",
    question,
    difficulty: "medium",
    explanation: "because",
    competency_id: null,
    mcq_options: ["A", "B", "C"],
    mcq_correct_indices: [0],
    open_model_answer: null,
    fill_gaps_stem: null,
    fill_gaps_gaps: null,
    ordering_prompt: null,
    ordering_items: null,
    classification_prompt: null,
    classification_categories: null,
    classification_items: null,
  };
}

function mcqAt(question: string, difficulty: string) {
  return { ...mcq(question), difficulty };
}

function openQ(question: string) {
  return { ...mcq(question), type: "open", mcq_options: null, mcq_correct_indices: null, open_model_answer: "an answer" };
}

function routes(state: State, openaiPayload: unknown): MockRoute[] {
  return [
    {
      match: (url) => url.includes("/rest/v1/rpc/"),
      respond: (url, init) => {
        const name = url.split("/rpc/")[1].split("?")[0];
        state.rpcCalls.push({ name, body: JSON.parse(String(init?.body ?? "{}")) });
        const payload = name === "replace_study_guide_piece_questions"
          ? ["q-1", "q-2"]
          : name === "replace_study_guide_outline"
            ? [
                { id: "piece-0", position: 0, title: "What heat is", theory_html: null },
                { id: "piece-1", position: 1, title: "Entropy", theory_html: null },
              ]
            : [];
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
    {
      match: (url) => url.includes("/auth/v1/user"),
      respond: () =>
        new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      match: (url, init) =>
        url.includes("/rest/v1/study_guide_pieces") &&
        (init?.method ?? "GET").toUpperCase() === "POST",
      respond: (_url, init) => {
        const rows = JSON.parse(String(init?.body ?? "[]")) as Array<Record<string, unknown>>;
        state.insertedPieces.push(...rows);
        return new Response(
          JSON.stringify(rows.map((r) => ({ id: `piece-${r.position}`, position: r.position, title: r.title }))),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    },
    {
      match: (url, init) =>
        url.includes("/rest/v1/study_guide_pieces") &&
        (init?.method ?? "GET").toUpperCase() === "PATCH",
      respond: (_url, init) => {
        state.theoryUpdates.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(null, { status: 204 });
      },
    },
    {
      match: (url) => url.includes("/rest/v1/study_guide_pieces"),
      respond: (url) =>
        new Response(
          JSON.stringify(
            url.includes("study_guide_id=eq.")
              ? [{ id: PIECE_ID, study_guide_id: GUIDE_ID, position: 0, title: "Heat", theory_html: state.theoryHtml }]
              : { id: PIECE_ID, study_guide_id: GUIDE_ID, position: 0, title: "Heat", theory_html: state.theoryHtml },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
    {
      match: (url) => url.includes("/rest/v1/study_guide_source_chapters"),
      respond: () =>
        new Response(JSON.stringify([{ chapter_id: "chap-1" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      match: (url) => url.includes("/rest/v1/study_guides"),
      respond: () =>
        new Response(
          JSON.stringify({
            id: GUIDE_ID,
            course_id: COURSE_ID,
            material_id: "mat-1",
            title: "Thermo",
            brief: "focus on entropy",
            target_piece_count: 3,
            target_questions_per_piece: 4,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
    {
      match: (url) => url.includes("/rest/v1/material_chapters"),
      respond: () =>
        new Response(
          JSON.stringify([
            { id: "chap-1", chapter_number: 1, title: "Heat", openai_file_id: "file-1", material_id: "mat-1" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    },
    {
      match: (url) => url.includes("/rest/v1/course_materials"),
      respond: () =>
        new Response(JSON.stringify({ title: "Physics", file_name: "p.pdf", openai_file_id: "file-mat" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      match: (url) => url.includes("/rest/v1/course_competencies"),
      respond: () =>
        new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } }),
    },
    {
      match: (url) => url.includes("/rest/v1/course_instructors"),
      respond: () =>
        new Response(JSON.stringify({ user_id: "user-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      match: (url) => url.includes("/rest/v1/courses"),
      respond: () =>
        new Response(JSON.stringify({ id: COURSE_ID, title: "Physics", institution_id: "inst-1", language: "en" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      // A live (non-suspended) membership. `isAuthorizedCourseManager` now goes
      // through `institution-authz.ts`, which checks membership BEFORE the
      // course assignment — `course_instructors` has no suspension column, so
      // an assignment on its own is not evidence of access (#1152).
      match: (url) => url.includes("/rest/v1/user_institutions"),
      respond: () =>
        new Response(JSON.stringify({ is_suspended: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      match: (url) => url.includes("api.openai.com"),
      respond: () =>
        new Response(JSON.stringify(responsesEnvelope(openaiPayload)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  ];
}

function post(body: unknown): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── configuration ──────────────────────────────────────────────────────

Deno.test("poll ceiling stays under the edge function wall-clock cap", () => {
  // The job version polled for 240s against a ~180s platform cap: a long call
  // had its isolate killed, the item was retried and eventually failed, while
  // faster pieces succeeded — a partially_completed job with a NULL error.
  // Synchronous calls cannot outlive the request, so this must stay below it.
  assert(
    STUDY_GUIDE_MAX_POLL_MS < 180_000,
    `poll ceiling ${STUDY_GUIDE_MAX_POLL_MS}ms must be under the ~180s edge function cap`,
  );
  assertEquals(MAX_PIECES, 20);
});

Deno.test("study guide policies name a GPT-5.6 tier explicitly", () => {
  // Bare "gpt-5.6" is an alias for Sol, so a policy entry that drops the suffix
  // silently buys the most expensive tier instead of failing. Asserted on the
  // registry now that model choice lives there.
  const outline = modelFor("study-guide.outline");
  const theory = modelFor("study-guide.theory");
  const questions = modelFor("study-guide.questions");

  assertEquals(outline.model, "gpt-5.6-sol");
  assertEquals(theory.model, "gpt-5.6-terra");
  assertEquals(questions.model, "gpt-5.6-terra");

  // The premium is paid once per guide, not once per piece — the whole reason
  // the outline and the piece calls are on different tiers.
  assertEquals(outline.policy.modelTier, "flagship");
  assertEquals(theory.policy.modelTier, "balanced");
  assertEquals(questions.policy.modelTier, "balanced");

  // Depth for the piece calls comes from effort, not from the tier.
  assertEquals(outline.reasoningEffort, "high");
  assertEquals(theory.reasoningEffort, "high");
  assertEquals(questions.reasoningEffort, "high");
});

// ── outline ────────────────────────────────────────────────────────────

Deno.test({
  name: "outline writes skeleton pieces only — no theory, no questions",
  ...OPTS,
  async fn() {
    const state = newState();
    const h = createTestHarness({
      routes: routes(state, {
        pieces: [
          { title: "What heat is", scope: "define heat", chapter_hint: 1 },
          { title: "Entropy", scope: "introduce entropy", chapter_hint: 1 },
        ],
      }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-outline/handler.ts");
      const res = await handler(post({ studyGuideId: GUIDE_ID }));
      assertEquals(res.status, 200);

      // The replacement goes through one atomic RPC, never a bare insert:
      // clearing first and then calling the model left the guide permanently
      // empty whenever the call failed.
      const replace = state.rpcCalls.find((c) => c.name === "replace_study_guide_outline");
      assert(replace, "expected replace_study_guide_outline to be called");
      assertEquals(replace.body._pieces, [{ title: "What heat is" }, { title: "Entropy" }]);
      assertEquals(state.insertedPieces.length, 0);

      // Nothing is cleared before the model answers.
      assertEquals(state.rpcCalls.some((c) => c.name === "clear_study_guide_pieces"), false);
      // And no questions are written by this stage — theory comes first.
      assertEquals(
        state.rpcCalls.some((c) => c.name === "replace_study_guide_piece_questions"),
        false,
      );

      const openai = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assert(openai, "expected an OpenAI call");
      const body = JSON.parse(openai.body ?? "{}");
      assertEquals(body.model, modelFor("study-guide.outline").model);
      assertEquals(body.reasoning?.effort, "high");
      assertEquals(body.text?.format?.name, "study_guide_outline");
    } finally {
      h.cleanup();
    }
  },
});

// ── questions ──────────────────────────────────────────────────────────

Deno.test({
  name: "questions refuse when the piece has no theory yet",
  ...OPTS,
  async fn() {
    const state = newState(null);
    const h = createTestHarness({ routes: routes(state, { questions: [] }) });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(post({ pieceId: PIECE_ID }));
      // Questions are generated FROM the theory, so there is nothing to do.
      assertEquals(res.status, 409);
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "questions are grounded in the stored theory, not the source PDF alone",
  ...OPTS,
  async fn() {
    const marker = "Entropy always increases in an isolated system, said the instructor.";
    const state = newState(`<p>${marker}</p>`);
    const h = createTestHarness({
      routes: routes(state, {
        questions: [
          {
            type: "mcq",
            question: "What increases?",
            difficulty: "medium",
            explanation: "because",
            competency_id: null,
            mcq_options: ["Entropy", "Enthalpy", "Mass"],
            mcq_correct_indices: [0],
            open_model_answer: null,
            fill_gaps_stem: null,
            fill_gaps_gaps: null,
            ordering_prompt: null,
            ordering_items: null,
            classification_prompt: null,
            classification_categories: null,
            classification_items: null,
          },
        ],
      }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(post({ pieceId: PIECE_ID }));
      assertEquals(res.status, 200);

      const openai = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assert(openai, "expected an OpenAI call");
      // The instructor's edited text must reach the model verbatim — that is
      // the whole reason questions are a separate stage.
      assert(
        (openai.body ?? "").includes(marker),
        "the stored theory must be sent as the basis for the questions",
      );

      // And the write goes through the atomic RPC, never row-by-row.
      assertEquals(
        state.rpcCalls.some((c) => c.name === "replace_study_guide_piece_questions"),
        true,
      );
    } finally {
      h.cleanup();
    }
  },
});

// ── theory customization ───────────────────────────────────────────────

Deno.test({
  name: "theory: instructor special instructions reach the prompt only when given",
  ...OPTS,
  async fn() {
    const instruction = "Use simpler language and open with a kitchen example.";
    const state = newState(null);
    const h = createTestHarness({
      routes: routes(state, { theory_html: "<p>Heat flows from hot to cold.</p>" }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-theory/handler.ts");

      const res = await handler(post({ pieceId: PIECE_ID, specialInstructions: instruction }));
      assertEquals(res.status, 200);
      const withBody = h.fetchLog.find((e) => e.url.includes("api.openai.com"))?.body ?? "";
      assert(withBody.includes(instruction), "the instructor's instructions must reach the model");

      // A blank field leaves no residue: the wrapper sentence would otherwise
      // tell the model to follow instructions that do not exist.
      const before = h.fetchLog.length;
      const res2 = await handler(post({ pieceId: PIECE_ID, specialInstructions: "   " }));
      assertEquals(res2.status, 200);
      const plainBody =
        h.fetchLog.slice(before).find((e) => e.url.includes("api.openai.com"))?.body ?? "";
      assert(
        !plainBody.includes("special instructions"),
        "no instruction wrapper when the field is blank",
      );
      assert(plainBody.includes("Produce the theory HTML"), "prompt otherwise intact");

      // Oversized instructions are refused before any model call is paid for.
      const openaiCalls = h.fetchLog.filter((e) => e.url.includes("api.openai.com")).length;
      const resLong = await handler(
        post({ pieceId: PIECE_ID, specialInstructions: "x".repeat(2001) }),
      );
      assertEquals(resLong.status, 400);
      assertEquals(
        h.fetchLog.filter((e) => e.url.includes("api.openai.com")).length,
        openaiCalls,
      );
    } finally {
      h.cleanup();
    }
  },
});

// ── instructor-pinned generation shape (#1006) ─────────────────────────

Deno.test({
  name: "a pinned type reaches the prompt and off-type questions are discarded",
  ...OPTS,
  async fn() {
    const state = newState("<p>Some theory long enough to pass the minimum length check.</p>");
    // The model ignores the instruction and returns one open question.
    const h = createTestHarness({
      routes: routes(state, { questions: [mcq("kept"), openQ("wrong type")] }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(
        new Request("http://localhost/", {
          method: "POST",
          headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
          // Difficulty deliberately left mixed: this test isolates TYPE
          // enforcement, and pinning both would let a difficulty rejection
          // masquerade as a type rejection.
          body: JSON.stringify({ pieceId: PIECE_ID, questionType: "mcq", count: 3 }),
        }),
      );
      assertEquals(res.status, 200);
      const body = await res.json();

      // Assert on what reached the WRITE, not on the mocked RPC's return value:
      // the fake echoes a fixed id list regardless of input, so `inserted`
      // would pass whatever the filter did.
      const write = state.rpcCalls.find((c) => c.name === "replace_study_guide_piece_questions");
      assert(write, "expected the questions to be written");
      const written = write.body._questions as Array<{ type: string }>;
      assertEquals(written.length, 1);
      assertEquals(written[0].type, "mcq");

      // Enforced, not merely requested: keeping the off-type question would
      // make the control advisory.
      assertEquals(body.rejected, 1);

      const openai = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assert(openai, "expected an OpenAI call");
      const sent = openai.body ?? "";
      assert(sent.includes("EVERY question must be multiple choice"), "type instruction missing");
      assert(sent.includes("Number of questions to produce: 3"), "count not passed through");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "omitting the shape keeps the model choosing, as before",
  ...OPTS,
  async fn() {
    const state = newState("<p>Some theory long enough to pass the minimum length check.</p>");
    const h = createTestHarness({
      routes: routes(state, { questions: [mcq("a"), openQ("b")] }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(
        new Request("http://localhost/", {
          method: "POST",
          headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
          body: JSON.stringify({ pieceId: PIECE_ID }),
        }),
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      // Both survive: nothing was pinned.
      const write = state.rpcCalls.find((c) => c.name === "replace_study_guide_piece_questions");
      assert(write, "expected the questions to be written");
      assertEquals((write.body._questions as unknown[]).length, 2);
      assertEquals(body.rejected, 0);

      const openai = h.fetchLog.find((e) => e.url.includes("api.openai.com"));
      assert((openai?.body ?? "").includes("your choice"), "expected the free-choice instruction");
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "an unsupported type or difficulty is rejected before any model call",
  ...OPTS,
  async fn() {
    const state = newState("<p>Some theory long enough to pass the minimum length check.</p>");
    const h = createTestHarness({ routes: routes(state, { questions: [] }) });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      for (const body of [{ questionType: "essay" }, { difficulty: "brutal" }]) {
        const res = await handler(
          new Request("http://localhost/", {
            method: "POST",
            headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
            body: JSON.stringify({ pieceId: PIECE_ID, ...body }),
          }),
        );
        assertEquals(res.status, 400);
      }
      assertEquals(h.fetchLog.some((e) => e.url.includes("api.openai.com")), false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "a pinned difficulty is enforced too, not just the type",
  ...OPTS,
  async fn() {
    const state = newState("<p>Some theory long enough to pass the minimum length check.</p>");
    const h = createTestHarness({
      routes: routes(state, {
        questions: [mcqAt("right", "hard"), mcqAt("wrong difficulty", "easy")],
      }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(
        new Request("http://localhost/", {
          method: "POST",
          headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
          body: JSON.stringify({ pieceId: PIECE_ID, questionType: "mcq", difficulty: "hard" }),
        }),
      );
      assertEquals(res.status, 200);

      // Rejected rather than relabelled: writing "hard" onto an easy question
      // would put a false difficulty into the data analytics reads.
      const write = state.rpcCalls.find((c) => c.name === "replace_study_guide_piece_questions");
      assert(write, "expected the questions to be written");
      const written = write.body._questions as Array<{ difficulty: string }>;
      assertEquals(written.length, 1);
      assertEquals(written[0].difficulty, "hard");

      const body = await res.json();
      assertEquals(body.rejected, 1);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "the count applies to accepted questions, not to raw model output",
  ...OPTS,
  async fn() {
    const state = newState("<p>Some theory long enough to pass the minimum length check.</p>");
    // Two unusable questions first, then three good ones. Capping the raw array
    // at the requested count would have considered only the first two and
    // returned an empty batch.
    const h = createTestHarness({
      routes: routes(state, {
        questions: [openQ("wrong type"), openQ("also wrong"), mcq("a"), mcq("b"), mcq("c")],
      }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(
        new Request("http://localhost/", {
          method: "POST",
          headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
          body: JSON.stringify({ pieceId: PIECE_ID, questionType: "mcq", count: 2 }),
        }),
      );
      assertEquals(res.status, 200);

      const write = state.rpcCalls.find((c) => c.name === "replace_study_guide_piece_questions");
      assert(write, "expected the questions to be written");
      const written = write.body._questions as Array<{ question: string }>;
      assertEquals(written.length, 2);
      assertEquals(written.map((w) => w.question), ["a", "b"]);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "valid questions past MAX_QUESTIONS_PER_PIECE are still reachable",
  ...OPTS,
  async fn() {
    const state = newState("<p>Some theory long enough to pass the minimum length check.</p>");
    // The scan is bounded by how many have been ACCEPTED, not by position, so
    // a long run of unusable output at the front cannot starve the batch.
    const junk = Array.from({ length: MAX_QUESTIONS_PER_PIECE + 5 }, (_, i) => openQ(`junk ${i}`));
    const h = createTestHarness({
      routes: routes(state, { questions: [...junk, mcq("survivor")] }),
    });
    try {
      const { handler } = await import("../../generate-study-guide-questions/handler.ts");
      const res = await handler(
        new Request("http://localhost/", {
          method: "POST",
          headers: { authorization: "Bearer tok", "Content-Type": "application/json" },
          body: JSON.stringify({ pieceId: PIECE_ID, questionType: "mcq", count: 1 }),
        }),
      );
      assertEquals(res.status, 200);

      const write = state.rpcCalls.find((c) => c.name === "replace_study_guide_piece_questions");
      assert(write, "expected the questions to be written");
      const written = write.body._questions as Array<{ question: string }>;
      assertEquals(written.map((w) => w.question), ["survivor"]);
    } finally {
      h.cleanup();
    }
  },
});


// ── Suspension (#1152) ─────────────────────────────────────────────────
// `isAuthorizedCourseManager` used to read `user_institutions.role` directly
// and to accept a bare `course_instructors` row. Neither excludes a suspended
// member — and `course_instructors` has no suspension column, so an assignment
// survives suspension intact. These handlers run on the service-role key, so
// RLS never evaluates and this check is the only boundary.

/** Swap a route in `routes()` for one that answers differently. */
function withRoute(base: MockRoute[], pattern: string, respond: MockRoute["respond"]): MockRoute[] {
  return [{ match: (url: string) => url.includes(pattern), respond }, ...base];
}

/** Did the handler reach OpenAI? */
function calledOpenAI(fetchLog: Array<{ url: string }>): boolean {
  return fetchLog.some((c) => c.url.includes("api.openai.com"));
}

const SUSPENDED_CASES: Array<{ name: string; module: string; body: unknown }> = [
  {
    name: "generate-study-guide-outline",
    module: "../../generate-study-guide-outline/handler.ts",
    body: { studyGuideId: GUIDE_ID },
  },
  {
    name: "generate-study-guide-theory",
    module: "../../generate-study-guide-theory/handler.ts",
    body: { pieceId: PIECE_ID },
  },
  {
    name: "generate-study-guide-questions",
    module: "../../generate-study-guide-questions/handler.ts",
    body: { pieceId: PIECE_ID },
  },
];

for (const c of SUSPENDED_CASES) {
  Deno.test({
    name: `${c.name}: a suspended member is refused despite a course assignment`,
    ...OPTS,
    async fn() {
      const state = newState();
      const h = createTestHarness({
        routes: withRoute(
          routes(state, { pieces: [], questions: [] }),
          "/rest/v1/user_institutions",
          () =>
            new Response(JSON.stringify({ is_suspended: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      });
      try {
        const { handler } = await import(c.module);
        const res = await handler(post(c.body));
        assertEquals(res.status, 403);
        assertEquals(calledOpenAI(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });

  Deno.test({
    name: `${c.name}: a member who has left the institution is refused`,
    ...OPTS,
    async fn() {
      // No `user_institutions` row at all, but the `course_instructors`
      // assignment is still there — the state the old code accepted.
      const state = newState();
      const h = createTestHarness({
        routes: withRoute(
          routes(state, { pieces: [], questions: [] }),
          "/rest/v1/user_institutions",
          () =>
            new Response("null", {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        ),
      });
      try {
        const { handler } = await import(c.module);
        const res = await handler(post(c.body));
        assertEquals(res.status, 403);
        assertEquals(calledOpenAI(h.fetchLog), false);
      } finally {
        h.cleanup();
      }
    },
  });
}

Deno.test({
  name: "generate-study-guide-outline: a non-suspended institution admin is allowed",
  ...OPTS,
  async fn() {
    // The admin path, which used to be a raw `role === "admin"` read. Nothing
    // else needs to match: `is_institution_admin` ORs in super-admin and
    // excludes suspended members, so it is the whole rule.
    const state = newState();
    const h = createTestHarness({
      routes: withRoute(
        withRoute(
          routes(state, { pieces: [{ title: "T", scope: "s", chapter_hint: 1 }] }),
          "/rest/v1/rpc/is_institution_admin",
          () => new Response("true", { status: 200, headers: { "Content-Type": "application/json" } }),
        ),
        "/rest/v1/course_instructors",
        () => new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    });
    try {
      const { handler } = await import("../../generate-study-guide-outline/handler.ts");
      const res = await handler(post({ studyGuideId: GUIDE_ID }));
      assertEquals(res.status, 200);
    } finally {
      h.cleanup();
    }
  },
});
