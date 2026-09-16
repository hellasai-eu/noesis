import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { TURNS_BEFORE_REVIEW } from "../chat-turn.ts";
import { openQuestionSubject } from "../chat-subjects/open-question.ts";
import { studySessionSubject } from "../chat-subjects/study-session.ts";

/**
 * One review interval, shared.
 *
 * The two surfaces used to choose separately — 20 messages on socratic, 100 on
 * the study tutor — so the same child met instructor review after 10 exchanges
 * on one screen and 50 on another, with nothing in the product to explain the
 * difference. They are now both `TURNS_BEFORE_REVIEW`, and a future subject
 * that hard-codes its own number is the regression this is here to catch.
 */

Deno.test("both tutoring surfaces pause on the same interval", () => {
  assertEquals(openQuestionSubject.pauseEveryNMessages, TURNS_BEFORE_REVIEW);
  assertEquals(studySessionSubject.pauseEveryNMessages, TURNS_BEFORE_REVIEW);
});

Deno.test("the interval is 40 exchanges", () => {
  // Counted in stored rows: a student's question and the tutor's reply are two.
  // Asserting the exchange count rather than the raw number is what keeps this
  // honest if the unit the loop counts in ever changes — `history.length` is
  // messages, and reading 80 as "80 turns" is the mistake to guard against.
  assertEquals(TURNS_BEFORE_REVIEW / 2, 40);
});

/**
 * A completed session, per surface.
 *
 * These differ on purpose. An open question the student marked complete is
 * finished — its composer has been disabled in that state since long before the
 * turn was shared — and the server enforces it too, because a stale tab would
 * otherwise persist turns onto a finished question. A study session marked
 * complete can be reopened and continued; the list offers "Review" for exactly
 * that, so refusing there would break a working flow.
 */

Deno.test("a completed open question refuses further turns", () => {
  assertEquals(openQuestionSubject.refuseWhenCompleted, true);
  // The refusal has to say something a student can act on, not just 403.
  assertEquals(typeof openQuestionSubject.pausedCopy.alreadyCompleted, "string");
});

Deno.test("a completed study session may still be continued", () => {
  assertEquals(studySessionSubject.refuseWhenCompleted, false);
});
