/**
 * #1100 — FlashcardCalendarView, taken opportunistically alongside
 * SpacedRepetitionReview, which is the only thing that renders it.
 *
 * It looks presentational but it is not: it PROJECTS a schedule. New cards are
 * spread forward at `maxNewPerDay` a day, reviewed cards are bucketed by the
 * day they come due, and anything already past is counted as overdue. Those
 * three sums are the student's answer to "when do I finish this deck", and none
 * of them exists anywhere else.
 *
 * The calendar widget itself is left alone — clicking a day is react-day-picker's
 * behaviour, and picking "tomorrow" would flake on month boundaries. Everything
 * asserted here is about the default selection (today) and the totals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { addDays, subDays } from "date-fns";

import FlashcardCalendarView from "@/components/FlashcardCalendarView";

type Card = Parameters<typeof FlashcardCalendarView>[0]["allCards"][number];

/**
 * The fixtures and the component each call `new Date()` independently, so on
 * real time a run that crosses local midnight would file a `dueCard(0)` under
 * yesterday while the component selects today. Freezing the clock at local
 * midday makes both reads the same instant, and keeps every offset well clear
 * of a date boundary in any timezone.
 */
const NOW = new Date(2026, 4, 15, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;

/** A never-reviewed card. */
function newCard(front = `New ${++seq}`): Card {
  return {
    chapterId: "ch-1",
    chapterTitle: "Fractions",
    flashcardIndex: seq,
    flashcard: { front, back: "back" },
    reviewState: null,
  };
}

/** A reviewed card, due `offsetDays` from today (negative = overdue). */
function dueCard(offsetDays: number, front = `Due ${++seq}`): Card {
  const now = new Date();
  return {
    chapterId: "ch-1",
    chapterTitle: "Fractions",
    flashcardIndex: seq,
    flashcard: { front, back: "back" },
    reviewState: {
      repetitions: 2,
      intervalDays: 1,
      easeFactor: 2.5,
      dueDate: offsetDays >= 0 ? addDays(now, offsetDays) : subDays(now, -offsetDays),
      lastReviewed: subDays(now, 1),
    },
  };
}

describe("FlashcardCalendarView", () => {
  it("introduces at most one day's worth of new cards today", () => {
    render(
      <FlashcardCalendarView
        allCards={[newCard(), newCard(), newCard(), newCard(), newCard()]}
        maxNewPerDay={2}
        maxDuePerDay={15}
      />,
    );

    // Five new cards, two a day: today gets two, not five.
    expect(screen.getByText("2 new")).toBeInTheDocument();
    expect(screen.getByText("2 new cards to learn")).toBeInTheDocument();
  });

  it("introduces the whole backlog at once when it fits inside the daily cap", () => {
    render(
      <FlashcardCalendarView allCards={[newCard(), newCard()]} maxNewPerDay={10} />,
    );

    expect(screen.getByText("2 new")).toBeInTheDocument();
  });

  it("counts cards whose review date has passed as overdue", () => {
    render(
      <FlashcardCalendarView allCards={[dueCard(-3), dueCard(-1), dueCard(2), newCard()]} />,
    );

    expect(screen.getByText("2 overdue cards")).toBeInTheDocument();
    expect(screen.getByText("These cards need review today")).toBeInTheDocument();
  });

  it("says one overdue card, not one overdue cards", () => {
    render(<FlashcardCalendarView allCards={[dueCard(-1)]} />);

    expect(screen.getByText("1 overdue card")).toBeInTheDocument();
  });

  it("raises no alarm when nothing is late", () => {
    render(<FlashcardCalendarView allCards={[dueCard(1), dueCard(4)]} />);

    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });

  it("lists what is due today and summarises the rest", () => {
    const due = Array.from({ length: 7 }, (_, i) => dueCard(0, `Card ${i + 1}`));

    render(<FlashcardCalendarView allCards={due} />);

    expect(screen.getByText("7 due")).toBeInTheDocument();
    expect(screen.getByText("Card 1")).toBeInTheDocument();
    expect(screen.getByText("Card 5")).toBeInTheDocument();
    expect(screen.queryByText("Card 6")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more due cards")).toBeInTheDocument();
  });

  it("keeps a card due later off today's list", () => {
    render(<FlashcardCalendarView allCards={[dueCard(0, "Today's card"), dueCard(5, "Later")]} />);

    expect(screen.getByText("Today's card")).toBeInTheDocument();
    expect(screen.queryByText("Later")).not.toBeInTheDocument();
    expect(screen.getByText("1 due")).toBeInTheDocument();
  });

  it("says the day is clear when a fully-learned deck has nothing due", () => {
    render(<FlashcardCalendarView allCards={[dueCard(3), dueCard(9)]} />);

    expect(screen.getByText("No cards scheduled for this day")).toBeInTheDocument();
  });

  it("shows the caps it is projecting against", () => {
    render(<FlashcardCalendarView allCards={[]} maxNewPerDay={7} maxDuePerDay={21} />);

    expect(screen.getByText("Daily limits: 7 new • 21 due")).toBeInTheDocument();
  });

  it("defaults to the same caps the review session uses", () => {
    render(<FlashcardCalendarView allCards={[]} />);

    expect(screen.getByText("Daily limits: 10 new • 15 due")).toBeInTheDocument();
  });
});
