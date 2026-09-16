import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { completeSessionOnStop } from "../chat-turn.ts";
import { openQuestionSubject } from "../chat-subjects/open-question.ts";
import { studySessionSubject } from "../chat-subjects/study-session.ts";
import { unifiedOutputContract } from "../prompts/unified-state.ts";
import { SOCRATIC_CHAT_SYSTEM_PROMPT } from "../prompts/socratic-chat.ts";

/**
 * A `STOP` decision ends an open question by itself.
 *
 * This used to be the client's job: the buffered page read `evaluator.stop` off
 * the v1 reply and wrote `status='completed'` from the browser. The unified v2
 * reply has no `evaluator` — it carries `decision` — so that check matched
 * nothing from the moment streaming became the surface students actually get,
 * and `StreamingChatPanel` never had the check at all. A student would be told
 * "the question is complete" by the tutor and find it still open, composer
 * enabled, badge unset.
 *
 * These pin the rule where both transports go through it.
 */

interface Call {
  table: string;
  values: Record<string, unknown>;
  eq: [string, unknown][];
  in: [string, unknown[]][];
}

function stubSupabase(error: { message: string } | null = null) {
  const calls: Call[] = [];

  const client = {
    from(table: string) {
      const call: Call = { table, values: {}, eq: [], in: [] };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        update(values: Record<string, unknown>) {
          call.values = values;
          calls.push(call);
          return chain;
        },
        eq(column: string, value: unknown) {
          call.eq.push([column, value]);
          return chain;
        },
        in(column: string, values: unknown[]) {
          call.in.push([column, values]);
          // The terminal call: PostgREST resolves the builder when awaited.
          return Promise.resolve({ error });
        },
      };
      return chain;
    },
  };

  return { client, calls };
}

Deno.test("STOP completes the session on a surface that ends on one", async () => {
  const { client, calls } = stubSupabase();

  // deno-lint-ignore no-explicit-any
  const wrote = await completeSessionOnStop(client as any, {
    sessionId: "sess-1",
    completeOnStop: true,
    decision: "STOP",
    judgement: "CORRECT",
  });

  assert(wrote);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].table, "chat_sessions");
  assertEquals(calls[0].values.status, "completed");
  assertEquals(typeof calls[0].values.completed_at, "string");
  assertEquals(calls[0].eq, [["id", "sess-1"]]);
});

Deno.test("a paused session is not completed out from under review", async () => {
  const { client, calls } = stubSupabase();

  // deno-lint-ignore no-explicit-any
  await completeSessionOnStop(client as any, {
    sessionId: "sess-1",
    completeOnStop: true,
    decision: "STOP",
    judgement: "CORRECT",
  });

  // The guard is a filter on the write, not a read-then-write, so there is no
  // window between the two. `paused` is absent by construction: a session
  // paused for moderation stays paused until someone reviews it, and a reply
  // that is flagged after delivery is exactly the kind that gets here.
  const [[column, statuses]] = calls[0].in;
  assertEquals(column, "status");
  assertEquals(statuses.includes("paused"), false);
  assertEquals(statuses.includes("completed"), false);
  assertEquals(statuses.sort(), ["in_progress", "not_started"]);
});

Deno.test("any decision but STOP leaves the session alone", async () => {
  for (const decision of ["ASK", "HINT", "WORKED_STEP", null, undefined]) {
    const { client, calls } = stubSupabase();
    // deno-lint-ignore no-explicit-any
    const wrote = await completeSessionOnStop(client as any, {
      sessionId: "sess-1",
      completeOnStop: true,
      decision,
      judgement: "CORRECT",
    });
    assertEquals(wrote, false, `decision ${decision} should not complete`);
    assertEquals(calls.length, 0);
  }
});

Deno.test("a surface that does not end on STOP never writes", async () => {
  const { client, calls } = stubSupabase();

  // deno-lint-ignore no-explicit-any
  const wrote = await completeSessionOnStop(client as any, {
    sessionId: "sess-1",
    completeOnStop: false,
    decision: "STOP",
    judgement: "CORRECT",
  });

  assertEquals(wrote, false);
  assertEquals(calls.length, 0);
});

/**
 * A question is finished by a correct answer, not by the conversation running
 * out of steam.
 *
 * The v1 Socratic schema made this structural: `stop` was documented as true
 * only when the judgement was CORRECT, and that surface's prompt bound the two
 * together in one classification table. The unified contract asks for the same
 * pairing in prose, which is weaker — and the cost of the model getting it
 * wrong is not a badge but a lost attempt, since `refuseWhenCompleted` turns
 * away every later turn on a completed question.
 *
 * So the pairing is checked here too. These are the cases where a model reading
 * "the exchange is finished" off the wrong signal would otherwise close a
 * question the student never answered.
 */

Deno.test("STOP without a correct answer does not complete the question", async () => {
  for (const judgement of ["PARTIAL", "INCORRECT", "IRRELEVANT", "OFF_TASK", null, undefined]) {
    const { client, calls } = stubSupabase();

    // deno-lint-ignore no-explicit-any
    const wrote = await completeSessionOnStop(client as any, {
      sessionId: "sess-1",
      completeOnStop: true,
      decision: "STOP",
      judgement,
    });

    assertEquals(wrote, false, `judgement ${judgement} must not complete`);
    // Nothing written at all — a student who gave up keeps their composer.
    assertEquals(calls.length, 0);
  }
});

Deno.test("the ending contract binds STOP to a correct answer", () => {
  const contract = unifiedOutputContract([], { endsOnStop: true });

  assert(
    /STOP has ONE trigger/.test(contract),
    "the contract must name a single trigger for STOP",
  );
  assert(
    /must say\s+CORRECT on any turn you choose STOP/.test(contract),
    "STOP must be tied to the judgement written into state_update",
  );
  // The failure mode this exists for: a student saying they give up reads as
  // "the exchange is finished" to a model told only that much.
  assert(
    /give up/.test(contract),
    "the contract must rule out stopping because the student quit",
  );
  assert(
    /it is not yours/.test(contract),
    "ending the session must be named as the student's decision",
  );
});

Deno.test("a failed write is reported, not thrown", async () => {
  const { client } = stubSupabase({ message: "connection reset" });

  // The reply is already generated and persisted by the time this runs.
  // Throwing here would fail a turn the student has read, to protect a badge
  // they can still set by hand.
  // deno-lint-ignore no-explicit-any
  const wrote = await completeSessionOnStop(client as any, {
    sessionId: "sess-1",
    completeOnStop: true,
    decision: "STOP",
    judgement: "CORRECT",
  });

  assertEquals(wrote, false);
});

/**
 * The model must be told what STOP costs it — and only where it costs anything.
 *
 * On the open question a completion closes the composer, so a reply that says
 * "well done — now, can you also explain why?" alongside `decision: STOP` asks
 * a question the student has no way to answer. The rule has to live in the
 * prompt, because nothing downstream can put the question back.
 *
 * On the study session nothing acts on STOP at all — the student ends it from
 * the UI — but the student can still *say* they are done, and a tutor bound to
 * one-question-per-reply answers even "let's finish here" with another
 * question. So that surface's STOP is a farewell: student-initiated only,
 * no question asked, nothing closed. Its one-question rule and this farewell
 * carry matching exceptions (see `study-tutor.ts`); pinned together because
 * either one alone hands the model two instructions it cannot both obey.
 */

Deno.test("the ending contract forbids asking anything on STOP", () => {
  const contract = unifiedOutputContract([], { endsOnStop: true });
  assert(
    /STOP means you are done asking/.test(contract),
    "the STOP rule must state that no further question may be asked",
  );
  assert(
    /question mark/.test(contract),
    "the rule must rule out a question mark, not merely 'a question'",
  );
  // The escape hatch matters as much as the prohibition: a tutor that wants
  // another turn should pick a different decision, not ask anyway.
  assert(
    /choose ASK or HINT\s+and do not say STOP/.test(contract),
    "the rule must say what to choose instead when another turn is wanted",
  );
});

Deno.test("the non-ending contract makes STOP a student-initiated farewell", () => {
  const contract = unifiedOutputContract([], { endsOnStop: false });
  // Honesty first: nothing server-side acts on STOP here, and a prompt that
  // promises the exchange closes would teach the model to lie to the student.
  assert(
    /STOP does not close anything here/.test(contract),
    "a surface that does not act on STOP must say so",
  );
  // The student decides when they are finished — the tutor may not volunteer a
  // STOP, only honour one.
  assert(
    /student has said\s+they are finished/.test(contract),
    "the farewell must be conditioned on the student asking to finish",
  );
  // The bug this exists to prevent: a farewell that ends in "shall we close?"
  // is not a farewell, and each confirmation question reopens a conversation
  // the student already ended. `study-tutor.ts` carries the matching exception
  // to its one-question rule, so this is now obeyable.
  assert(
    /NO question mark/.test(contract),
    "the farewell must rule out a question mark, not merely 'a question'",
  );
  assert(
    /something to do next/.test(contract),
    "every non-farewell reply must still leave the student something to do",
  );
});

Deno.test("each surface's contract matches what the server actually does", () => {
  // Prompt and `completeOnStop` are driven from one constant per subject
  // precisely so they cannot drift; this is what would catch it if someone
  // reintroduced two. A prompt promising the exchange closes, on a surface
  // that then leaves it open, teaches the model to lie to the student.
  const ending = unifiedOutputContract([], { endsOnStop: true });
  const nonEnding = unifiedOutputContract([], { endsOnStop: false });
  assert(ending !== nonEnding, "the two surfaces must not be told the same thing");
  assertEquals(openQuestionSubject.completeOnStop, true);
  assertEquals(studySessionSubject.completeOnStop, false);
});

Deno.test("the contract bridges the v1 `stop` wording to `decision`", () => {
  // The v2 reply has no `stop` field, so a surface prompt written in v1
  // vocabulary needs the two named as the same thing or its STOP rules read as
  // being about a key the model was told not to emit.
  for (const endsOnStop of [true, false]) {
    assert(
      /stop = true, that is\s+decision: STOP/.test(
        unifiedOutputContract([], { endsOnStop }),
      ),
      `the bridge is missing when endsOnStop=${endsOnStop}`,
    );
  }
});

Deno.test("the socratic prompt forbids asking anything on STOP", () => {
  assert(
    /Ask the student NOTHING further/.test(SOCRATIC_CHAT_SYSTEM_PROMPT),
    "the CORRECT branch must forbid a follow-up question",
  );
  // The escape hatch matters as much as the prohibition: a tutor that still
  // wants another turn should downgrade the judgement rather than ask anyway.
  assert(
    /not CORRECT/.test(SOCRATIC_CHAT_SYSTEM_PROMPT),
    "the prompt must say what to do instead when another turn is wanted",
  );
});
