/**
 * #1004 — `pieceIsStale` is the single definition behind three surfaces: the
 * guide list, the publish check and the piece editor. The first two disagreed
 * once, which is how a stale warning went missing at the only moment it
 * mattered, so the predicate is pinned here rather than re-derived per caller.
 */
import { describe, it, expect } from "vitest";
import {
  assignmentIsDone,
  disallowedNewTargets,
  guideIsAssignable,
  pieceIsStale,
} from "@/lib/study-guide";

const EARLIER = "2026-07-27T10:00:00.000Z";
const LATER = "2026-07-27T11:00:00.000Z";

describe("pieceIsStale", () => {
  it("is stale when the theory was edited after the questions were written", () => {
    expect(pieceIsStale(EARLIER, LATER)).toBe(true);
  });

  it("is not stale when the questions were written after the last theory edit", () => {
    expect(pieceIsStale(LATER, EARLIER)).toBe(false);
  });

  it("is not stale when both stamps are identical", () => {
    // The questions-writing transaction stamps its own time; an equal stamp
    // means they were written from exactly this text.
    expect(pieceIsStale(EARLIER, EARLIER)).toBe(false);
  });

  it("is stale when the questions have no stamp at all", () => {
    // Predates the column. Over-warning is the safe direction: the alternative
    // is silently publishing questions that may test superseded text.
    expect(pieceIsStale(null, LATER)).toBe(true);
  });

  it("is not stale when the theory has never been edited", () => {
    expect(pieceIsStale(LATER, null)).toBe(false);
  });
});

describe("guideIsAssignable", () => {
  it("refuses a guide with no pieces", () => {
    // Outline generation can fail after the guide row is created, so this is a
    // state the list really reaches. Assigning it hands the student an empty
    // shell — "This study guide has no pieces yet".
    expect(guideIsAssignable(0, false)).toBe(false);
  });

  it("allows a guide that has pieces", () => {
    expect(guideIsAssignable(1, false)).toBe(true);
    expect(guideIsAssignable(5, false)).toBe(true);
  });

  it("still exposes assignment for a pieceless guide that is already out", () => {
    // Every piece deleted after it went to a class: the instructor has to be
    // able to reach the dialog to take the assignment back. Hiding it here
    // would strand the guide in front of students with no way to withdraw it.
    expect(guideIsAssignable(0, true)).toBe(true);
  });

  // #1085 — incomplete pieces block instead of warning.
  it("refuses a guide whose pieces do not all have questions", () => {
    // A student who reaches a piece with nothing to answer cannot advance past
    // it, so a partially-built guide is not a judgement call — it is a dead end.
    expect(guideIsAssignable(5, false, 1)).toBe(false);
    expect(guideIsAssignable(5, false, 5)).toBe(false);
  });

  it("allows a guide once every piece has questions", () => {
    expect(guideIsAssignable(5, false, 0)).toBe(true);
  });

  it("treats a missing incomplete count as complete, preserving old call sites", () => {
    expect(guideIsAssignable(5, false)).toBe(true);
  });

  it("lets an already-assigned guide stay reachable even while incomplete", () => {
    // The escape hatch has to win over the completeness rule too: a guide that
    // is already in front of students must always be retractable, however
    // incomplete it has since become.
    expect(guideIsAssignable(5, true, 3)).toBe(true);
    expect(guideIsAssignable(0, true, 0)).toBe(true);
  });
});

/**
 * #1085 review — the escape hatch must permit retraction without becoming a
 * way to hand an incomplete guide to someone new.
 */
describe("disallowedNewTargets", () => {
  const A = { offering_id: "o1", group_id: null };
  const B = { offering_id: "o2", group_id: null };
  const AG = { offering_id: "o1", group_id: "g1" };

  it("permits everything once the guide is complete", () => {
    expect(disallowedNewTargets(0, [A], [A, B])).toEqual([]);
  });

  it("permits keeping the targets an incomplete guide already had", () => {
    expect(disallowedNewTargets(2, [A, B], [A, B])).toEqual([]);
  });

  it("permits removing targets from an incomplete guide", () => {
    // The whole reason the dialog stays reachable: retraction must work.
    expect(disallowedNewTargets(2, [A, B], [A])).toEqual([]);
    expect(disallowedNewTargets(2, [A, B], [])).toEqual([]);
  });

  it("refuses a NEW class on an incomplete guide", () => {
    expect(disallowedNewTargets(2, [A], [A, B])).toEqual([B]);
  });

  it("treats a group of an already-assigned offering as new", () => {
    // Whole-class o1 does not imply its group g1: a group assignment is a
    // distinct row and reaches students the whole-class one may not.
    expect(disallowedNewTargets(2, [A], [A, AG])).toEqual([AG]);
  });

  it("refuses every addition, not just the first", () => {
    expect(disallowedNewTargets(1, [], [A, B])).toEqual([A, B]);
  });
});

describe("assignmentIsDone", () => {
  const NOW = new Date("2026-09-10T12:00:00.000Z").getTime();
  const PAST = "2026-09-01T00:00:00.000Z";
  const FUTURE = "2026-09-20T00:00:00.000Z";

  it("is not done with neither a closure nor a due date", () => {
    expect(assignmentIsDone(null, null, NOW)).toBe(false);
  });

  it("is done once the instructor marked it, whatever the due date says", () => {
    expect(assignmentIsDone(PAST, null, NOW)).toBe(true);
    expect(assignmentIsDone(PAST, FUTURE, NOW)).toBe(true);
  });

  it("becomes done automatically when the due date passes", () => {
    expect(assignmentIsDone(null, PAST, NOW)).toBe(true);
    expect(assignmentIsDone(null, FUTURE, NOW)).toBe(false);
  });

  it("flips exactly at the deadline, not before", () => {
    const due = "2026-09-10T12:00:00.000Z";
    expect(assignmentIsDone(null, due, NOW)).toBe(false); // due == now: not yet past
    expect(assignmentIsDone(null, due, NOW + 1)).toBe(true);
  });
});
