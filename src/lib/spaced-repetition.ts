/**
 * Custom Spaced Repetition Algorithm
 * 
 * First review intervals:
 * - Again: 10 minutes
 * - Hard: 1 hour
 * - Good: 4 hours
 * - Easy: 1 day
 * 
 * Subsequent reviews multiply previous interval by:
 * - Again: 1.5x
 * - Hard: 1.2x
 * - Good: 2.5x
 * - Easy: 3.5x
 */

// Rating values mapped from user actions
export enum Rating {
  AGAIN = 0, // Complete blackout, wrong response
  HARD = 1,  // Correct but with difficulty
  GOOD = 2,  // Correct with some hesitation
  EASY = 3,  // Perfect recall
}

export interface FlashcardState {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  dueDate: Date;
  lastReviewed: Date | null;
}

export interface ReviewResult {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  dueDate: Date;
  lastReviewed: Date;
}

// Default values for new cards
export const DEFAULT_STATE: Omit<FlashcardState, 'dueDate' | 'lastReviewed'> = {
  repetitions: 0,
  intervalDays: 0,
  easeFactor: 2.5,
};

// First review intervals in minutes
const FIRST_REVIEW_INTERVALS_MINUTES = {
  [Rating.AGAIN]: 10,      // 10 minutes
  [Rating.HARD]: 60,       // 1 hour
  [Rating.GOOD]: 240,      // 4 hours
  [Rating.EASY]: 1440,     // 1 day (24 hours)
};

// Multipliers for subsequent reviews
const INTERVAL_MULTIPLIERS = {
  [Rating.AGAIN]: 1.5,
  [Rating.HARD]: 1.2,
  [Rating.GOOD]: 2.5,
  [Rating.EASY]: 3.5,
};

/**
 * Process a flashcard review and return the updated state
 * 
 * @param currentState - Current state of the flashcard
 * @param rating - User's rating of their recall (Again, Hard, Good, Easy)
 * @returns Updated flashcard state
 */
export function processReview(
  currentState: FlashcardState,
  rating: Rating
): ReviewResult {
  const now = new Date();
  const isFirstReview = currentState.repetitions === 0;
  
  let intervalMinutes: number;
  
  if (isFirstReview) {
    // First time seeing this card - use fixed intervals
    intervalMinutes = FIRST_REVIEW_INTERVALS_MINUTES[rating];
  } else {
    // Subsequent reviews - multiply previous interval
    const previousIntervalMinutes = currentState.intervalDays * 24 * 60;
    const multiplier = INTERVAL_MULTIPLIERS[rating];
    intervalMinutes = previousIntervalMinutes * multiplier;
  }
  
  // Convert to days for storage (keep fractional days for short intervals)
  const intervalDays = intervalMinutes / (24 * 60);
  
  // Calculate next due date
  const dueDate = new Date(now.getTime() + intervalMinutes * 60 * 1000);
  
  return {
    repetitions: currentState.repetitions + 1,
    intervalDays,
    easeFactor: currentState.easeFactor, // Keep ease factor for compatibility
    dueDate,
    lastReviewed: now,
  };
}

/**
 * Check if a flashcard is due for review
 */
export function isDue(dueDate: Date): boolean {
  return new Date() >= dueDate;
}

/**
 * Calculate how overdue a card is (in days)
 * Returns negative if card is not yet due
 */
export function getOverdueDays(dueDate: Date): number {
  const now = new Date();
  const diffMs = now.getTime() - dueDate.getTime();
  return diffMs / (24 * 60 * 60 * 1000);
}

/**
 * Sort flashcards for an optimal review session
 * Priority: 1. Overdue cards (most overdue first)
 *           2. New cards
 *           3. Cards due today
 */
export function sortForReview<T extends { dueDate: Date; repetitions: number }>(
  cards: T[]
): T[] {
  return [...cards].sort((a, b) => {
    const aOverdue = getOverdueDays(a.dueDate);
    const bOverdue = getOverdueDays(b.dueDate);
    
    // Both overdue - sort by most overdue first
    if (aOverdue > 0 && bOverdue > 0) {
      return bOverdue - aOverdue;
    }
    
    // Only one is overdue
    if (aOverdue > 0) return -1;
    if (bOverdue > 0) return 1;
    
    // New cards (repetitions = 0) come before reviewed cards
    if (a.repetitions === 0 && b.repetitions !== 0) return -1;
    if (b.repetitions === 0 && a.repetitions !== 0) return 1;
    
    // Sort by due date for remaining
    return a.dueDate.getTime() - b.dueDate.getTime();
  });
}

/**
 * Get the rating label for display
 */
/**
 * The catalog key for a rating, not the label itself: this is a plain function
 * and cannot hold a translation hook, so the caller renders it.
 */
export function ratingLabelKey(rating: Rating): string {
  switch (rating) {
    case Rating.AGAIN:
      return 'spacedRepetition.rating.again';
    case Rating.HARD:
      return 'spacedRepetition.rating.hard';
    case Rating.GOOD:
      return 'spacedRepetition.rating.good';
    case Rating.EASY:
      return 'spacedRepetition.rating.easy';
    default:
      return 'spacedRepetition.rating.unknown';
  }
}

/**
 * Get estimated next review time based on rating
 */
export type NextReviewUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

/**
 * How far away the next review is, as a unit and a count rather than a
 * finished string. The English plural rules that used to live here ("1 hour" vs
 * "2 hours") are the catalog's job, and they are not the same rules in every
 * language.
 */
export function describeNextReview(
  currentState: FlashcardState,
  rating: Rating
): { unit: NextReviewUnit; count: number } {
  const result = processReview(currentState, rating);
  const minutes = result.intervalDays * 24 * 60;

  if (minutes < 60) {
    return { unit: 'minutes', count: Math.round(minutes) };
  } else if (minutes < 1440) {
    return { unit: 'hours', count: Math.round(minutes / 60) };
  } else if (minutes < 10080) {
    return { unit: 'days', count: Math.round(minutes / 1440) };
  } else if (minutes < 43200) {
    return { unit: 'weeks', count: Math.round(minutes / 10080) };
  }
  return { unit: 'months', count: Math.round(minutes / 43200) };
}

/**
 * Get the color class for a rating button
 */
export function getRatingColor(rating: Rating): string {
  switch (rating) {
    case Rating.AGAIN:
      return 'bg-red-500 hover:bg-red-600 text-white';
    case Rating.HARD:
      return 'bg-orange-500 hover:bg-orange-600 text-white';
    case Rating.GOOD:
      return 'bg-green-500 hover:bg-green-600 text-white';
    case Rating.EASY:
      return 'bg-blue-500 hover:bg-blue-600 text-white';
    default:
      return 'bg-gray-500 hover:bg-gray-600 text-white';
  }
}

/**
 * Per-course daily ceilings the review session enforces. Once a student has
 * reviewed this many due cards today, the session hands out no more of them —
 * so anything that counts due cards for display has to subtract what the day
 * has already spent, or it promises reviews the session will not deliver.
 */
export const DAILY_LIMITS = {
  MAX_NEW_CARDS_PER_DAY: 10,
  MAX_DUE_CARDS_PER_DAY: 15,
};

/**
 * The boundary the daily quota is measured from: UTC midnight of the viewer's
 * local calendar date. Anything that asks "how much of today's quota is spent"
 * must ask from here — a caller using local midnight instead disagrees with
 * this one by the viewer's UTC offset, and reviews inside that gap are counted
 * by one and not the other.
 */
export function getStartOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

/**
 * Session configuration
 */
export const SESSION_CONFIG = {
  MAX_NEW_CARDS_PER_SESSION: 10,
  MAX_CARDS_PER_SESSION: 20, // Default 20 cards per session
  TARGET_MINUTES: 10, // Target session length in minutes
  ESTIMATED_SECONDS_PER_CARD: 15, // Average time per card
};

/**
 * Calculate recommended session size
 */
export function getRecommendedSessionSize(
  dueCards: number,
  newCardsAvailable: number
): { dueCards: number; newCards: number; total: number } {
  const targetCards = Math.floor(
    (SESSION_CONFIG.TARGET_MINUTES * 60) / SESSION_CONFIG.ESTIMATED_SECONDS_PER_CARD
  );
  
  // Prioritize due cards
  const dueToReview = Math.min(dueCards, SESSION_CONFIG.MAX_CARDS_PER_SESSION);
  
  // Add new cards if we have capacity
  const remainingCapacity = Math.max(0, targetCards - dueToReview);
  const newToReview = Math.min(
    newCardsAvailable,
    remainingCapacity,
    SESSION_CONFIG.MAX_NEW_CARDS_PER_SESSION
  );
  
  return {
    dueCards: dueToReview,
    newCards: newToReview,
    total: dueToReview + newToReview,
  };
}
