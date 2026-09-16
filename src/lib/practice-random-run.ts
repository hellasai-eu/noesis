/**
 * #776 — "Practice 10 random" run picker.
 *
 * Given the student's currently filtered practice list, build a randomized
 * run of up to `max` questions. Prefer questions that aren't completed yet
 * (`not_started` ∪ `in_progress`); backfill from `completed` only when the
 * preferred pool falls short.
 *
 * The RNG is injectable so unit tests can use a deterministic source. The
 * default RNG is `Math.random`.
 */
import type {
  StudentPracticeQuestion,
  StudentPracticeStatus,
} from "@/hooks/useStudentPracticeQuestions";

export type RandomSource = () => number;

const DEFAULT_MAX = 10;

const PREFERRED_STATUSES: ReadonlySet<StudentPracticeStatus> = new Set([
  "not_started",
  "in_progress",
]);

/**
 * Fisher–Yates shuffle returning a new array (does not mutate input).
 * Accepts an injectable RNG for deterministic tests.
 */
export function shuffle<T>(items: readonly T[], rng: RandomSource = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Select up to `max` questions for a run from the supplied (already-filtered)
 * pool. Not-started / in-progress are preferred; completed questions backfill
 * to reach `max` when the preferred pool is too small. The final run size is
 * `min(max, questions.length)`.
 */
export function pickRandomRun(
  questions: readonly StudentPracticeQuestion[],
  max: number = DEFAULT_MAX,
  rng: RandomSource = Math.random,
): StudentPracticeQuestion[] {
  if (max <= 0 || questions.length === 0) return [];

  const preferred: StudentPracticeQuestion[] = [];
  const backfill: StudentPracticeQuestion[] = [];
  for (const q of questions) {
    if (PREFERRED_STATUSES.has(q.status)) preferred.push(q);
    else backfill.push(q);
  }

  const shuffledPreferred = shuffle(preferred, rng);
  const run = shuffledPreferred.slice(0, max);
  if (run.length >= max) return run;

  const remaining = max - run.length;
  const shuffledBackfill = shuffle(backfill, rng);
  run.push(...shuffledBackfill.slice(0, remaining));
  return run;
}
