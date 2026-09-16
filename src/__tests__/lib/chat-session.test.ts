import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Opening a conversation, when the row may already be there.
 *
 * One `chat_sessions` row per (student, subject) is a database constraint, and
 * the client used to read-then-insert with nothing between the two steps. Every
 * reason the read can come back empty for a subject that *does* have a session
 * — a read issued mid-mount, a token being refreshed, a second tab, a retried
 * turn — therefore ended as `duplicate key value violates unique constraint
 * "chat_sessions_unique_open_question"` shown to the student in place of the
 * tutor's answer.
 *
 * The rule pinned here: the row that the insert collided with is the row we
 * wanted, so it is read back and the turn goes on. A read that *failed* is not
 * a subject with no session, and must not be treated as one.
 */

type Row = { id: string; status?: string };
type Err = { code?: string; message: string } | null;

/** What the fake `chat_sessions` table answers with, per step. */
let reads: { data: Row | null; error: Err }[] = [];
let insertResult: { data: Row | null; error: Err } = { data: null, error: null };
let inserted: Record<string, unknown>[] = [];

vi.mock("@/integrations/supabase/client", () => {
  const makeQuery = () => {
    let payload: Record<string, unknown> | null = null;
    const query = {
      select: () => query,
      eq: () => query,
      insert: (values: Record<string, unknown>) => {
        payload = values;
        return query;
      },
      maybeSingle: async () => reads.shift() ?? { data: null, error: null },
      single: async () => {
        if (payload) inserted.push(payload);
        return insertResult;
      },
    };
    return query;
  };
  return { supabase: { from: () => makeQuery() } };
});

import { ensureChatSession } from "@/lib/chat-session";

const args = {
  subjectColumn: "open_question_id" as const,
  subjectId: "q1",
  userId: "u1",
  courseId: "c1",
};

beforeEach(() => {
  reads = [];
  insertResult = { data: null, error: null };
  inserted = [];
});

describe("ensureChatSession", () => {
  it("returns the session the student already has", async () => {
    reads = [{ data: { id: "sess-1" }, error: null }];

    const result = await ensureChatSession(args);

    expect(result).toEqual({ session: { id: "sess-1" }, created: false });
    expect(inserted).toEqual([]);
  });

  it("opens one on first contact", async () => {
    reads = [{ data: null, error: null }];
    insertResult = { data: { id: "sess-new" }, error: null };

    const result = await ensureChatSession(args);

    expect(result.session).toEqual({ id: "sess-new" });
    expect(result.created).toBe(true);
    expect(inserted[0]).toMatchObject({
      open_question_id: "q1",
      user_id: "u1",
      course_id: "c1",
      status: "in_progress",
    });
  });

  it("uses the row it collided with rather than failing the turn", async () => {
    // The read missed a row that exists; the constraint caught the insert.
    reads = [
      { data: null, error: null },
      { data: { id: "sess-1" }, error: null },
    ];
    insertResult = {
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "chat_sessions_unique_open_question"',
      },
    };

    const result = await ensureChatSession(args);

    expect(result).toEqual({ session: { id: "sess-1" }, created: false });
  });

  it("reports the failure when the collision cannot be resolved", async () => {
    // Nothing to fall back on: the re-read found nothing either, so the insert
    // error is still the truest account of what happened.
    reads = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    insertResult = { data: null, error: { code: "23505", message: "duplicate key" } };

    await expect(ensureChatSession(args)).rejects.toMatchObject({ code: "23505" });
  });

  it("does not insert over a session it merely failed to read", async () => {
    reads = [{ data: null, error: { message: "JWT expired" } }];

    await expect(ensureChatSession(args)).rejects.toMatchObject({ message: "JWT expired" });
    expect(inserted).toEqual([]);
  });

  it("passes an offering through when the caller knows it", async () => {
    reads = [{ data: null, error: null }];
    insertResult = { data: { id: "sess-new" }, error: null };

    await ensureChatSession({
      subjectColumn: "study_session_id",
      subjectId: "s1",
      userId: "u1",
      courseId: "c1",
      offeringId: "off-1",
    });

    expect(inserted[0]).toMatchObject({ study_session_id: "s1", offering_id: "off-1" });
  });

  it("leaves the offering unset when it does not", async () => {
    // The open-question surfaces cannot know it; the edge function scopes the
    // row from its own authorisation check on the first turn.
    reads = [{ data: null, error: null }];
    insertResult = { data: { id: "sess-new" }, error: null };

    await ensureChatSession(args);

    expect(inserted[0]).toMatchObject({ offering_id: null });
  });
});
