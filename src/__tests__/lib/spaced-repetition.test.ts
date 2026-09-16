import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Rating,
  DEFAULT_STATE,
  SESSION_CONFIG,
  processReview,
  isDue,
  getOverdueDays,
  sortForReview,
  ratingLabelKey,
  describeNextReview,
  getRatingColor,
  getRecommendedSessionSize,
  FlashcardState,
} from '@/lib/spaced-repetition';

function createState(overrides: Partial<FlashcardState> = {}): FlashcardState {
  return {
    repetitions: 0,
    intervalDays: 0,
    easeFactor: 2.5,
    dueDate: new Date(),
    lastReviewed: null,
    ...overrides,
  };
}

describe('spaced-repetition', () => {
  describe('Rating enum', () => {
    it('should have correct values', () => {
      expect(Rating.AGAIN).toBe(0);
      expect(Rating.HARD).toBe(1);
      expect(Rating.GOOD).toBe(2);
      expect(Rating.EASY).toBe(3);
    });
  });

  describe('DEFAULT_STATE', () => {
    it('should have 0 repetitions and interval', () => {
      expect(DEFAULT_STATE.repetitions).toBe(0);
      expect(DEFAULT_STATE.intervalDays).toBe(0);
    });

    it('should have ease factor of 2.5', () => {
      expect(DEFAULT_STATE.easeFactor).toBe(2.5);
    });
  });

  describe('processReview', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('first review (repetitions = 0)', () => {
      it('AGAIN should set interval to 10 minutes', () => {
        const result = processReview(createState(), Rating.AGAIN);
        const expectedMinutes = 10;
        expect(result.intervalDays).toBeCloseTo(expectedMinutes / (24 * 60), 6);
        expect(result.repetitions).toBe(1);
      });

      it('HARD should set interval to 1 hour', () => {
        const result = processReview(createState(), Rating.HARD);
        const expectedMinutes = 60;
        expect(result.intervalDays).toBeCloseTo(expectedMinutes / (24 * 60), 6);
      });

      it('GOOD should set interval to 4 hours', () => {
        const result = processReview(createState(), Rating.GOOD);
        const expectedMinutes = 240;
        expect(result.intervalDays).toBeCloseTo(expectedMinutes / (24 * 60), 6);
      });

      it('EASY should set interval to 1 day', () => {
        const result = processReview(createState(), Rating.EASY);
        expect(result.intervalDays).toBeCloseTo(1, 6);
      });

      it('should set dueDate in the future', () => {
        const result = processReview(createState(), Rating.GOOD);
        expect(result.dueDate.getTime()).toBeGreaterThan(Date.now());
      });

      it('should set lastReviewed to now', () => {
        const result = processReview(createState(), Rating.GOOD);
        expect(result.lastReviewed.getTime()).toBe(Date.now());
      });
    });

    describe('subsequent reviews (repetitions > 0)', () => {
      it('should multiply interval by 1.5 for AGAIN', () => {
        const state = createState({ repetitions: 1, intervalDays: 1 });
        const result = processReview(state, Rating.AGAIN);
        expect(result.intervalDays).toBeCloseTo(1.5, 6);
      });

      it('should multiply interval by 1.2 for HARD', () => {
        const state = createState({ repetitions: 1, intervalDays: 1 });
        const result = processReview(state, Rating.HARD);
        expect(result.intervalDays).toBeCloseTo(1.2, 6);
      });

      it('should multiply interval by easeFactor for GOOD', () => {
        const state = createState({ repetitions: 1, intervalDays: 1, easeFactor: 2.5 });
        const result = processReview(state, Rating.GOOD);
        expect(result.intervalDays).toBeCloseTo(state.intervalDays * state.easeFactor, 6);
      });

      it('should multiply interval by easeFactor * 1.4 for EASY', () => {
        const state = createState({ repetitions: 1, intervalDays: 1, easeFactor: 2.5 });
        const result = processReview(state, Rating.EASY);
        expect(result.intervalDays).toBeCloseTo(state.intervalDays * state.easeFactor * 1.4, 6);
      });

      it('should increment repetitions', () => {
        const state = createState({ repetitions: 3, intervalDays: 5 });
        const result = processReview(state, Rating.GOOD);
        expect(result.repetitions).toBe(4);
      });
    });
  });

  describe('isDue', () => {
    it('should return true for past dates', () => {
      const pastDate = new Date(Date.now() - 1000);
      expect(isDue(pastDate)).toBe(true);
    });

    it('should return false for future dates', () => {
      const futureDate = new Date(Date.now() + 60000);
      expect(isDue(futureDate)).toBe(false);
    });
  });

  describe('getOverdueDays', () => {
    it('should return positive for overdue cards', () => {
      const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      expect(getOverdueDays(pastDate)).toBeCloseTo(2, 0);
    });

    it('should return negative for cards not yet due', () => {
      const futureDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      expect(getOverdueDays(futureDate)).toBeCloseTo(-3, 0);
    });
  });

  describe('sortForReview', () => {
    it('should sort overdue cards first (most overdue first)', () => {
      const now = Date.now();
      const cards = [
        { dueDate: new Date(now - 1000), repetitions: 1 },      // slightly overdue
        { dueDate: new Date(now - 100000000), repetitions: 1 },  // very overdue
        { dueDate: new Date(now + 100000000), repetitions: 1 },  // not due
      ];
      const sorted = sortForReview(cards);
      expect(sorted[0]).toBe(cards[1]); // most overdue first
      expect(sorted[1]).toBe(cards[0]);
    });

    it('should place new cards before reviewed but not-yet-due cards', () => {
      const now = Date.now();
      const cards = [
        { dueDate: new Date(now + 100000000), repetitions: 2 }, // reviewed, not due
        { dueDate: new Date(now + 100000000), repetitions: 0 }, // new card
      ];
      const sorted = sortForReview(cards);
      expect(sorted[0].repetitions).toBe(0);
    });

    it('should not mutate the original array', () => {
      const now = Date.now();
      const cards = [
        { dueDate: new Date(now - 1000), repetitions: 1 },
        { dueDate: new Date(now - 5000), repetitions: 1 },
      ];
      const original = [...cards];
      sortForReview(cards);
      expect(cards[0]).toBe(original[0]);
      expect(cards[1]).toBe(original[1]);
    });
  });

  describe('ratingLabelKey', () => {
    it('should return the catalog key for each rating', () => {
      expect(ratingLabelKey(Rating.AGAIN)).toBe('spacedRepetition.rating.again');
      expect(ratingLabelKey(Rating.HARD)).toBe('spacedRepetition.rating.hard');
      expect(ratingLabelKey(Rating.GOOD)).toBe('spacedRepetition.rating.good');
      expect(ratingLabelKey(Rating.EASY)).toBe('spacedRepetition.rating.easy');
    });

    it('should fall back to the unknown key for an invalid rating', () => {
      expect(ratingLabelKey(99 as Rating)).toBe('spacedRepetition.rating.unknown');
    });
  });

  describe('getRatingColor', () => {
    it('should return color classes for each rating', () => {
      expect(getRatingColor(Rating.AGAIN)).toContain('bg-red');
      expect(getRatingColor(Rating.HARD)).toContain('bg-orange');
      expect(getRatingColor(Rating.GOOD)).toContain('bg-green');
      expect(getRatingColor(Rating.EASY)).toContain('bg-blue');
    });

    it('should return gray for unknown rating', () => {
      expect(getRatingColor(99 as Rating)).toContain('bg-gray');
    });
  });

  describe('describeNextReview', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return minutes for short intervals', () => {
      const state = createState();
      expect(describeNextReview(state, Rating.AGAIN)).toEqual({
        unit: 'minutes',
        count: 10,
      });
    });

    it('should return hours for medium intervals', () => {
      const state = createState();
      expect(describeNextReview(state, Rating.HARD)).toEqual({
        unit: 'hours',
        count: 1,
      });
    });

    // The singular/plural split is the catalog's job now, so the count is
    // asserted directly rather than through an English rendering of it.
    it('should return a multi-hour count for GOOD on first review', () => {
      const state = createState();
      expect(describeNextReview(state, Rating.GOOD)).toEqual({
        unit: 'hours',
        count: 4,
      });
    });

    it('should return one day for 1-day intervals', () => {
      const state = createState();
      expect(describeNextReview(state, Rating.EASY)).toEqual({
        unit: 'days',
        count: 1,
      });
    });

    it('should return days for multi-day intervals', () => {
      const state = createState({ repetitions: 1, intervalDays: 1 });
      // GOOD: 1 * 2.5 = 2.5 days -> rounds to 3 days
      const result = describeNextReview(state, Rating.GOOD);
      expect(result.unit).toBe('days');
      expect(result.count).toBeGreaterThan(1);
    });
  });

  describe('SESSION_CONFIG', () => {
    it('should have expected defaults', () => {
      expect(SESSION_CONFIG.MAX_NEW_CARDS_PER_SESSION).toBe(10);
      expect(SESSION_CONFIG.MAX_CARDS_PER_SESSION).toBe(20);
      expect(SESSION_CONFIG.TARGET_MINUTES).toBe(10);
      expect(SESSION_CONFIG.ESTIMATED_SECONDS_PER_CARD).toBe(15);
    });
  });

  describe('getRecommendedSessionSize', () => {
    it('should prioritize due cards', () => {
      const result = getRecommendedSessionSize(15, 10);
      expect(result.dueCards).toBe(15);
    });

    it('should cap due cards at MAX_CARDS_PER_SESSION', () => {
      const result = getRecommendedSessionSize(100, 10);
      expect(result.dueCards).toBe(SESSION_CONFIG.MAX_CARDS_PER_SESSION);
    });

    it('should add new cards if capacity remains', () => {
      const result = getRecommendedSessionSize(5, 20);
      expect(result.newCards).toBeGreaterThan(0);
      expect(result.total).toBe(result.dueCards + result.newCards);
    });

    it('should cap new cards at MAX_NEW_CARDS_PER_SESSION', () => {
      const result = getRecommendedSessionSize(0, 100);
      expect(result.newCards).toBeLessThanOrEqual(SESSION_CONFIG.MAX_NEW_CARDS_PER_SESSION);
    });

    it('should limit new cards even when many due cards are present', () => {
      // 50 due cards → capped at MAX_CARDS_PER_SESSION (20)
      // targetCards = TARGET_MINUTES * 60 / ESTIMATED_SECONDS_PER_CARD = 40
      // remainingCapacity = 40 - 20 = 20, but capped at MAX_NEW_CARDS_PER_SESSION (10)
      const result = getRecommendedSessionSize(50, 100);
      expect(result.dueCards).toBe(SESSION_CONFIG.MAX_CARDS_PER_SESSION);
      expect(result.newCards).toBeLessThanOrEqual(SESSION_CONFIG.MAX_NEW_CARDS_PER_SESSION);
    });

    it('should handle zero inputs', () => {
      const result = getRecommendedSessionSize(0, 0);
      expect(result.dueCards).toBe(0);
      expect(result.newCards).toBe(0);
      expect(result.total).toBe(0);
    });
  });
});
