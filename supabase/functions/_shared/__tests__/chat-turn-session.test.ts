import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveSession } from "../chat-turn.ts";

/**
 * `resolveSession` selects, then inserts when nothing is there. Two turns can
 * reach that gap together — an opening turn and its retry, or a double submit —
 * and one of them loses on the uniqueness constraint. These pin what happens
 * next, because the obvious handling (surface the insert error) turns a
 * perfectly valid tutoring turn into a 404.
 */

const SESSION = {
  id: "sess-1",
  user_id: "user-1",
  course_id: "course-1",
  offering_id: "off-1",
  study_session_id: null,
  open_question_id: "q-1",
  status: "in_progress",
  subject_kind: "open_question",
};

interface Step {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/**
 * Minimal PostgREST stand-in. `selects` are consumed in order so a test can say
 * "empty first, then the row the winner wrote"; `insert` answers once.
 */
function stubSupabase(opts: { selects: Step[]; insert?: Step }) {
  const selects = [...opts.selects];
  let insertCalls = 0;

  // deno-lint-ignore no-explicit-any
  const chain: any = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.insert = () => {
    insertCalls++;
    return chain;
  };
  chain.maybeSingle = () => Promise.resolve(selects.shift() ?? { data: null, error: null });
  chain.single = () =>
    Promise.resolve(opts.insert ?? { data: null, error: { message: "no insert configured" } });

  return {
    client: { from: () => chain },
    insertCalls: () => insertCalls,
  };
}

const ARGS = {
  kind: "open_question" as const,
  subjectId: "q-1",
  userId: "user-1",
  courseId: "course-1",
  offeringId: "off-1",
};

Deno.test("resolveSession: returns the existing session without inserting", async () => {
  const stub = stubSupabase({ selects: [{ data: SESSION, error: null }] });

  // deno-lint-ignore no-explicit-any
  const { session } = await resolveSession(stub.client as any, ARGS);

  assertEquals(session?.id, "sess-1");
  assertEquals(stub.insertCalls(), 0, "an existing session must not be re-inserted");
});

Deno.test("resolveSession: opens a session when there is none", async () => {
  const stub = stubSupabase({
    selects: [{ data: null, error: null }],
    insert: { data: SESSION, error: null },
  });

  // deno-lint-ignore no-explicit-any
  const { session } = await resolveSession(stub.client as any, ARGS);

  assertEquals(session?.id, "sess-1");
  assertEquals(stub.insertCalls(), 1);
});

Deno.test("resolveSession: a lost creation race re-reads the winner's session", async () => {
  // Nothing on the first look; the insert loses on the uniqueness constraint;
  // the second look finds what the winning turn wrote.
  const stub = stubSupabase({
    selects: [
      { data: null, error: null },
      { data: SESSION, error: null },
    ],
    insert: { data: null, error: { message: "duplicate key value", code: "23505" } },
  });

  // deno-lint-ignore no-explicit-any
  const { session, error } = await resolveSession(stub.client as any, ARGS);

  assertEquals(session?.id, "sess-1", "the racing turn must get the winner's session");
  assertEquals(error, undefined);
});

Deno.test("resolveSession: an insert failure that is not a race still fails", async () => {
  // A uniqueness violation is recoverable; nothing else is. Re-reading on any
  // error would turn a genuine write failure into a silent empty session.
  const stub = stubSupabase({
    selects: [{ data: null, error: null }],
    insert: { data: null, error: { message: "permission denied", code: "42501" } },
  });

  // deno-lint-ignore no-explicit-any
  const { session, error } = await resolveSession(stub.client as any, ARGS);

  assertEquals(session, null);
  assertEquals(error, "permission denied");
});

Deno.test("resolveSession: refuses to open a session with no course to scope it to", async () => {
  const stub = stubSupabase({ selects: [{ data: null, error: null }] });

  const { session, error } = await resolveSession(
    // deno-lint-ignore no-explicit-any
    stub.client as any,
    { ...ARGS, courseId: undefined },
  );

  assertEquals(session, null);
  assertEquals(error, "courseId is required to open a new session");
  assertEquals(stub.insertCalls(), 0);
});
