import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  createTestHarness,
  supabaseRoute,
} from "./handler-harness.ts";
import {
  isVerboseLoggingEnabled,
  logInteraction,
  InteractionLogData,
} from "../agent-logging.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPTS = { sanitizeOps: false, sanitizeResources: false };

function makeSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ── isVerboseLoggingEnabled ───────────────────────────────────────────

Deno.test({
  name: "isVerboseLoggingEnabled: returns true when config enabled",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/system_config", { value: { enabled: true } }),
      ],
    });
    try {
      const supabase = makeSupabase();
      const result = await isVerboseLoggingEnabled(supabase);
      assertEquals(result, true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "isVerboseLoggingEnabled: returns false when config disabled",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/system_config", { value: { enabled: false } }),
      ],
    });
    try {
      const supabase = makeSupabase();
      const result = await isVerboseLoggingEnabled(supabase);
      assertEquals(result, false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "isVerboseLoggingEnabled: returns false when config missing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/system_config", null),
      ],
    });
    try {
      const supabase = makeSupabase();
      const result = await isVerboseLoggingEnabled(supabase);
      assertEquals(result, false);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "isVerboseLoggingEnabled: returns false on query error",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/system_config", { message: "internal error" }, { status: 500 }),
      ],
    });
    try {
      const supabase = makeSupabase();
      const result = await isVerboseLoggingEnabled(supabase);
      assertEquals(result, false);
    } finally {
      h.cleanup();
    }
  },
});

// ── logInteraction ────────────────────────────────────────────────────

Deno.test({
  name: "logInteraction: inserts log data successfully",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute("/rest/v1/agent_interaction_logs", {}, { method: "POST" }),
      ],
    });
    try {
      const supabase = makeSupabase();
      const logData: InteractionLogData = {
        function_name: "test-function",
        trace_id: "trace-123",
        question_id: "q-1",
        course_id: "c-1",
        user_id: "u-1",
        user_message: "Hello",
        response_time_ms: 500,
      };
      // Should not throw
      await logInteraction(supabase, logData);

      // Verify a POST was made to agent_interaction_logs
      const logCall = h.fetchLog.find(
        (entry) =>
          entry.url.includes("agent_interaction_logs") &&
          entry.method === "POST"
      );
      assertEquals(logCall !== undefined, true);
    } finally {
      h.cleanup();
    }
  },
});

Deno.test({
  name: "logInteraction: catches insert error without throwing",
  ...OPTS,
  async fn() {
    const h = createTestHarness({
      routes: [
        supabaseRoute(
          "/rest/v1/agent_interaction_logs",
          { message: "insert failed" },
          { status: 500, method: "POST" }
        ),
      ],
    });
    try {
      const supabase = makeSupabase();
      const logData: InteractionLogData = {
        function_name: "test-function",
      };
      // Should not throw even on error
      await logInteraction(supabase, logData);
    } finally {
      h.cleanup();
    }
  },
});
