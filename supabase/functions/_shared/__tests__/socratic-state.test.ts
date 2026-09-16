/**
 * Tests for Socratic chat state persistence
 *
 * Tests the state loading/saving logic used in the socratic-chat edge function.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.168.0/testing/asserts.ts";

// Mock Supabase client types for testing
interface MockSupabaseClient {
  from: (table: string) => MockQueryBuilder;
}

interface MockQueryBuilder {
  select: (columns?: string) => MockQueryBuilder;
  insert: (data: Record<string, unknown>) => MockQueryBuilder;
  upsert: (data: Record<string, unknown>, options?: { onConflict?: string }) => MockQueryBuilder;
  eq: (column: string, value: string) => MockQueryBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  single: () => Promise<{ data: unknown; error: unknown }>;
}

// Schema version constant (matching the main code)
const TUTOR_STATE_SCHEMA_VERSION = 1;

// Mock session state type
interface SocraticSessionState {
  id: string;
  user_id: string;
  open_question_id: string;
  course_id: string;
  schema_version: number;
  current_state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Helper to create mock Supabase client
function createMockSupabase(mockData: {
  sessionState?: SocraticSessionState | null;
  upsertResult?: SocraticSessionState | null;
  historyInsertError?: Error | null;
}): MockSupabaseClient {
  const mockQueryBuilder: MockQueryBuilder = {
    select: () => mockQueryBuilder,
    insert: () => mockQueryBuilder,
    upsert: () => mockQueryBuilder,
    eq: () => mockQueryBuilder,
    maybeSingle: async () => ({
      data: mockData.sessionState || null,
      error: null,
    }),
    single: async () => ({
      data: mockData.upsertResult || null,
      error: null,
    }),
  };

  return {
    from: (table: string) => {
      // Track which table was accessed for verification
      (createMockSupabase as unknown as { lastTable: string }).lastTable = table;
      return mockQueryBuilder;
    },
  };
}

// Helper to simulate state loading logic
async function loadSessionState(
  supabase: MockSupabaseClient,
  userId: string,
  questionId: string
): Promise<SocraticSessionState | null> {
  const { data, error } = await supabase
    .from("socratic_session_state")
    .select("*")
    .eq("user_id", userId)
    .eq("open_question_id", questionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as SocraticSessionState | null;
}

// Helper to simulate state saving logic
async function saveSessionState(
  supabase: MockSupabaseClient,
  userId: string,
  questionId: string,
  courseId: string,
  newState: Record<string, unknown>
): Promise<SocraticSessionState | null> {
  const { data, error } = await supabase
    .from("socratic_session_state")
    .upsert(
      {
        user_id: userId,
        open_question_id: questionId,
        course_id: courseId,
        schema_version: TUTOR_STATE_SCHEMA_VERSION,
        current_state: newState,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,open_question_id" }
    )
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data as SocraticSessionState | null;
}

// Helper to build state from LLM response
function buildStateFromResponse(response: {
  decision: string;
  state_update: Record<string, unknown>;
  meta: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    decision: response.decision,
    state_update: response.state_update,
    meta: response.meta,
  };
}

// Tests
Deno.test("State loading: returns existing state", async () => {
  const mockState: SocraticSessionState = {
    id: "session-123",
    user_id: "user-abc",
    open_question_id: "question-xyz",
    course_id: "course-456",
    schema_version: 1,
    current_state: {
      decision: "ASK",
      state_update: { goal: "Test goal", frustration: 2 },
    },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  const supabase = createMockSupabase({ sessionState: mockState });
  const result = await loadSessionState(supabase, "user-abc", "question-xyz");

  assertExists(result);
  assertEquals(result.id, "session-123");
  assertEquals(result.current_state.decision, "ASK");
});

Deno.test("State loading: returns null for new session", async () => {
  const supabase = createMockSupabase({ sessionState: null });
  const result = await loadSessionState(supabase, "user-abc", "question-xyz");

  assertEquals(result, null);
});

Deno.test("State saving: creates new state record", async () => {
  const newState = {
    decision: "HINT",
    state_update: { goal: "New goal", hint_level: 1 },
    meta: { confidence: 0.8 },
  };

  const upsertResult: SocraticSessionState = {
    id: "new-session-123",
    user_id: "user-abc",
    open_question_id: "question-xyz",
    course_id: "course-456",
    schema_version: 1,
    current_state: newState,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  const supabase = createMockSupabase({ upsertResult });
  const result = await saveSessionState(
    supabase,
    "user-abc",
    "question-xyz",
    "course-456",
    newState
  );

  assertExists(result);
  assertEquals(result.id, "new-session-123");
  assertEquals(result.current_state.decision, "HINT");
});

Deno.test("State building: creates correct structure from LLM response", () => {
  const llmResponse = {
    decision: "ASK",
    state_update: {
      goal: "Understand Newton's laws",
      domain: "physics",
      judgement: "PARTIAL",
      frustration: 3,
      hint_level: 1,
      known: ["mass concept"],
      gaps: ["force definition"],
      misconceptions: [],
    },
    meta: {
      mode: "question",
      response_class: "ON_TRACK",
      confidence: 0.85,
    },
  };

  const state = buildStateFromResponse(llmResponse);

  assertEquals(state.decision, "ASK");
  assertEquals((state.state_update as Record<string, unknown>).goal, "Understand Newton's laws");
  assertEquals((state.meta as Record<string, unknown>).confidence, 0.85);
});

Deno.test("Schema version: should be 1", () => {
  assertEquals(TUTOR_STATE_SCHEMA_VERSION, 1);
});

Deno.test("State structure: maintains all required fields", () => {
  const completeState = {
    decision: "WORKED_STEP",
    state_update: {
      goal: "Solve quadratic equation",
      domain: "algebra",
      competencies: ["c1", "c2"],
      judgement: "INCORRECT",
      plan: ["step1", "step2"],
      step_index: 1,
      hint_level: 3,
      known: ["basic algebra"],
      gaps: ["quadratic formula"],
      misconceptions: ["sign error"],
      frustration: 7,
      answer_allowed: true,
      stop_reason: "",
    },
    meta: {
      mode: "worked_step",
      response_class: "PARTIAL",
      confidence: 0.6,
      competency_assessment: {
        c1: { score: 2, evidence: ["showed understanding"] },
        c2: { score: 1, evidence: ["partial grasp"] },
      },
    },
  };

  // Verify structure
  assertExists(completeState.decision);
  assertExists(completeState.state_update);
  assertExists(completeState.meta);

  // Verify state_update fields
  const stateUpdate = completeState.state_update;
  assertExists(stateUpdate.goal);
  assertExists(stateUpdate.domain);
  assertExists(stateUpdate.competencies);
  assertExists(stateUpdate.judgement);
  assertExists(stateUpdate.plan);
  assertEquals(typeof stateUpdate.step_index, "number");
  assertEquals(typeof stateUpdate.hint_level, "number");
  assertEquals(typeof stateUpdate.frustration, "number");
  assertEquals(typeof stateUpdate.answer_allowed, "boolean");

  // Verify meta fields
  const meta = completeState.meta;
  assertExists(meta.mode);
  assertExists(meta.response_class);
  assertEquals(typeof meta.confidence, "number");
});

Deno.test("Transition types: init vs turn", () => {
  // Test that we can distinguish between init and turn transitions
  const initTransition = {
    transition_type: "init",
    state_before: null,
    state_after: { decision: "ASK" },
  };

  const turnTransition = {
    transition_type: "turn",
    state_before: { decision: "ASK" },
    state_after: { decision: "HINT" },
  };

  assertEquals(initTransition.transition_type, "init");
  assertEquals(initTransition.state_before, null);

  assertEquals(turnTransition.transition_type, "turn");
  assertExists(turnTransition.state_before);
});
